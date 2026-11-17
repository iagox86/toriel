import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { runFeedback } from "../src/feedback-command.ts";
import { type BundleSources, redactText, windowJsonl, windowLog, writeBundle } from "../src/feedback-bundle.ts";
import { readFeedback } from "../src/feedback.ts";
import { type Client, type Harness, startDaemon } from "./helpers.ts";

const made: string[] = [];
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "feedback-bundle-"));
  made.push(d);
  return d;
};
afterEach(() => {
  for (const d of made.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("redactText", () => {
  it("masks the value of a key that names a secret and keeps everything else", () => {
    const out = redactText(["provider: litellm", "apiKey: sk-abc123", 'token: "abc"', "authorization: Bearer abcdefghijkl", "name: ok", "tokenBudget:"].join("\n"));
    assert.equal(out, ["provider: litellm", "apiKey: <redacted>", "token: <redacted>", "authorization: <redacted>", "name: ok", "tokenBudget:"].join("\n"));
  });

  it("masks every value inside a headers or env block, whatever the names, and stops at the dedent", () => {
    const out = redactText(["servers:", "  git:", "    url: http://x", "    headers:", "      X-Thing: value", "      Other: v2", "    env:", "      FOO: bar", "    exposure: direct"].join("\n"));
    assert.equal(out, ["servers:", "  git:", "    url: http://x", "    headers:", "      X-Thing: <redacted>", "      Other: <redacted>", "    env:", "      FOO: <redacted>", "    exposure: direct"].join("\n"));
  });

  it("masks a bearer token and a --token argument wherever they appear, and a JSON key", () => {
    assert.equal(redactText("curl -H 'Authorization: Bearer abcdefgh12345'"), "curl -H 'Authorization: Bearer <redacted>'");
    assert.equal(redactText("args: [run, --token, abc]"), "args: [run, --token, abc]", "a separate argument is not caught: the key is");
    assert.equal(redactText("command: foo --api-key=abc123"), "command: foo --api-key=<redacted>");
    assert.match(redactText('  "apiKey": "sk-1234",'), /"apiKey": <redacted>/);
  });
});

describe("windows", () => {
  it("keeps the daemon log lines between two times, with a line that has no time staying with the one above", () => {
    const log = ["2026-11-16T10:00:00.000Z early", "2026-11-16T10:30:00.000Z inside", "  continued", "2026-11-16T11:30:00.000Z late"].join("\n");
    assert.equal(windowLog(log, "2026-11-16T10:15:00.000Z", "2026-11-16T11:00:00.000Z"), "2026-11-16T10:30:00.000Z inside\n  continued");
  });

  it("keeps the JSON lines whose time is in range and skips torn ones", () => {
    const text = [{ timestamp: "2026-11-16T10:00:00.000Z", n: 1 }, { timestamp: "2026-11-16T10:40:00.000Z", n: 2 }].map((x) => JSON.stringify(x)).join("\n").concat("\n{torn");
    assert.deepEqual(windowJsonl(text, "timestamp", "2026-11-16T10:30:00.000Z", "2026-11-16T11:00:00.000Z").split("\n").map((l) => JSON.parse(l).n), [2]);
  });
});

/** Everything a bundle gathers, on temporary paths. */
function world() {
  const d = tmp();
  const agentDir = path.join(d, "agent");
  const logs = path.join(agentDir, "extensions", "pi-permission-system", "logs");
  fs.mkdirSync(logs, { recursive: true });
  const at = "2026-11-16T22:00:00.000Z";
  fs.writeFileSync(path.join(logs, "pi-permission-system-permission-review.jsonl"), `${JSON.stringify({ timestamp: "2026-11-16T21:50:00.000Z", event: "permission_request.waiting" })}\n${JSON.stringify({ timestamp: "2026-11-15T01:00:00.000Z", event: "old" })}\n`);
  fs.writeFileSync(path.join(agentDir, "extensions", "pi-permission-system", "config.json"), '{"permission":{"bash":{"sudo *":"ask"}}}');
  const daemonLog = path.join(d, "daemon.log");
  fs.writeFileSync(daemonLog, "2026-11-16T21:45:00.000Z auto mode on for session 1\n2026-11-15T01:00:00.000Z long ago\n");
  const decisionsFile = path.join(d, "decisions.jsonl");
  fs.writeFileSync(decisionsFile, `${JSON.stringify({ at: "2026-11-16T21:55:00.000Z", by: "auto" })}\n`);
  const settings = path.join(d, "settings.yaml");
  fs.writeFileSync(settings, "sandbox: bwrap\napiKey: topsecret\n");
  const sessionFile = path.join(d, "session.jsonl");
  fs.writeFileSync(sessionFile, '{"type":"session","id":"u"}\n{"type":"message","id":"a"}\n');
  const src: BundleSources = { noteFile: path.join(d, "notes.jsonl"), feedbackDir: path.join(d, "feedback"), daemonLog, decisionsFile, agentDir, configFiles: [settings, path.join(d, "no-such-mcp.yaml")], doctor: () => "doctor says hi" };
  return { d, at, src, sessionFile };
}

describe("writeBundle", () => {
  it("gathers the note, snapshot, session copy, logs in the window, rules, redacted config and the doctor report", async () => {
    const w = world();
    const r = await writeBundle({ id: "0123456789abcdef", at: w.at, record: { at: w.at, source: "user", text: "too many prompts" }, snapshot: { auto: { on: true } }, sessionFile: w.sessionFile }, w.src);
    const read = (n: string) => fs.readFileSync(path.join(r.dir, n), "utf8");
    assert.match(path.basename(r.dir), /^2026-11-16T22-00-00-000Z-01234567$/);
    assert.equal(JSON.parse(read("record.json")).text, "too many prompts");
    assert.deepEqual(JSON.parse(read("snapshot.json")), { auto: { on: true } });
    assert.equal(read("session.jsonl"), fs.readFileSync(w.sessionFile, "utf8"), "the session is copied whole");
    assert.equal(read("daemon-log.txt"), "2026-11-16T21:45:00.000Z auto mode on for session 1");
    assert.equal(JSON.parse(read("permission-review.jsonl")).event, "permission_request.waiting", "only the window");
    assert.equal(JSON.parse(read("permission-decisions.jsonl")).by, "auto");
    assert.match(read("permission-config.json"), /sudo \*/);
    assert.equal(read("settings.yaml"), "sandbox: bwrap\napiKey: <redacted>\n");
    assert.equal(read("doctor.txt").trim(), "doctor says hi");
    for (const name of ["record.json", "session.jsonl", "daemon-log.txt", "permission-review.jsonl", "settings.yaml", "doctor.txt"]) {
      assert.match(r.manifest, new RegExp(`${name.replace(".", "\\.")}  \\d+ bytes`));
    }
    assert.match(r.manifest, /stays on this machine/);
    assert.doesNotMatch(r.manifest, /no-such-mcp/, "a config file that is not there is simply left out");
  });

  it("is readable by its owner only, since a session holds everything the model saw", async () => {
    const w = world();
    const r = await writeBundle({ id: "abcdef0123", at: w.at, record: { at: w.at, source: "user", text: "x" }, snapshot: {}, sessionFile: w.sessionFile }, w.src);
    assert.equal(fs.statSync(r.dir).mode & 0o777, 0o700);
    for (const f of fs.readdirSync(r.dir)) {
      assert.equal(fs.statSync(path.join(r.dir, f)).mode & 0o777, 0o600, f);
    }
  });

  it("keeps what it can when a part is missing, and says which", async () => {
    const w = world();
    fs.rmSync(w.src.daemonLog);
    fs.rmSync(w.sessionFile);
    const r = await writeBundle({ id: "feedfeedfeed", at: w.at, record: { at: w.at, source: "user", text: "x" }, snapshot: {}, sessionFile: w.sessionFile }, { ...w.src, doctor: () => { throw new Error("doctor broke"); } });
    assert.match(r.manifest, /daemon-log\.txt {2}not there/);
    assert.match(r.manifest, /session\.jsonl {2}no session file/);
    assert.match(r.manifest, /doctor\.txt {2}NOT GATHERED: doctor broke/);
    assert.ok(fs.existsSync(path.join(r.dir, "record.json")) && fs.existsSync(path.join(r.dir, "permission-review.jsonl")));
  });

  it("copies the project's permission config too, when the session's directory has one", async () => {
    const w = world();
    const project = path.join(w.d, "project", ".pi", "extensions", "pi-permission-system");
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, "config.json"), '{"permission":{"bash":"allow"}}');
    const r = await writeBundle({ id: "1111111111", at: w.at, record: { at: w.at, source: "user", text: "x" }, snapshot: {}, cwd: path.join(w.d, "project") }, w.src);
    assert.match(fs.readFileSync(path.join(r.dir, "project-permission-config.json"), "utf8"), /"bash":"allow"/);
  });
});

/** The slice of the controller's Host that /feedback uses. */
function fakeHost(over: { request?: () => Promise<unknown>; meta?: Record<string, unknown> } = {}) {
  const notes: string[] = [];
  const h = {
    notify: (t: string) => void notes.push(t),
    infoPanel: { show: () => {} },
    metaForPath: () => over.meta,
    request: over.request ?? (async () => ({ source: "daemon", session: { auto: { on: true } } })),
    daemonReport: () => "daemon: test",
  };
  return { h: h as never, notes };
}

describe("/feedback", () => {
  it("writes a bundle with the daemon's snapshot and records where it is", async () => {
    const w = world();
    const { h, notes } = fakeHost({ meta: { id: 7, sessionFile: w.sessionFile, cwd: w.d, model: "m", sessionName: "n" } });
    await runFeedback(h, { args: ["prompts", "again"], opts: {} }, w.sessionFile, w.src);
    assert.match(notes[0] ?? "", /^feedback recorded; bundle: /);
    const dirs = fs.readdirSync(w.src.feedbackDir);
    assert.equal(dirs.length, 1);
    const snapshot = JSON.parse(fs.readFileSync(path.join(w.src.feedbackDir, dirs[0] as string, "snapshot.json"), "utf8"));
    assert.deepEqual(snapshot.session, { auto: { on: true } });
    assert.equal(typeof snapshot.controller.node, "string");
    assert.equal(fs.readFileSync(path.join(w.src.feedbackDir, dirs[0] as string, "session.jsonl"), "utf8"), fs.readFileSync(w.sessionFile, "utf8"));
  });

  it("still bundles when the daemon cannot give a snapshot (an older one), and says why in the snapshot", async () => {
    const w = world();
    const { h, notes } = fakeHost({ meta: { id: 7, sessionFile: w.sessionFile, cwd: w.d, auto: true }, request: async () => { throw new Error("unknown command"); } });
    await runFeedback(h, { args: ["x"], opts: {} }, w.sessionFile, w.src);
    assert.match(notes[0] ?? "", /^feedback recorded; bundle: /);
    const dir = path.join(w.src.feedbackDir, fs.readdirSync(w.src.feedbackDir)[0] as string);
    const snapshot = JSON.parse(fs.readFileSync(path.join(dir, "snapshot.json"), "utf8"));
    assert.equal(snapshot.source, "controller");
    assert.match(snapshot.note, /no snapshot from the daemon \(unknown command\)/);
    assert.equal(snapshot.session.auto, true, "the controller's own view of the session");
  });

  it("keeps the note even when the bundle cannot be written", async () => {
    const w = world();
    const blocker = path.join(w.d, "blocker");
    fs.writeFileSync(blocker, "a file where the folder should go");
    const { h, notes } = fakeHost({ meta: { id: 7, sessionFile: w.sessionFile } });
    await runFeedback(h, { args: ["x"], opts: {} }, w.sessionFile, { ...w.src, feedbackDir: path.join(blocker, "inside") });
    assert.match(notes[0] ?? "", /feedback recorded, but the bundle failed/);
    assert.equal(readFeedback(w.src.noteFile)[0]?.text, "x", "the note itself is kept");
    assert.equal(readFeedback(w.src.noteFile)[0]?.bundle, undefined);
  });

  it("lists a note with its bundle", async () => {
    const w = world();
    const { h } = fakeHost({ meta: { id: 7, sessionFile: w.sessionFile } });
    await runFeedback(h, { args: ["listed"], opts: {} }, w.sessionFile, w.src);
    const [rec] = readFeedback(w.src.noteFile);
    assert.ok(rec?.bundle?.startsWith(w.src.feedbackDir));
    const shown: string[] = [];
    await runFeedback({ ...(h as object), infoPanel: { show: (t: string) => shown.push(t) } } as never, { args: [], opts: { list: true } }, undefined, w.src);
    assert.match(shown[0] ?? "", /listed\n {2}bundle: /);
  });
});

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.stop();
  }
});

describe("daemon: feedback_snapshot (ticket 239)", () => {
  async function session(env: Record<string, string> = {}): Promise<{ h: Harness; c: Client; session: number }> {
    const h = await startDaemon(env);
    harnesses.push(h);
    const c = await h.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: h.dir });
    await c.waitFor((m) => m.type === "history" && m.session === sessionId);
    return { h, c, session: sessionId };
  }

  it("reports the daemon and the session's modes, scope, sandbox and deny-after", async () => {
    const { c, session: id } = await session({ TORIEL_DENY_MIN_MS: "500" });
    await c.request({ type: "auto_mode", session: id, on: true });
    await c.request({ type: "deny_after", session: id, after: "1 second" });
    const snap = await c.request({ type: "feedback_snapshot", session: id });
    assert.equal(snap.source, "daemon");
    assert.equal(typeof snap.daemon.pid, "number");
    assert.equal(typeof snap.daemon.protocol, "number");
    assert.equal(snap.session.id, id);
    assert.deepEqual([snap.session.auto.on, snap.session.plan, snap.session.denyAfterMs, snap.session.agent], [true, false, 1000, null]);
    assert.equal(snap.session.scope, null, "a plain session has no scope");
    assert.equal(snap.session.sandboxed, false);
    assert.ok(Array.isArray(snap.packages) && snap.packages.some((p: { name: string }) => p.name === "pi"));
    assert.equal(typeof snap.settings, "object");
  });

  it("shows a prompt that is waiting for an answer, and the grants of the session", async () => {
    const { c, session: id } = await session({ FAKE_PI_ASK_COMMAND: "npm test" });
    await c.request({ type: "prompt", session: id, message: "/ask-select" });
    await c.waitFor((m) => m.type === "ui_request" && m.request?.id === "ask-select-1");
    const snap = await c.request({ type: "feedback_snapshot", session: id });
    assert.equal(snap.session.prompt.title.length > 0, true);
    assert.equal(typeof snap.session.prompt.waitingMs, "number");
    assert.deepEqual(snap.session.grants, []);
  });

  it("answers without a session (the daemon's own state) and refuses an unknown one", async () => {
    const { c } = await session();
    const snap = await c.request({ type: "feedback_snapshot" });
    assert.equal(snap.session, undefined);
    assert.equal(snap.daemon.sessions, 1);
    await assert.rejects(c.request({ type: "feedback_snapshot", session: 999 }), /no session #999/);
  });
});
