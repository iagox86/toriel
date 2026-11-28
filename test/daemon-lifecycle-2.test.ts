import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
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
    // the toriel-mcp extension's pending command rides along on every child (ticket 346), so the live list names it too
    assert.deepEqual(live.map((x: { name: string }) => x.name), ["skill:demo", "compact", "toriel-mcp-pending"]);
    await c.request({ type: "deactivate", session: sessionId });
    const cached = await c.request({ type: "commands", session: sessionId });
    assert.equal(cached.length, 3);
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

  it("reports a sleeping session as starting while its child comes up, and not once it is up (ticket 352)", async () => {
    harness = await startDaemon({ FAKE_PI_STARTUP_MS: "600" });
    const c = await harness.connect();
    const file = path.join(harness.dir, "asleep.jsonl");
    fs.writeFileSync(file, `${JSON.stringify({ type: "session", id: "asleep" })}\n`);
    const mark = c.messages.length;
    await c.request({ type: "prompt", sessionFile: file, cwd: harness.dir, message: "wake up", confirmFork: true });
    const seen = c.messages.slice(mark).filter((m) => m.type === "sessions").map((m) => m.sessions.find((x: Msg) => x.sessionFile === file));
    assert.ok(seen.some((x: Msg) => x?.starting === true && !x.active), "a list while it starts says so");
    assert.ok(seen.every((x: Msg) => !(x?.starting && x.active)), "never starting and active at once");
    assert.equal(seen.at(-1)?.starting, undefined, "not starting once it is up");
  });

  it("lists the servers as connecting while pi's /mcp waits for a connect, and keeps pi's late answer from the controllers", async () => {
    harness = await startDaemon({ FAKE_PI_MCP_CONNECT_MS: "4500", FAKE_PI_MCP_PROBLEM: "1" });
    const c = await harness.connect();
    const spawnAt = Date.now();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    const seen = c.messages.length;
    const started = Date.now();
    const [a, b] = await Promise.all([c.request({ type: "mcp_status", session: sessionId }), c.request({ type: "mcp_status", session: sessionId })]);
    assert.ok(Date.now() - started < 4_500, "answered before the connect finished");
    assert.equal(a.text, "mealie: connecting (direct)");
    assert.equal(b.text, a.text, "a second asker shares the answer");
    // pi's own problem report is not the answer: it reaches the controllers as before
    await c.waitFor((m) => m.type === "ui_request" && m.request?.id === "mcp-problem");
    await new Promise((r) => setTimeout(r, 3_000));
    const after = c.messages.slice(seen);
    assert.ok(!after.some((m) => m.type === "ui_request" && (m.request?.id === "mcp-status" || m.request?.id === "mcp-pending")), "neither answer reaches controllers");
    const r = await c.request({ type: "mcp_status", session: sessionId });
    assert.match(r.text, /^mealie: connected, 12 tools/, "once connected, a new question gets pi's own answer");
    // both /mcp prompts of the child (the first ask's, and the new question's, which joined the armed tap) are answered at the
    // connect: past that, the last /mcp answer must still never have reached the controllers (review round 2)
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, spawnAt + 6_500 - Date.now())));
    assert.ok(!c.messages.slice(seen).some((m) => m.type === "ui_request" && m.request?.id === "mcp-status"), "pi's extra answer never reached the controllers either");
  });

  it("answers /mcp with pi's own notice inside the grace, and never asks the pending command then (mcp review)", async () => {
    // pi's answer arrives well before the 3s grace: the tap recognizes its shape and takes the whole wait down with it
    harness = await startDaemon({ FAKE_PI_MCP_CONNECT_MS: "400" });
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    const started = Date.now();
    const r = await c.request({ type: "mcp_status", session: sessionId });
    assert.ok(Date.now() - started < 3_000, "answered by pi's own notice, inside the grace");
    assert.match(r.text, /^mealie: connected, 12 tools/, "the real list, not the connecting placeholder");
    await new Promise((resolve) => setTimeout(resolve, 3_400)); // past the grace: nothing may fire it now
    assert.ok(!fs.existsSync(path.join(harness.sessionsDir, "mcp-pending-calls")), "the grace never fired a pending prompt");
  });

  it("asks an extensionless child /mcp and answers only when pi itself finally does, with no pending command ever sent (mcp review round 2)", async () => {
    // no toriel-mcp-pending in the child's command list: the grace's gate (get_commands at src/daemon-children.ts) must keep
    // the pending command back, and the ask must wait out pi's own connect-driven answer instead of any grace-borne list
    harness = await startDaemon({ FAKE_PI_NO_MCP: "1", FAKE_PI_MCP_CONNECT_MS: "5000" });
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    const r = await c.request({ type: "mcp_status", session: sessionId });
    assert.match(r.text, /^mealie: connected, 12 tools/, "pi's own answer resolved the wait, not the pending list a grace would have asked for");
    assert.doesNotMatch(r.text, /connecting \(direct\)/, "not the connecting placeholder");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(!fs.existsSync(path.join(harness.sessionsDir, "mcp-pending-calls")), "the grace never sent the pending command: get_commands had no toriel-mcp-pending to gate on");
  });

  it("a replaced child is asked /mcp anew, and the stopped child's in-flight asker reads why (mcp review)", async () => {
    harness = await startDaemon({ FAKE_PI_MCP_CONNECT_MS: "8000" });
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    const first = assert.rejects(c.request({ type: "mcp_status", session: sessionId }), /the session stopped before \/mcp was answered/);
    await new Promise((resolve) => setTimeout(resolve, 200)); // the question is in flight, its grace armed, when the child goes
    await c.request({ type: "deactivate", session: sessionId });
    await first;
    await c.request({ type: "prompt", session: sessionId, message: "wake" });
    const r = await c.request({ type: "mcp_status", session: sessionId });
    assert.equal(r.text, "mealie: connecting (direct)", "the new child was asked fresh and answered at its grace");
    const calls = fs.readFileSync(path.join(harness.sessionsDir, "mcp-pending-calls"), "utf8").split("\n").filter(Boolean);
    assert.equal(calls.length, 1, "only the new child was asked the pending command; the stopped question's grace went with it");
  });

  it("an unrelated notice passes through the swallow window, and a pending notify no tap holds is dropped, never shown (mcp review)", async () => {
    harness = await startDaemon({ FAKE_PI_MCP_CONNECT_MS: "8000" });
    const c = await harness.connect();
    const spawnAt = Date.now();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    // the extension's list arriving with no question's tap waiting behind it is toriel's plumbing, not a controller's text
    await c.request({ type: "prompt", session: sessionId, message: "/toriel-mcp-pending" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(!c.messages.some((m) => m.type === "ui_request" && JSON.stringify(m.request ?? {}).includes("toriel-mcp-pending")), "no tap holds it, and it is still dropped");
    // the swallow window of a live question takes only its answer: another extension's notice is shown as usual
    const status = c.request({ type: "mcp_status", session: sessionId });
    await c.request({ type: "prompt", session: sessionId, message: "/toriel-background" });
    await c.waitFor((m) => m.type === "ui_request" && m.request?.message === "Moved to the background: j1 (fake)");
    const r = await status;
    assert.equal(r.text, "mealie: connecting (direct)", "the question itself was answered by the grace's pending list");
    const calls = fs.readFileSync(path.join(harness.sessionsDir, "mcp-pending-calls"), "utf8").split("\n").filter(Boolean);
    assert.equal(calls.length, 2, "one call for the ask without a tap, one for the grace");
    assert.ok(!c.messages.some((m) => m.type === "ui_request" && (m.request?.id === "mcp-status" || m.request?.id === "mcp-pending")), "neither mcp answer reached controllers as a notice");
    // pi's real /mcp answer lands (spawn + FAKE_PI_MCP_CONNECT_MS, plus a margin): its tap was still armed, and it is never shown
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, spawnAt + 10_000 - Date.now())));
    assert.ok(!c.messages.some((m) => m.type === "ui_request" && m.request?.id === "mcp-status"), "pi's late answer stayed with the armed tap, never the controllers");
    // the answer spent the tap's last outstanding shot and retired it: the child's next answer is the child's own text again
    await c.request({ type: "prompt", session: sessionId, message: "/mcp" });
    await c.waitFor((m) => m.type === "ui_request" && m.request?.id === "mcp-status");
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

  it("with the session bridge, a !command result is a toriel-local-command custom message (not a user prompt) carrying the result", async () => {
    harness = await startDaemon({ FAKE_PI_BRIDGE: "1" });
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    const done = await c.request({ type: "bash", session: sessionId, command: "echo hi; exit 3" });
    assert.equal(done.exitCode, 3);
    const told = await c.waitFor((m) => m.type === "event" && m.event?.type === "message_start" && m.event.message?.customType === "toriel-local-command");
    assert.equal(told.event.message.role, "custom");
    assert.deepEqual({ ...told.event.message.details, id: undefined }, { command: "echo hi; exit 3", output: "hi\n", exitCode: 3, cancelled: false, truncated: false, id: undefined });
    assert.match(told.event.message.content, /<local-command>echo hi; exit 3<\/local-command>/, "the model still reads the wrapper text");
  });

  it("delivers a command's generated prompt as a toriel-command-prompt message naming the command, never a user message (ticket 302)", async () => {
    harness = await startDaemon({ FAKE_PI_BRIDGE: "1" });
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await c.request({ type: "prompt", session: sessionId, message: "Please write AGENTS.md", command: "/init" });
    const told = await c.waitFor((m) => m.type === "event" && m.event?.type === "message_start" && m.event.message?.customType === "toriel-command-prompt");
    assert.equal(told.event.message.role, "custom");
    assert.equal(told.event.message.details.command, "/init");
    assert.equal(told.event.message.content, "Please write AGENTS.md", "the model reads the prompt");
    assert.ok(!c.messages.some((m) => m.type === "event" && m.event?.type === "message_start" && m.event.message?.role === "user"), "no user message");
  });

  it("without the session bridge, a command's prompt is a plain prompt, as before (ticket 302)", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await c.request({ type: "prompt", session: sessionId, message: "Please write AGENTS.md", command: "/init" });
    await c.waitFor((m) => m.type === "event" && m.event?.type === "message_start" && m.event.message?.role === "user" && m.event.message.content === "Please write AGENTS.md");
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

  it("holds a command prompt mid-compaction as a command: the strip names it and the release delivers it as the command prompt (ticket 302)", async () => {
    // slow mode so the second injection is delivered at the first run's turn boundary, like the bridge does mid-run
    harness = await startDaemon({ FAKE_PI_COMPACT_MS: "600", FAKE_PI_BRIDGE: "1", FAKE_PI_SLOW: "1", FAKE_PI_STEP_MS: "40" });
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    const compact = c.request({ type: "compact", session: sessionId });
    await c.waitFor((m) => m.type === "sessions" && (m.sessions as Msg[]).some((s) => s.id === sessionId && s.compacting === true));
    const heldText = await c.request({ type: "prompt", session: sessionId, message: "one" });
    assert.equal(heldText.disposition, "queued");
    const heldCommand = await c.request({ type: "prompt", session: sessionId, message: "Please write AGENTS.md", command: "/init" });
    assert.equal(heldCommand.disposition, "queued");
    const strip = c.messages.filter((m) => m.type === "event" && m.event?.type === "queue_update").map((m) => m.event.steering as string[]);
    assert.deepEqual(strip.at(-1), ["one", "/init"], "the strip shows the command that was typed, never the generated prompt");
    await compact;
    const told = await c.waitFor((m) => m.type === "event" && m.event?.type === "entry_appended" && m.event.entry?.customType === "toriel-command-prompt");
    assert.equal(told.event.entry.details.command, "/init");
    assert.equal(told.event.entry.content, "Please write AGENTS.md", "the model reads the prompt");
    assert.ok(!c.messages.some((m) => m.type === "event" && m.event?.type === "message_start" && m.event.message?.role === "user" && m.event.message?.content === "Please write AGENTS.md"), "the held command prompt is never released as the user's plain text");
    const plain = c.messages.find((m) => m.type === "event" && m.event?.type === "message_start" && m.event.message?.role === "user" && m.event.message?.content === "one");
    assert.ok(plain, "the held plain prompt is still released as a user message");
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
