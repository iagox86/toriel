import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { type Harness, type Msg, startDaemon } from "./helpers.ts";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const isSettled = (m: Msg) => m.type === "event" && m.event?.type === "agent_settled";

describe("daemon: lifecycle (3/3)", () => {
  it("forks a live session into a new one and leaves the original running", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await c.request({ type: "prompt", session: sessionId, message: "base" });
    await c.waitFor(isSettled);
    const file = c.sessions().find((s) => s.id === sessionId)?.sessionFile as string;
    const forked = await c.request({ type: "adopt", path: file, cwd: harness.dir, fork: true });
    assert.notEqual(forked.sessionId, sessionId);
    const all = c.sessions();
    assert.equal(all.find((s) => s.id === sessionId)?.active, true);
    assert.equal(all.find((s) => s.id === forked.sessionId)?.active, true);
  });

  it("gives a fork of a profiled session the same profile, and keeps it across a respawn", async () => {
    harness = await startDaemon({ TORIEL_AGENTS_DIR: path.join(os.tmpdir(), "toriel-no-user-agents") });
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir, agent: "explore" });
    await c.waitFor((m) => m.type === "history");
    await c.request({ type: "prompt", session: sessionId, message: "base" });
    await c.waitFor(isSettled);
    const file = c.sessions().find((s) => s.id === sessionId)?.sessionFile as string;
    const forked = await c.request({ type: "adopt", path: file, cwd: harness.dir, fork: true });
    const fork = (): Msg | undefined => c.sessions().find((s) => s.id === forked.sessionId);
    const argv = (): string[] => JSON.parse(fs.readFileSync(`${fork()?.sessionFile}.argv.json`, "utf8")) as string[];
    assert.equal(fork()?.agent, "explore");
    assert.deepEqual(argv().slice(argv().indexOf("--tools"), argv().indexOf("--tools") + 2), ["--tools", "read,grep,find,ls"]);
    await c.request({ type: "prompt", session: forked.sessionId, message: "hi" });
    await c.waitFor(isSettled);
    await c.request({ type: "deactivate", session: forked.sessionId });
    await c.request({ type: "prompt", session: forked.sessionId, message: "again" });
    await c.waitFor(isSettled);
    assert.equal(fork()?.agent, "explore", "the profile survives a respawn of the fork");
  });

  it("names a fork and tells it about its parent, leaving the parent alone", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await c.request({ type: "prompt", session: sessionId, message: "base" });
    await c.waitFor(isSettled);
    const parent = c.sessions().find((s) => s.id === sessionId);
    const file = parent?.sessionFile as string;
    const forked = await c.request({
      type: "adopt",
      path: file,
      cwd: harness.dir,
      fork: true,
      name: "FORK Parent",
      parentName: "Parent",
    });
    const fork = c.sessions().find((s) => s.id === forked.sessionId);
    assert.equal(fork?.sessionName, "FORK Parent");
    const notes = (f: string | undefined): string =>
      (JSON.parse(fs.readFileSync(`${f}.argv.json`, "utf8")) as string[]).join("\n");
    assert.match(notes(fork?.sessionFile), /fork of the session "Parent" \(session id [^,]+, file /);
    // a fork starts like any other session: toriel's extensions and tool loadout, or the inherited toriel_* tools are dropped
    const forkArgs = notes(fork?.sessionFile);
    assert.match(forkArgs, /--fork/);
    assert.match(forkArgs, /toriel-agents\.ts/);
    assert.match(forkArgs, /\+toriel_message/);
    // the parent is left alone: same child, no restart, no note about the fork
    const after = c.sessions().find((s) => s.id === sessionId);
    assert.equal(after?.sessionFile, file);
    assert.equal(after?.active, true);
    assert.doesNotMatch(notes(file), /has been forked|--append-system-prompt/);
  });

  it("uses the settings' model for a new session but lets a resumed one keep its own", async () => {
    const settings = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "toriel-settings-")), "settings.json");
    fs.writeFileSync(settings, '{"model":"default-model"}');
    harness = await startDaemon({ TORIEL_SETTINGS: settings });
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    const argv = (): string[] => {
      const f = c.sessions().find((s) => s.id === sessionId)?.sessionFile;
      return JSON.parse(fs.readFileSync(`${f}.argv.json`, "utf8")) as string[];
    };
    assert.ok(argv().includes("default-model"), "a new session starts on the default model");
    await c.request({ type: "prompt", session: sessionId, message: "hi" });
    await c.waitFor(isSettled);
    await c.request({ type: "reload", session: sessionId });
    assert.ok(!argv().includes("--model"), "a restart on an existing file does not reset its model");
    await c.request({ type: "model", session: sessionId, query: "other/fake-big" });
    await c.request({ type: "clear", session: sessionId });
    assert.ok(!argv().includes("--model"), "/clear does not pass the default model");
    const after = await c.request({ type: "model", session: sessionId });
    assert.equal(after.current, "other/fake-big", "/clear keeps the model the session was on");
  });

  it("starts a session as an agent profile and keeps its loadout across a respawn", async () => {
    harness = await startDaemon({ TORIEL_AGENTS_DIR: path.join(os.tmpdir(), "toriel-no-user-agents") });
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir, agent: "explore" });
    await c.waitFor((m) => m.type === "history");
    const file = (): string | undefined => c.sessions().find((x) => x.id === sessionId)?.sessionFile;
    const argv = (): string[] => JSON.parse(fs.readFileSync(`${file()}.argv.json`, "utf8")) as string[];
    assert.equal(c.sessions().find((x) => x.id === sessionId)?.agent, "explore");
    assert.deepEqual(argv().slice(argv().indexOf("--tools"), argv().indexOf("--tools") + 3), ["--tools", "read,grep,find,ls", "--no-mcp"]);
    assert.ok(argv().includes("--append-system-prompt"));

    await c.request({ type: "prompt", session: sessionId, message: "hi" });
    await c.waitFor(isSettled);
    await c.request({ type: "deactivate", session: sessionId });
    await c.request({ type: "prompt", session: sessionId, message: "again" });
    await c.waitFor(isSettled);
    assert.ok(argv().includes("--tools"), "the respawn kept the tool limits");
    assert.ok(!argv().includes("--thinking"), "but did not reset the model settings of an existing session");
    assert.equal(c.sessions().find((x) => x.id === sessionId)?.agent, "explore");
  });

  it("scopes every profile session to its launch dir: deny at a worktree root, ask in a plain dir; no profile and scope: none stay unscoped", async () => {
    harness = await startDaemon({ TORIEL_AGENTS_DIR: path.join(os.tmpdir(), "toriel-no-user-agents") });
    const dir = harness.dir;
    // the harness dir passes for the root of a linked worktree: a .git file pointing into a worktrees dir
    fs.writeFileSync(path.join(dir, ".git"), "gitdir: /r/.git/worktrees/w1\n");
    fs.mkdirSync(path.join(dir, ".toriel", "agents"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".toriel", "agents", "unscoped.md"), "---\nname: unscoped\ndescription: test profile that opts out of scoping\nscope: none\n---\nBe brief.\n");
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-plain-"));
    const c = await harness.connect();
    const childEnv = async (cwd: string, agent?: string) => {
      const { sessionId } = await c.request({ type: "spawn", cwd, ...(agent ? { agent } : {}) });
      await c.waitFor((m) => m.type === "history" && m.session === sessionId);
      const f = c.sessions().find((x) => x.id === sessionId)?.sessionFile as string;
      return JSON.parse(fs.readFileSync(`${f}.env.json`, "utf8"));
    };
    const unprofiled = await childEnv(dir);
    assert.equal(unprofiled.TORIEL_SCOPE_ROOT, null, "a session without a profile is never scoped");
    assert.equal(unprofiled.TORIEL_SCOPE_MODE, null);
    const atWorktree = await childEnv(dir, "explore");
    assert.equal(atWorktree.TORIEL_SCOPE_ROOT, fs.realpathSync(dir));
    assert.equal(atWorktree.TORIEL_SCOPE_MODE, "deny", "a linked-worktree launch dir gets deny mode");
    const atPlain = await childEnv(plain, "explore");
    assert.equal(atPlain.TORIEL_SCOPE_ROOT, fs.realpathSync(plain));
    assert.equal(atPlain.TORIEL_SCOPE_MODE, "ask", "a plain launch dir gets ask mode");
    const none = await childEnv(dir, "unscoped");
    assert.equal(none.TORIEL_SCOPE_ROOT, null, "scope: none keeps the variables out of the child");
    assert.equal(none.TORIEL_SCOPE_MODE, null);
  });

  it("turns the per-command sandbox on only for scoped children and only when the setting asks, and always makes the shared directory (board 190)", async () => {
    const settings = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "toriel-sandbox-settings-")), "settings.json");
    fs.writeFileSync(settings, '{"sandbox":"bwrap","sandboxWritable":["/cache/a","~/b"]}');
    harness = await startDaemon({ TORIEL_AGENTS_DIR: path.join(os.tmpdir(), "toriel-no-user-agents"), TORIEL_SETTINGS: settings });
    const dir = harness.dir;
    const shared = path.join(dir, "data", "toriel", "shared");
    assert.equal(fs.statSync(shared).isDirectory(), true, "the daemon creates the shared directory");
    assert.equal(fs.statSync(shared).mode & 0o777, 0o700);
    const c = await harness.connect();
    const childEnv = async (agent?: string) => {
      const { sessionId } = await c.request({ type: "spawn", cwd: dir, ...(agent ? { agent } : {}) });
      await c.waitFor((m) => m.type === "history" && m.session === sessionId);
      const f = c.sessions().find((x) => x.id === sessionId)?.sessionFile as string;
      return JSON.parse(fs.readFileSync(`${f}.env.json`, "utf8"));
    };
    const plain = await childEnv();
    assert.equal(plain.TORIEL_SHARED_DIR, shared, "every child learns the shared directory");
    assert.equal(plain.TORIEL_SANDBOX, null, "an unscoped session is never sandboxed");
    assert.equal(plain.TORIEL_SANDBOX_RW, null);
    const scoped = await childEnv("explore");
    assert.equal(scoped.TORIEL_SHARED_DIR, shared);
    assert.equal(scoped.TORIEL_SANDBOX, "bwrap");
    assert.equal(scoped.TORIEL_SANDBOX_RW, `/cache/a:${process.env.HOME ?? ""}/b`, "the setting's roots, ~/ expanded");
    assert.equal(scoped.TORIEL_SCOPE_ROOT, fs.realpathSync(dir), "the sandbox rides on the scope root");
  });

  it("leaves the sandbox off by default", async () => {
    harness = await startDaemon({ TORIEL_AGENTS_DIR: path.join(os.tmpdir(), "toriel-no-user-agents") });
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir, agent: "explore" });
    await c.waitFor((m) => m.type === "history" && m.session === sessionId);
    const f = c.sessions().find((x) => x.id === sessionId)?.sessionFile as string;
    const env = JSON.parse(fs.readFileSync(`${f}.env.json`, "utf8"));
    assert.equal(env.TORIEL_SANDBOX, null);
    assert.equal(env.TORIEL_SCOPE_MODE, "ask", "scoped as before");
  });

  it("adds toriel's tools to the loadout on every start and resume, unless a profile owns the tool list", async () => {
    harness = await startDaemon({ TORIEL_AGENTS_DIR: path.join(os.tmpdir(), "toriel-no-user-agents") });
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    const argv = (): string[] => {
      const f = c.sessions().find((x) => x.id === sessionId)?.sessionFile;
      return JSON.parse(fs.readFileSync(`${f}.argv.json`, "utf8")) as string[];
    };
    const tools = (): string | undefined => argv()[argv().indexOf("--tools") + 1];
    assert.equal(tools(), "+toriel_message,+toriel_schedule_create,+toriel_schedule_list,+toriel_schedule_cancel,+toriel_agent,+toriel_agents,+toriel_usage,+toriel_job");
    await c.request({ type: "prompt", session: sessionId, message: "hi" });
    await c.waitFor(isSettled);
    await c.request({ type: "reload", session: sessionId });
    assert.equal(tools(), "+toriel_message,+toriel_schedule_create,+toriel_schedule_list,+toriel_schedule_cancel,+toriel_agent,+toriel_agents,+toriel_usage,+toriel_job", "a /reload resume passes them again");

    const explore = await c.request({ type: "spawn", cwd: harness.dir, agent: "explore" });
    await c.waitFor((m) => m.type === "history" && m.session === explore.sessionId);
    const f = c.sessions().find((x) => x.id === explore.sessionId)?.sessionFile;
    const eargv = JSON.parse(fs.readFileSync(`${f}.argv.json`, "utf8")) as string[];
    assert.equal(eargv.filter((a) => a === "--tools").length, 1, "a profile's own --tools is not mixed with modifiers");
  });

  it("loads toriel's own extensions and skill into every child by flag, keeping the extensions for a profile with discovery off and dropping the skill for a minimal one", async () => {
    harness = await startDaemon({ TORIEL_AGENTS_DIR: path.join(os.tmpdir(), "toriel-no-user-agents") });
    const c = await harness.connect();
    const argvOf = (id: number): string[] => {
      const f = c.sessions().find((x) => x.id === id)?.sessionFile;
      return JSON.parse(fs.readFileSync(`${f}.argv.json`, "utf8")) as string[];
    };
    const flagged = (argv: string[], flag: string): string[] => argv.flatMap((a, i) => (a === flag ? [argv[i + 1] as string] : []));
    const plain = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    const argv = argvOf(plain.sessionId as number);
    assert.deepEqual(flagged(argv, "-e").map((f) => path.basename(f)).sort(), [
      "toriel-agents.ts",
      "toriel-cache-warn.ts",
      "toriel-grants.ts",
      "toriel-jobs.ts",
      "toriel-session-bridge.ts",
      "toriel-usage.ts",
    ]);
    assert.ok(flagged(argv, "-e").every((f) => path.isAbsolute(f) && fs.existsSync(f)));
    assert.deepEqual(flagged(argv, "--skill").map((f) => path.basename(f)), ["messaging", "scheduling", "delegating", "toriel"]);

    // explore is a profile with extension discovery off and no skills (minimal)
    const explore = await c.request({ type: "spawn", cwd: harness.dir, agent: "explore" });
    await c.waitFor((m) => m.type === "history" && m.session === explore.sessionId);
    const eargv = argvOf(explore.sessionId as number);
    assert.ok(eargv.includes("--no-extensions"));
    assert.equal(flagged(eargv, "-e").length, 6, "explicit -e still loads under --no-extensions");
    assert.deepEqual(flagged(eargv, "--skill"), []);
  });

  it("tells every child which socket its daemon listens on, so the extensions need no path rule of their own", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    const f = c.sessions().find((x) => x.id === sessionId)?.sessionFile;
    const env = JSON.parse(fs.readFileSync(`${f}.env.json`, "utf8")) as { TORIEL_SOCK: string };
    assert.equal(env.TORIEL_SOCK, harness.sock);
  });

  it("reports how many messages pi holds when a run settles, and replays history on a resync request", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await c.request({ type: "prompt", session: sessionId, message: "hi" });
    await c.waitFor(isSettled);
    const digest = await c.waitFor((m) => m.type === "digest" && m.session === sessionId);
    assert.equal(digest.streaming, false);
    assert.ok((digest.messages as number) >= 2, "the prompt and the reply");
    const history = c.waitFor((m) => m.type === "history" && m.session === sessionId && (m.messages as unknown[]).length === digest.messages);
    await c.request({ type: "resync", session: sessionId });
    await history;
  });

  it("refuses to start an unknown agent and names the ones it has", async () => {
    harness = await startDaemon({ TORIEL_AGENTS_DIR: path.join(os.tmpdir(), "toriel-no-user-agents") });
    const c = await harness.connect();
    await assert.rejects(c.request({ type: "spawn", cwd: harness.dir, agent: "nope" }), /no agent called "nope" \(have: [a-z, -]*explore[a-z, -]*summarize/);
  });

  it("gives a new session an id before pi starts and tells the child", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const r = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    assert.match(r.uuid, /^[0-9a-f]{8}-/);
    const file = c.sessions().find((x) => x.id === r.sessionId)?.sessionFile as string;
    const argv = JSON.parse(fs.readFileSync(`${file}.argv.json`, "utf8")) as string[];
    assert.equal(argv[argv.indexOf("--session-id") + 1], r.uuid);
    assert.equal(JSON.parse(fs.readFileSync(`${file}.env.json`, "utf8")).TORIEL_SESSION_ID, r.uuid);
    assert.equal(c.sessions().find((x) => x.id === r.sessionId)?.sessionId, r.uuid);
    // a respawn of the same file is the same session, so the child is told the same id
    await c.request({ type: "prompt", session: r.sessionId, message: "hi" });
    await c.waitFor(isSettled);
    await c.request({ type: "deactivate", session: r.sessionId });
    await c.request({ type: "prompt", session: r.sessionId, message: "again" });
    await c.waitFor(isSettled);
    assert.equal(JSON.parse(fs.readFileSync(`${file}.env.json`, "utf8")).TORIEL_SESSION_ID, r.uuid);
  });

  it("resolves a session from its UUID, prefix, #number or name, and says when it cannot", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const one = await c.request({ type: "spawn", cwd: harness.dir, name: "Resolver One" });
    const two = await c.request({ type: "spawn", cwd: harness.dir, name: "Resolver Two" });
    await c.waitFor((m) => m.type === "history");
    await c.waitFor(() => c.sessions().filter((x) => x.sessionName).length === 2);
    const by = async (query: string) => c.request({ type: "resolve", query });
    assert.equal((await by(one.uuid)).id, one.sessionId);
    assert.equal((await by(two.uuid.slice(0, 10))).id, two.sessionId);
    assert.equal((await by(`#${two.sessionId}`)).uuid, two.uuid);
    assert.equal((await by("resolver one")).uuid, one.uuid);
    await assert.rejects(by("no such session"), /no session matches/);
  });

  it("delivers a message to another session, labelled with the sender, and wakes an idle one without taking its attach", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const a = await c.request({ type: "spawn", cwd: harness.dir, name: "Sender" });
    const b = await c.request({ type: "spawn", cwd: harness.dir, name: "Receiver" });
    await c.waitFor(() => c.sessions().filter((x) => x.sessionName).length === 2);
    await c.request({ type: "prompt", session: b.sessionId, message: "first" });
    await c.waitFor(isSettled);
    await c.request({ type: "deactivate", session: b.sessionId });
    const file = c.sessions().find((x) => x.id === b.sessionId)?.sessionFile as string;

    const sender = await harness.connect();
    const r = await sender.request({ type: "message", to: "receiver", text: "please check X", from: a.uuid });
    assert.equal(r.delivered, true);
    assert.equal(r.to, "Receiver");
    // wait for the turn the message started (isSettled alone could match the earlier one)
    await c.waitFor((m) => m.type === "event" && m.event?.type === "message_start" && JSON.stringify(m.event).includes("please check X"));
    await c.waitFor((m) => isSettled(m) && c.messages.indexOf(m) > c.messages.findIndex((x) => JSON.stringify(x).includes("please check X")));
    const meta = c.sessions().find((x) => x.id === b.sessionId);
    assert.equal(meta?.active, true, "the idle session was started");
    assert.equal(meta?.attachedToYou, false, "delivering does not take the input attach");
    assert.equal(meta?.attachedElsewhere, false);
    assert.match(fs.readFileSync(file, "utf8"), new RegExp(`\\[from Sender \\(${a.uuid}\\)\\]: please check X`));
  });

  it("says why a message cannot be delivered", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const a = await c.request({ type: "spawn", cwd: harness.dir, name: "Solo" });
    await c.waitFor((m) => m.type === "history");
    await c.waitFor(() => c.sessions().some((x) => x.sessionName === "Solo"));
    await assert.rejects(c.request({ type: "message", to: "nobody", text: "hi" }), /no session matches/);
    await assert.rejects(c.request({ type: "message", to: "Solo", text: "  " }), /empty/);
    await assert.rejects(c.request({ type: "message", to: "Solo", text: "hi", from: a.uuid }), /cannot message itself/);
  });

  it("queues a message behind the work a busy session is doing", async () => {
    harness = await startDaemon({ FAKE_PI_SLOW: "1", FAKE_PI_STEP_MS: "150" });
    const c = await harness.connect();
    const busy = await c.request({ type: "spawn", cwd: harness.dir, name: "Busy" });
    await c.waitFor(() => c.sessions().some((x) => x.sessionName === "Busy"));
    await c.request({ type: "prompt", session: busy.sessionId, message: "work" });
    await c.waitFor(() => c.sessions().find((x) => x.id === busy.sessionId)?.streaming === true);
    const r = await c.request({ type: "message", to: "Busy", text: "psst" });
    assert.match(r.disposition, /queued/);
  });

  it("records the settings file's mtime per child and re-reads it on respawn", async () => {
    const settings = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "toriel-settings-")), "settings.json");
    fs.writeFileSync(settings, '{"model":"a"}');
    fs.utimesSync(settings, new Date(1_000_000), new Date(1_000_000));
    harness = await startDaemon({ TORIEL_SETTINGS: settings });
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    const mtimeOf = () => c.sessions().find((s) => s.id === sessionId)?.settingsMtime;
    assert.equal(mtimeOf(), 1_000_000);

    fs.utimesSync(settings, new Date(2_000_000), new Date(2_000_000));
    assert.equal(mtimeOf(), 1_000_000, "a running child keeps the values it started with");
    await c.request({ type: "deactivate", session: sessionId });
    await c.request({ type: "prompt", session: sessionId, message: "wake up" });
    await c.waitFor(isSettled);
    assert.equal(mtimeOf(), 2_000_000, "the respawned child read the edited file");
    fs.rmSync(path.dirname(settings), { recursive: true, force: true });
  });

  it("refuses to rewind a session that is mid-run", async () => {
    harness = await startDaemon({ FAKE_PI_RUN_MS: "1500" });
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await c.request({ type: "prompt", session: sessionId, message: "slow" });
    await assert.rejects(c.request({ type: "rewind", session: sessionId, entryId: "x" }), /working/);
  });

  it("drops a never-prompted session on delete without touching the disk", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await c.request({ type: "delete", session: sessionId });
    assert.equal(c.sessions().some((s) => s.id === sessionId), false);
    assert.equal(fs.existsSync(path.join(harness.dir, "trash")), false);
  });
});
