import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { type Client, type Harness, type Msg, startDaemon } from "./helpers.ts";

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const isSettled = (m: Msg) => m.type === "event" && m.event?.type === "agent_settled";
const skillNotices = (c: Client, name: string) => c.messages.filter((m) => m.type === "notice" && m.text === `skill loaded(${name})`);
const readEnd = (c: Client, toolCallId: string) => c.messages.find((m) => m.type === "event" && m.event?.type === "tool_execution_end" && m.event.toolCallId === toolCallId);

/** A session the controller is attached to, ready for prompts. */
async function liveSession(h: Harness): Promise<{ c: Client; session: number }> {
  const c = await h.connect();
  const { sessionId } = await c.request({ type: "spawn", cwd: h.dir });
  await c.waitFor((m) => m.type === "history" && m.session === sessionId);
  return { c, session: sessionId };
}

describe("daemon: skill load notices (ticket 317)", () => {
  it("announces the skill when the model's read of its SKILL.md succeeds, once, as a durable notice keyed to the read call and after its end", async () => {
    harness = await startDaemon();
    const { c, session } = await liveSession(harness);
    c.messages.length = 0;
    await c.request({ type: "prompt", session, message: "/skill-read pi/skills/messaging/SKILL.md" });
    const notice = await c.waitFor((m) => m.type === "notice" && m.text === "skill loaded(messaging)");
    assert.equal(notice.session, session);
    assert.equal(notice.durable, true, "the notice is the transcript note");
    assert.equal(notice.toolCallId, "read-skill-1", "it names the read call it docks under");
    await c.waitFor(isSettled);
    assert.equal(skillNotices(c, "messaging").length, 1, "exactly one notice, no flash twin");
    const endMsg = readEnd(c, "read-skill-1");
    assert.ok(endMsg, "the read's tool_execution_end arrived");
    assert.ok(c.messages.indexOf(notice) > c.messages.indexOf(endMsg), "the notice comes after the read's tool_execution_end");
  });

  it("says nothing when the model re-reads a skill it already loaded", async () => {
    harness = await startDaemon();
    const { c, session } = await liveSession(harness);
    await c.request({ type: "prompt", session, message: "/skill-read pi/skills/messaging/SKILL.md" });
    await c.waitFor(isSettled);
    c.messages.length = 0;
    await c.request({ type: "prompt", session, message: "/skill-read pi/skills/messaging/SKILL.md" });
    await c.waitFor(isSettled);
    assert.equal(skillNotices(c, "messaging").length, 0, "a re-read is not news");
  });

  it("says nothing for a failed read and does not burn the slot: a later successful read announces", async () => {
    harness = await startDaemon();
    const { c, session } = await liveSession(harness);
    c.messages.length = 0;
    await c.request({ type: "prompt", session, message: "/skill-read-fail pi/skills/messaging/SKILL.md" });
    await c.waitFor(isSettled);
    assert.equal(skillNotices(c, "messaging").length, 0, "a failed read announces nothing");
    c.messages.length = 0;
    await c.request({ type: "prompt", session, message: "/skill-read pi/skills/messaging/SKILL.md" });
    const notice = await c.waitFor((m) => m.type === "notice" && m.text === "skill loaded(messaging)");
    assert.equal(notice.toolCallId, "read-skill-2", "the successful read's own call");
    await c.waitFor(isSettled);
    assert.equal(skillNotices(c, "messaging").length, 1);
  });

  it("announces a second skill the same session reads, once", async () => {
    harness = await startDaemon();
    const { c, session } = await liveSession(harness);
    await c.request({ type: "prompt", session, message: "/skill-read pi/skills/messaging/SKILL.md" });
    await c.waitFor(isSettled);
    c.messages.length = 0;
    await c.request({ type: "prompt", session, message: "/skill-read pi/skills/gdb-mcp/SKILL.md" });
    const notice = await c.waitFor((m) => m.type === "notice" && m.text === "skill loaded(gdb-mcp)");
    assert.equal(notice.session, session);
    assert.equal(notice.toolCallId, "read-skill-2");
    await c.waitFor(isSettled);
    assert.equal(skillNotices(c, "gdb-mcp").length, 1);
    assert.equal(skillNotices(c, "messaging").length, 0, "only the new skill is announced");
  });

  it("announces a skill name once, whichever root it is read from", async () => {
    harness = await startDaemon();
    const { c, session } = await liveSession(harness);
    await c.request({ type: "prompt", session, message: "/skill-read a/skills/x/SKILL.md" });
    await c.waitFor(isSettled);
    assert.equal(skillNotices(c, "x").length, 1, "the first root announces");
    c.messages.length = 0;
    await c.request({ type: "prompt", session, message: "/skill-read b/skills/x/SKILL.md" });
    await c.waitFor(isSettled);
    assert.equal(skillNotices(c, "x").length, 0, "the same skill under a second root is not news");
  });

  it("announces a skill again after /clear (the dedupe is per conversation)", async () => {
    harness = await startDaemon();
    const { c, session } = await liveSession(harness);
    // a message first: the fixture writes no session file until it has something to persist, and /clear needs one
    await c.request({ type: "prompt", session, message: "warm up" });
    await c.waitFor(isSettled);
    await c.request({ type: "prompt", session, message: "/skill-read pi/skills/messaging/SKILL.md" });
    await c.waitFor(isSettled);
    const seen = c.messages.length;
    await c.request({ type: "clear", session });
    await c.waitFor((m) => m.type === "history" && c.messages.indexOf(m) >= seen);
    c.messages.length = 0;
    await c.request({ type: "prompt", session, message: "/skill-read pi/skills/messaging/SKILL.md" });
    const notice = await c.waitFor((m) => m.type === "notice" && m.text === "skill loaded(messaging)");
    assert.equal(notice.toolCallId, "read-skill-1", "the restarted child reads it again");
    await c.waitFor(isSettled);
    assert.equal(skillNotices(c, "messaging").length, 1);
  });

  it("says nothing when the model reads a file that is not a skill", async () => {
    harness = await startDaemon();
    const { c, session } = await liveSession(harness);
    c.messages.length = 0;
    await c.request({ type: "prompt", session, message: "/skill-read notes/some-file.md" });
    await c.waitFor(isSettled);
    assert.equal(c.messages.some((m) => m.type === "notice"), false, "a read that is not a skill says nothing");
  });
});
