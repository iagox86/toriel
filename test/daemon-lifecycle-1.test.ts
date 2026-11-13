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

describe("daemon: lifecycle (1/3)", () => {
  it("keeps the session file when deactivated and replays it on the next prompt", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await c.request({ type: "prompt", session: sessionId, message: "first" });
    await c.waitFor(isSettled);
    const file = c.sessions().find((s) => s.id === sessionId)?.sessionFile;
    assert.ok(file && fs.existsSync(file));

    await c.request({ type: "deactivate", session: sessionId });
    assert.equal(c.sessions().find((s) => s.id === sessionId)?.active, false);
    assert.ok(fs.existsSync(file));

    const before = c.messages.length;
    await c.request({ type: "prompt", session: sessionId, message: "second" });
    const history = await c.waitFor((m) => m.type === "history" && m.messages.length >= 2);
    assert.equal(history.messages[0].content, "first");
    assert.ok(c.messages.length > before);
  });

  it("moves a deleted session file to the trash with a manifest instead of unlinking it", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await c.request({ type: "prompt", session: sessionId, message: "keep me" });
    await c.waitFor(isSettled);
    const file = c.sessions().find((s) => s.id === sessionId)?.sessionFile as string;

    const { trashedTo } = await c.request({ type: "delete", session: sessionId });
    assert.equal(fs.existsSync(file), false);
    assert.ok(fs.readFileSync(trashedTo, "utf8").includes("keep me"));
    const manifest = JSON.parse(fs.readFileSync(`${trashedTo}.json`, "utf8"));
    assert.equal(manifest.originalPath, file);
    assert.equal(c.sessions().some((s) => s.id === sessionId), false);
  });

  it("rewinds to before a user message, trashes the tail, and lets the session carry on", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await c.request({ type: "prompt", session: sessionId, message: "one" });
    await c.waitFor(isSettled);
    await c.request({ type: "prompt", session: sessionId, message: "two" });
    await c.waitFor((m) => isSettled(m) && c.messages.filter(isSettled).length >= 2);
    const file = c.sessions().find((s) => s.id === sessionId)?.sessionFile as string;
    const entries = () => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const second = entries().find((e) => e.message?.content === "two");

    const r = await c.request({ type: "rewind", session: sessionId, entryId: second.id });
    assert.equal(r.text, "two");
    assert.equal(r.removed, 2);
    assert.equal(entries().some((e) => JSON.stringify(e).includes("two")), false);
    assert.ok(fs.readFileSync(r.trashedTo, "utf8").includes("two"));
    assert.equal(c.sessions().find((s) => s.id === sessionId)?.active, false, "the child is stopped");

    await c.request({ type: "prompt", session: sessionId, message: "three" });
    await c.waitFor((m) => isSettled(m) && c.messages.filter(isSettled).length >= 3);
    assert.ok(entries().some((e) => e.message?.content === "three"));
  });

  it("hands queued messages back on clear_queue so an abort does not deliver them", async () => {
    harness = await startDaemon({ FAKE_PI_SLOW: "1", FAKE_PI_STEP_MS: "150" });
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await c.request({ type: "prompt", session: sessionId, message: "running" });
    await c.request({ type: "prompt", session: sessionId, message: "queued message" });
    await c.waitFor((m) => m.type === "event" && m.event?.type === "queue_update" && m.event.steering.length === 1);

    const q = await c.request({ type: "clear_queue", session: sessionId });
    assert.deepEqual(q.steering, ["queued message"]);
    await c.request({ type: "abort", session: sessionId });
    await c.waitFor(isSettled);
    const file = c.sessions().find((s) => s.id === sessionId)?.sessionFile as string;
    assert.equal(fs.readFileSync(file, "utf8").includes("queued message"), false);
  });

  it("re-syncs a stale queue strip once pi reports nothing pending (#47)", async () => {
    // queue_update is fire-and-forget, so a lost removal event would leave a
    // controller showing "queued" lines forever. With the drop flag fake-pi
    // delivers the message but withholds the empty-queue update; the daemon must
    // reconcile against pi at settle and announce the cleared queue itself.
    harness = await startDaemon({ FAKE_PI_SLOW: "1", FAKE_PI_STEP_MS: "150", FAKE_PI_DROP_QUEUE_REMOVAL: "1" });
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await c.request({ type: "prompt", session: sessionId, message: "running" });
    await c.request({ type: "prompt", session: sessionId, message: "queued message" });
    await c.waitFor((m) => m.type === "event" && m.event?.type === "queue_update" && m.event.steering.length === 1);
    await c.waitFor(isSettled);

    // the reconcile runs just behind agent_settled (async refreshMeta); earlier empty
    // updates from spawn-time refreshMeta don't count
    await c.waitFor(() => {
      const settled = c.messages.findIndex(isSettled);
      return c.messages.some(
        (m, i) =>
          i > settled &&
          m.type === "event" &&
          m.event?.type === "queue_update" &&
          m.session === sessionId &&
          m.event.steering.length === 0,
      );
    }, 5000);
  });

  it("delivers messages from other sessions through the session bridge, as custom entries with a self-clearing strip", async () => {
    // A child that offers /toriel-inject gets the message as that command, never through pi's
    // steering queue. Mid-run it lands as an appended custom entry at the turn boundary, and
    // the strip shows it pending until the daemon sees that append.
    harness = await startDaemon({ FAKE_PI_SLOW: "1", FAKE_PI_STEP_MS: "150", FAKE_PI_BRIDGE: "1" });
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await c.request({ type: "prompt", session: sessionId, message: "running" });
    const r = await c.request({ type: "message", to: `#${sessionId}`, text: "bridged hello" });
    assert.equal((r as { via?: string }).via, "bridge");

    const pendingAt = c.messages.findIndex(
      (m) => m.type === "event" && m.event?.type === "queue_update" && m.session === sessionId && m.event.steering.length === 1,
    );
    assert.ok(pendingAt !== -1, "the strip never showed the message pending");
    await c.waitFor(() =>
      c.messages.some(
        (m, i) => i > pendingAt && m.type === "event" && m.event?.type === "queue_update" && m.session === sessionId && m.event.steering.length === 0,
      ),
    );
    assert.ok(c.messages.some((m) => m.type === "event" && m.event?.type === "entry_appended"), "controllers must see the appended entry to draw it");

    await c.waitFor(isSettled);
    const file = c.sessions().find((s) => s.id === sessionId)?.sessionFile as string;
    const entries = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l)
      .map((l) => JSON.parse(l) as { type?: string; customType?: string; content?: unknown; message?: { role?: string; content?: unknown } });
    const injected = entries.find((e) => e.type === "custom_message" && e.customType === "toriel-inject");
    assert.ok(injected, "no custom_message entry for the bridged message");
    assert.ok(JSON.stringify(injected.content).includes("bridged hello"));
    const asUserPrompt = entries.some((e) => e.type === "message" && e.message?.role === "user" && JSON.stringify(e.message.content).includes("bridged hello"));
    assert.equal(asUserPrompt, false);
  });

  it("says so when a session stops before a bridged message reached its transcript", async () => {
    harness = await startDaemon({ FAKE_PI_SLOW: "1", FAKE_PI_STEP_MS: "300", FAKE_PI_BRIDGE: "1" });
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await c.request({ type: "prompt", session: sessionId, message: "running" });
    await c.request({ type: "message", to: `#${sessionId}`, text: "will be lost" });
    await c.request({ type: "deactivate", session: sessionId });
    const gone = await c.waitFor((m) => m.type === "exited" && m.session === sessionId);
    assert.match(String(gone.reason), /1 message from other sessions did not arrive.*will be lost/);
  });

  it("starts an idle session's turn with a bridged message, and confirms it", async () => {
    harness = await startDaemon({ FAKE_PI_BRIDGE: "1" });
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    const r = await c.request({ type: "message", to: `#${sessionId}`, text: "wake up via bridge" });
    assert.equal((r as { via?: string }).via, "bridge");
    await c.waitFor((m) => m.type === "event" && m.session === sessionId && m.event?.type === "message_end" && m.event.message?.customType === "toriel-inject");
    await c.waitFor(isSettled);
    const meta = c.sessions().find((s) => s.id === sessionId);
    assert.equal(meta?.sessionBridge, true);
  });

  it("asks the child's jobs extension to move a running command to the background, and passes its notice on", async () => {
    harness = await startDaemon({ FAKE_PI_JOBS: "1" });
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await c.request({ type: "background", session: sessionId });
    const note = await c.waitFor((m) => m.type === "ui_request" && m.request?.method === "notify");
    assert.match(String(note.request.message), /Moved to the background: j1/);
  });

  it("refuses to move a command when the child has no jobs extension, instead of sending the model slash text", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await assert.rejects(c.request({ type: "background", session: sessionId }), /background-jobs extension/);
  });

  it("falls back to steering, with the session marked as lacking the bridge, when the child does not offer it", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    const r = await c.request({ type: "message", to: `#${sessionId}`, text: "plain hello" });
    assert.equal((r as { via?: string }).via, "legacy");
    assert.equal(c.sessions().find((s) => s.id === sessionId)?.sessionBridge, false);
  });

  it("hands a message to pi's steering queue when the bridge reports it could not deliver", async () => {
    harness = await startDaemon({ FAKE_PI_BRIDGE: "1", FAKE_PI_BRIDGE_FAIL: "1" });
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await c.request({ type: "message", to: `#${sessionId}`, text: "rescued" });
    await c.waitFor((m) => m.type === "event" && m.session === sessionId && m.event?.type === "message_start" && JSON.stringify(m.event.message).includes("rescued"));
  });

  it("confirms before touching a brand-new recently-modified session file, then proceeds once confirmed", async () => {
    // A file this daemon has never handled may belong to a presence-less
    // external pi (undetectable); a fresh mtime is the signal, and the
    // daemon must not touch the file until the user confirms. Files it has
    // handled before are its own and never confirm, whatever their mtime.
    harness = await startDaemon();
    const c = await harness.connect();
    const file = path.join(harness.dir, "fresh-session.jsonl");
    fs.writeFileSync(file, `${JSON.stringify({ type: "session", id: "fresh" })}\n`);
    const r = await c.request({ type: "prompt", sessionFile: file, cwd: harness.dir, message: "hello" });
    assert.equal((r as { confirmFork?: boolean }).confirmFork, true);
    assert.ok(c.sessions().every((s) => s.sessionFile !== file));

    await c.request({ type: "prompt", sessionFile: file, cwd: harness.dir, message: "hello", confirmFork: true });
    await c.waitFor((m) => m.type === "history");
    const s = c.sessions().find((x) => x.sessionFile === file);
    assert.ok(s, "confirmed prompt should register and start the session");
    // exactly one delivery: the confirmed prompt, nothing else. The fake-pi
    // writes the session file only after it processes the prompt, which can
    // lag the daemon's history replay, so poll rather than trusting history.
    let userEntries = 0;
    for (let i = 0; i < 50; i++) {
      const entries = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      userEntries = entries.filter((e) => e.message?.role === "user").length;
      if (userEntries > 0) {
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(userEntries, 1, "one user entry after one confirmed prompt");

    // now the daemon owns it: recent mtime or not, no confirm
    fs.appendFileSync(file, "\n");
    const r3 = await c.request({ type: "prompt", sessionFile: file, cwd: harness.dir, message: "again" });
    assert.equal((r3 as { confirmFork?: boolean }).confirmFork, undefined);
  });

  it("does not ask about a fresh session file that toriel ran before a daemon restart", async () => {
    const handled = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "toriel-handled-")), "handled.json");
    harness = await startDaemon({ TORIEL_HANDLED: handled });
    const c = await harness.connect();
    const file = path.join(harness.dir, "was-ours.jsonl");
    fs.writeFileSync(file, `${JSON.stringify({ type: "session", id: "ours" })}\n`);
    fs.writeFileSync(handled, JSON.stringify([file]));
    const r = await c.request({ type: "prompt", sessionFile: file, cwd: harness.dir, message: "hello" });
    assert.equal((r as { confirmFork?: boolean }).confirmFork, undefined, "a file toriel ran before is its own");
    await c.waitFor((m) => m.type === "history");
    assert.ok(JSON.parse(fs.readFileSync(handled, "utf8")).includes(file));
  });
});
