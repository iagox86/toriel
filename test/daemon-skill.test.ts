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

/** A session the controller is attached to, ready for prompts. */
async function liveSession(h: Harness): Promise<{ c: Client; session: number }> {
  const c = await h.connect();
  const { sessionId } = await c.request({ type: "spawn", cwd: h.dir });
  await c.waitFor((m) => m.type === "history" && m.session === sessionId);
  return { c, session: sessionId };
}

describe("daemon: skill load notices (ticket 317)", () => {
  it("announces the skill when the model reads its SKILL.md, once, as a flash and a durable note", async () => {
    harness = await startDaemon();
    const { c, session } = await liveSession(harness);
    c.messages.length = 0;
    await c.request({ type: "prompt", session, message: "/skill-read pi/skills/messaging/SKILL.md" });
    const flash = await c.waitFor((m) => m.type === "notice" && m.text === "skill loaded(messaging)" && m.durable !== true);
    assert.equal(flash.session, session);
    const durable = await c.waitFor((m) => m.type === "notice" && m.text === "skill loaded(messaging)" && m.durable === true);
    assert.equal(durable.session, session);
    await c.waitFor(isSettled);
    assert.equal(skillNotices(c, "messaging").length, 2, "exactly the flash and the durable note");
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

  it("announces a second skill the same session reads", async () => {
    harness = await startDaemon();
    const { c, session } = await liveSession(harness);
    await c.request({ type: "prompt", session, message: "/skill-read pi/skills/messaging/SKILL.md" });
    await c.waitFor(isSettled);
    c.messages.length = 0;
    await c.request({ type: "prompt", session, message: "/skill-read pi/skills/gdb-mcp/SKILL.md" });
    const durable = await c.waitFor((m) => m.type === "notice" && m.text === "skill loaded(gdb-mcp)" && m.durable === true);
    assert.equal(durable.session, session);
    await c.waitFor(isSettled);
    assert.equal(skillNotices(c, "gdb-mcp").length, 2);
    assert.equal(skillNotices(c, "messaging").length, 0, "only the new skill is announced");
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
