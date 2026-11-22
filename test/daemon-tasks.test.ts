import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { type Harness, startDaemon } from "./helpers.ts";

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

describe("daemon: the agent's task list (ticket 228)", () => {
  it("keeps what the toriel-tasks extension reports, puts it in the session list, and keeps the record from the controllers", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history" && m.session === sessionId);
    assert.equal(c.sessions().find((s) => s.id === sessionId)?.tasks, undefined);

    await c.request({ type: "prompt", session: sessionId, message: "/tasks-report" });
    const listed = await c.waitFor((m) => m.type === "sessions" && m.sessions.some((s: { id: number; tasks?: unknown[] }) => s.id === sessionId && s.tasks?.length === 3));
    const tasks = listed.sessions.find((s: { id: number }) => s.id === sessionId).tasks;
    assert.deepEqual(tasks[1], { content: "Test it", status: "in_progress", activeForm: "Testing it" });
    assert.equal(c.messages.some((m) => m.type === "ui_request" && m.request?.statusKey === "toriel-tasks"), false, "a record for the daemon, not for the screen");
  });

  it("forgets the list when the extension reports an empty one", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history" && m.session === sessionId);
    await c.request({ type: "prompt", session: sessionId, message: "/tasks-report" });
    await c.waitFor((m) => m.type === "sessions" && m.sessions.some((s: { id: number; tasks?: unknown[] }) => s.id === sessionId && s.tasks));
    c.messages.length = 0;
    await c.request({ type: "prompt", session: sessionId, message: "/tasks-clear" });
    await c.waitFor((m) => m.type === "sessions" && m.sessions.some((s: { id: number; tasks?: unknown[] }) => s.id === sessionId && s.tasks === undefined));
  });

  it("does not restart the stale-list clock when pi re-emits agent_start for a continued turn (ticket 251 review)", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history" && m.session === sessionId);
    await c.request({ type: "prompt", session: sessionId, message: "/tasks-report" });
    await c.waitFor((m) => m.type === "sessions" && m.sessions.some((s: { id: number; tasks?: unknown[] }) => s.id === sessionId && s.tasks?.length === 3));
    const t0 = Date.now();
    // agent_start fires at once and again ~250 ms in (the [again] hook, like pi's re-emission for a continued turn); the run settles ~900 ms in
    await c.request({ type: "prompt", session: sessionId, message: "[turns 12] [again] work" });
    // poll the live meta for the whole run: every age the stale clock shows must come from the run's first agent_start
    let seenStreamed = false;
    let latestStale = 0;
    while (Date.now() < t0 + 900) {
      await c.request({ type: "list" });
      const s = c.sessions().find((m) => m.id === sessionId) as { tasksStaleSince?: number; streaming?: boolean } | undefined;
      if (s?.streaming) {
        seenStreamed = true;
        latestStale = Math.max(latestStale, s.tasksStaleSince ?? 0);
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.ok(seenStreamed, "the run was on while polled");
    assert.ok(latestStale > 0, "the open list showed a stale clock while the session worked");
    assert.ok(latestStale < t0 + 150, `kept the run's first agent_start (saw +${latestStale - t0}ms after the prompt)`);
  });
});
