import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { type Client, type Harness, type Msg, startDaemon } from "./helpers.ts";

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const isSettled = (m: Msg) => m.type === "event" && m.event?.type === "agent_settled";

/** A session that has answered once, so it has a UUID (the marker is named by it). */
async function savedSession(h: Harness): Promise<{ c: Client; session: number; uuid: string; marker: string }> {
  const c = await h.connect();
  const { sessionId } = await c.request({ type: "spawn", cwd: h.dir });
  await c.waitFor((m) => m.type === "history" && m.session === sessionId);
  await c.request({ type: "prompt", session: sessionId, message: "hi" });
  await c.waitFor(isSettled);
  for (let i = 0; i < 40; i++) {
    const uuid = c.sessions().find((s) => s.id === sessionId)?.sessionId;
    if (uuid) {
      return { c, session: sessionId, uuid, marker: path.join(h.dir, "plan-mode", uuid) };
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("the session never got an id");
}

const metaOf = (c: Client, session: number) => c.sessions().find((s) => s.id === session);

describe("daemon: plan mode (ticket 229)", () => {
  it("switches on and off by writing the marker file, says so durably, and shows it in the session list", async () => {
    harness = await startDaemon();
    const { c, session, marker } = await savedSession(harness);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(metaOf(c, session)?.plan, undefined);

    c.messages.length = 0;
    assert.equal((await c.request({ type: "plan_mode", session, on: true })).on, true);
    assert.equal(fs.existsSync(marker), true);
    const notice = await c.waitFor((m) => m.type === "notice" && /^plan mode ON/.test(m.text));
    assert.equal(notice.durable, true);
    await c.waitFor((m) => m.type === "sessions" && m.sessions.some((s: { id: number; plan?: boolean }) => s.id === session && s.plan === true));

    // no argument toggles
    assert.equal((await c.request({ type: "plan_mode", session })).on, false);
    assert.equal(fs.existsSync(marker), false);
    await c.waitFor((m) => m.type === "notice" && /^plan mode OFF/.test(m.text));
    await c.waitFor((m) => m.type === "sessions" && m.sessions.some((s: { id: number; plan?: boolean }) => s.id === session && s.plan === undefined));
  });

  it("follows the agent when it enters or leaves plan mode itself, and says so once", async () => {
    harness = await startDaemon();
    const { c, session } = await savedSession(harness);
    c.messages.length = 0;
    await c.request({ type: "prompt", session, message: "/plan-report-on" });
    const on = await c.waitFor((m) => m.type === "notice" && /^plan mode ON: the agent asked/.test(m.text));
    assert.equal(on.durable, true);
    await c.waitFor((m) => m.type === "sessions" && m.sessions.some((s: { id: number; plan?: boolean }) => s.id === session && s.plan === true));
    assert.equal(c.messages.some((m) => m.type === "ui_request" && m.request?.statusKey === "toriel-plan"), false, "a record for the daemon, not for the screen");
    await c.request({ type: "prompt", session, message: "/plan-report-off" });
    await c.waitFor((m) => m.type === "notice" && /^plan mode OFF: you approved/.test(m.text));
  });

  it("refuses an unknown session, and a session with no id yet", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    await assert.rejects(c.request({ type: "plan_mode", session: 9999, on: true }), /no session #9999/);
  });
});
