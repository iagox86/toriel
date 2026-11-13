import assert from "node:assert/strict";
import * as fs from "node:fs";
import { afterEach, describe, it } from "node:test";
import { type Harness, type Msg, startDaemon } from "./helpers.ts";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const isSettled = (m: Msg) => m.type === "event" && m.event?.type === "agent_settled";

describe("daemon: lifecycle (2/3)", () => {
  it("serves pi's slash commands, and the last list once the child is gone", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    const live = await c.request({ type: "commands", session: sessionId });
    assert.deepEqual(live.map((x: { name: string }) => x.name), ["skill:demo", "compact"]);
    await c.request({ type: "deactivate", session: sessionId });
    const cached = await c.request({ type: "commands", session: sessionId });
    assert.equal(cached.length, 2);
  });

  it("lists models, switches to a unique match, and refuses an ambiguous or unknown one", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    const info = await c.request({ type: "model", session: sessionId });
    assert.equal(info.current, "fake/fake-model");
    assert.deepEqual(info.models, ["fake/fake-model", "fake/fake-big", "other/fake-big"]);
    await assert.rejects(c.request({ type: "model", session: sessionId, query: "fake-big" }), /matches 2 models/);
    await assert.rejects(c.request({ type: "model", session: sessionId, query: "nope" }), /no model matches/);
    const done = await c.request({ type: "model", session: sessionId, query: "other" });
    assert.equal(done.model, "other/fake-big");
    assert.equal(c.sessions().find((s) => s.id === sessionId)?.model, "other/fake-big");
  });

  it("shows and sets the thinking level, and refuses an ambiguous or unsupported one (/think)", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    const info = await c.request({ type: "think", session: sessionId });
    assert.equal(info.current, "medium");
    assert.deepEqual(info.levels, ["off", "minimal", "low", "medium", "high"]);
    await assert.rejects(c.request({ type: "think", session: sessionId, level: "m" }), /matches 2 levels: minimal, medium/);
    await assert.rejects(c.request({ type: "think", session: sessionId, level: "max" }), /supports: off, minimal/);
    const done = await c.request({ type: "think", session: sessionId, level: "hi" });
    assert.equal(done.level, "high");
    await c.waitFor(() => c.sessions().find((s) => s.id === sessionId)?.thinkingLevel === "high");
    assert.equal((await c.request({ type: "think", session: sessionId })).current, "high");
  });

  it("compacts an idle session and reports the sizes", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    const r = await c.request({ type: "compact", session: sessionId });
    assert.deepEqual(r, { tokensBefore: 5000, tokensAfter: 800 });
  });

  it("reports a session as compacting in the sessions broadcast while a compaction runs", async () => {
    harness = await startDaemon({ FAKE_PI_COMPACT_MS: "600" });
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    const compact = c.request({ type: "compact", session: sessionId });
    await c.waitFor((m) => m.type === "sessions" && (m.sessions as Msg[]).some((s) => s.id === sessionId && s.compacting === true));
    await compact;
    await c.waitFor((m) => m.type === "sessions" && (m.sessions as Msg[]).some((s) => s.id === sessionId && s.compacting === false));
  });

  it("clears the compacting flag when the child is stopped mid-compaction, and keeps it clear on restart", async () => {
    harness = await startDaemon({ FAKE_PI_COMPACT_MS: "600" });
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    const compact = c.request({ type: "compact", session: sessionId }).catch(() => undefined);
    await c.waitFor((m) => m.type === "sessions" && (m.sessions as Msg[]).some((s) => s.id === sessionId && s.compacting === true));
    await c.request({ type: "deactivate", session: sessionId });
    await c.waitFor((m) => m.type === "sessions" && (m.sessions as Msg[]).some((s) => s.id === sessionId && s.compacting === false));
    // a respawn on the same session record must not resurrect the flag
    await c.request({ type: "prompt", session: sessionId, message: "again" });
    await c.waitFor((m) => m.type === "sessions" && (m.sessions as Msg[]).some((s) => s.id === sessionId && s.active === true && s.compacting === false));
    await compact;
  });

  it("holds messages sent during a compaction and delivers them in order afterwards", async () => {
    harness = await startDaemon({ FAKE_PI_COMPACT_MS: "600" });
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    const compact = c.request({ type: "compact", session: sessionId });
    await new Promise((r) => setTimeout(r, 150));
    const first = await c.request({ type: "prompt", session: sessionId, message: "one" });
    assert.equal(first.disposition, "queued");
    await c.request({ type: "prompt", session: sessionId, message: "two" });
    const queued = c.messages.filter((m) => m.type === "event" && m.event?.type === "queue_update");
    assert.deepEqual(queued.at(-1)?.event.steering, ["one", "two"]);
    await compact;
    await c.waitFor((m) => m.type === "event" && m.event?.type === "message_end" && m.event.message?.content?.[0]?.text === "echo: two");
    const replies = c.messages
      .filter((m) => m.type === "event" && m.event?.type === "message_end" && m.event.message?.role === "assistant")
      .map((m) => m.event.message.content[0].text);
    assert.deepEqual(replies, ["echo: one", "echo: two"]);
  });

  it("refuses to reload, clear or compact again while a compaction is running", async () => {
    harness = await startDaemon({ FAKE_PI_COMPACT_MS: "600" });
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    // a reload needs a session file, which a session has only once it holds a message
    await c.request({ type: "prompt", session: sessionId, message: "something to compact" });
    await c.waitFor(isSettled);
    const compact = c.request({ type: "compact", session: sessionId });
    await new Promise((r) => setTimeout(r, 150));
    for (const type of ["reload", "clear", "compact"] as const) {
      await assert.rejects(c.request({ type, session: sessionId }), /compacting/);
    }
    await compact;
    await c.request({ type: "reload", session: sessionId });
  });

  it("returns pi's /mcp status text without showing it to controllers or adding it to the conversation", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    const seen = c.messages.length;
    const r = await c.request({ type: "mcp_status", session: sessionId });
    assert.match(r.text, /^mealie: connected, 12 tools/);
    assert.match(r.text, /config error: bad\.json/);
    const after = c.messages.slice(seen);
    assert.ok(!after.some((m) => m.type === "ui_request"), "the notice must not reach controllers");
    assert.ok(!after.some((m) => m.type === "event" && m.event?.type === "message_start"), "no message enters the conversation");
  });

  it("sends the waiting dialog again when asked, and forgets it once pi has timed it out", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await c.request({ type: "prompt", session: sessionId, message: "/ask" });
    await c.waitFor((m) => m.type === "ui_request" && m.request?.id === "ask-1");
    const pending = (m: Msg) => m.type === "sessions" && m.sessions?.some((x: { id: number; pendingDialog: boolean }) => x.id === sessionId && x.pendingDialog);
    await c.waitFor(pending);
    const seen = c.messages.filter((m: Msg) => m.type === "ui_request").length;
    await c.request({ type: "attach", session: sessionId });
    await c.waitFor(() => c.messages.filter((m: Msg) => m.type === "ui_request").length > seen);
    const cleared = (m: Msg) => m.type === "sessions" && m.sessions?.some((x: { id: number; pendingDialog: boolean }) => x.id === sessionId && !x.pendingDialog);
    const mark = c.messages.length;
    await c.waitFor((m) => cleared(m) && c.messages.indexOf(m) >= mark);
  });

  it("runs a !command, tells the agent the result at once, and can stop a long one", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    const done = await c.request({ type: "bash", session: sessionId, command: "echo hi; echo oops >&2; exit 3" });
    assert.deepEqual([done.output, done.exitCode, done.cancelled], ["hi\noops\n", 3, false]);
    const told = await c.waitFor((m) => m.type === "event" && m.event?.type === "message_start" && JSON.stringify(m.event).includes("<local-command>"));
    const text = JSON.stringify(told.event);
    assert.match(text, /<local-command>echo hi; echo oops >&2; exit 3<\/local-command>/);
    assert.match(text, /exit=\\"3\\"/);
    assert.match(text, /you did not run it|You did not run it/i);

    const long = c.request({ type: "bash", session: sessionId, command: "sleep 30" });
    await new Promise((r) => setTimeout(r, 300));
    await assert.rejects(c.request({ type: "bash", session: sessionId, command: "echo again" }), /already running/);
    await c.request({ type: "abort_bash", session: sessionId });
    const stopped = await long;
    assert.equal(stopped.cancelled, true);
  });

  it("passes pasted images on with the prompt", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
    await c.request({ type: "prompt", session: sessionId, message: "look", images: [image] });
    const reply = await c.waitFor(
      (m) => m.type === "event" && m.event?.type === "message_end" && m.event.message?.role === "assistant",
    );
    assert.equal(reply.event.message.content[0].text, "echo: look [1 image(s): image/png]");
  });

  it("keeps the images of a message held during a compaction", async () => {
    harness = await startDaemon({ FAKE_PI_COMPACT_MS: "500" });
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    const compact = c.request({ type: "compact", session: sessionId });
    await new Promise((r) => setTimeout(r, 120));
    const held = await c.request({
      type: "prompt",
      session: sessionId,
      message: "later",
      images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/jpeg" }],
    });
    assert.equal(held.disposition, "queued");
    await compact;
    const reply = await c.waitFor(
      (m) => m.type === "event" && m.event?.type === "message_end" && m.event.message?.content?.[0]?.text?.startsWith("echo: later"),
    );
    assert.match(reply.event.message.content[0].text, /\[1 image\(s\): image\/jpeg\]/);
  });

  it("reloads a session onto a fresh child with the same file and history", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await c.request({ type: "prompt", session: sessionId, message: "before" });
    await c.waitFor(isSettled);
    const file = c.sessions().find((s) => s.id === sessionId)?.sessionFile;
    const seen = c.messages.length;
    await c.request({ type: "reload", session: sessionId });
    const history = await c.waitFor((m) => m.type === "history" && c.messages.indexOf(m) >= seen);
    assert.equal(history.messages[0].content, "before");
    const meta = c.sessions().find((s) => s.id === sessionId);
    assert.equal(meta?.sessionFile, file);
    assert.equal(meta?.active, true);
  });

  it("refuses to reload a session that has no file yet, and keeps it usable (ticket 155)", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    const file = c.sessions().find((s) => s.id === sessionId)?.sessionFile;
    assert.ok(file && !fs.existsSync(file), "a fresh session has a path but no file");
    await assert.rejects(c.request({ type: "reload", session: sessionId }), /nothing to reload yet/);
    await c.request({ type: "prompt", session: sessionId, message: "still works" });
    await c.waitFor(isSettled);
    assert.equal(c.sessions().find((s) => s.id === sessionId)?.sessionFile, file);
  });

  it("resumes a stopped session from its file and answers only once the child can take commands", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await c.request({ type: "prompt", session: sessionId, message: "first" });
    await c.waitFor(isSettled);
    const file = c.sessions().find((s) => s.id === sessionId)?.sessionFile as string;
    await c.request({ type: "deactivate", session: sessionId });
    assert.equal(c.sessions().find((s) => s.id === sessionId)?.active, false);
    const r = await c.request({ type: "spawn", sessionFile: file, cwd: harness.dir, ready: true });
    assert.equal(c.sessions().find((s) => s.id === r.sessionId)?.active, true);
    const info = await c.request({ type: "model", session: r.sessionId });
    assert.equal(info.current, "fake/fake-model");
  });

  it("keeps a usage report from a child and shows it on every session of that provider", async () => {
    const report = { v: 1, provider: "fake", source: "zai", windows: [{ label: "5h", pct: 16 }], at: Date.now() };
    harness = await startDaemon({ FAKE_PI_USAGE: JSON.stringify(report) });
    const c = await harness.connect();
    const first = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await c.waitFor((m) => m.type === "sessions" && m.sessions.some((s: Msg) => s.id === first.sessionId && s.usage?.windows?.[0]?.pct === 16));
    const second = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "sessions" && m.sessions.some((s: Msg) => s.id === second.sessionId && s.usage?.source === "zai"));
    // the record is the daemon's: controllers never see it as a UI request
    assert.ok(!c.messages.some((m: Msg) => m.type === "ui_request" && m.request?.statusKey === "toriel-usage"));
  });

  it("names a new session when spawned with a name", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir, name: "my new session" });
    await c.waitFor((m) => m.type === "history");
    assert.equal(c.sessions().find((s) => s.id === sessionId)?.sessionName, "my new session");
  });

  it("clears a session in place: same file and session, empty history", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await c.request({ type: "prompt", session: sessionId, message: "old context" });
    await c.waitFor(isSettled);
    const before = c.sessions().find((s) => s.id === sessionId)?.sessionFile;
    const seen = c.messages.length;
    await c.request({ type: "clear", session: sessionId });
    const history = await c.waitFor((m) => m.type === "history" && c.messages.indexOf(m) >= seen);
    assert.deepEqual(history.messages, []);
    const meta = c.sessions().find((s) => s.id === sessionId);
    assert.equal(meta?.sessionFile, before);
    assert.equal(meta?.messageCount, 0);
    assert.equal(meta?.active, true);
  });

  it("restores a cleared session's conversation and keeps the model in use", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await c.request({ type: "prompt", session: sessionId, message: "precious context" });
    await c.waitFor(isSettled);
    await c.request({ type: "clear", session: sessionId });
    await c.request({ type: "model", session: sessionId, query: "other/fake-big" });
    const seen = c.messages.length;
    const r = await c.request({ type: "restore_clear", session: sessionId });
    assert.ok(r.entries > 0);
    const history = await c.waitFor((m) => m.type === "history" && c.messages.indexOf(m) >= seen);
    assert.equal(history.messages[0].content, "precious context");
    assert.equal((await c.request({ type: "model", session: sessionId })).current, "other/fake-big");
    await assert.rejects(c.request({ type: "restore_clear", session: sessionId }), /nothing to restore/);
  });
});
