import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { until } from "./helpers.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-goalext-"));
after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
const sock = path.join(dir, "d.sock");
// a run from inside a toriel session inherits its socket; these tests point at their own fake daemon
process.env.TORIEL_CHILD = "1";
process.env.TORIEL_SOCK = sock;
process.env.TORIEL_SESSION_ID = "0b1c2d3e-aaaa-4bbb-8ccc-111111111111";
const ext = await import("../pi/extensions/toriel-goal.ts");
const { END_OF_RUN_CALLS, MID_RUN_CALLS } = await import("../pi/extensions/lib/goal-nudge.ts");

/** The goal record the fake daemon answers with; null when the session has none. */
type Rec = { text?: string; setAt?: number; done?: boolean; doneBy?: string } | null;

/** A daemon stand-in for the goal command: answers each command with `record` as the response's data. */
function fakeGoalDaemon(record: Rec, fail = false): Promise<{ seen: Array<Record<string, unknown>>; close(): void; say(rec: Rec): void }> {
  const seen: Array<Record<string, unknown>> = [];
  const state = { record };
  const server = net.createServer((s) => {
    s.on("data", (chunk) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        const cmd = JSON.parse(line) as Record<string, unknown>;
        seen.push(cmd);
        s.write(`${JSON.stringify({ type: "sessions", sessions: [] })}\n`); // noise a real daemon may send first
        s.write(`${JSON.stringify({ type: "response", id: cmd.id, ok: !fail, ...(fail ? { error: "the goal store is locked" } : { data: state.record }) })}\n`);
      }
    });
  });
  fs.rmSync(sock, { force: true });
  return new Promise((resolve) => server.listen(sock, () => resolve({ seen, close: () => server.close(), say: (rec: Rec) => { state.record = rec; } })));
}

function registered() {
  const tools: Array<{ name: string; description: string; execute(...a: unknown[]): Promise<{ content: Array<{ text: string }>; details: unknown }> }> = [];
  ext.default({ on: () => undefined, registerTool: (t: never) => tools.push(t) } as never);
  return tools;
}

/** A pi stub that keeps the hook handlers, so the tests can fire them and check what the extension wired up. */
class PiStub {
  hooks = new Map<string, (event?: unknown, ctx?: unknown) => unknown>();
  tools: Array<{ execute(...a: unknown[]): Promise<{ content: Array<{ text: string }>; details: unknown }> }> = [];
  on(event: string, handler: (event?: unknown, ctx?: unknown) => unknown): void {
    this.hooks.set(event, handler);
  }
  registerTool(tool: { execute(...a: unknown[]): Promise<{ content: Array<{ text: string }>; details: unknown }> }): void {
    this.tools.push(tool);
  }
  fire(event: string, ev: unknown = {}, ctx: unknown = {}): unknown {
    const handler = this.hooks.get(event);
    return handler === undefined ? undefined : handler(ev, ctx);
  }
}

describe("toriel_goal tool", () => {
  it("registers only inside a toriel child with a socket", () => {
    process.env.TORIEL_CHILD = "1";
    delete process.env.TORIEL_SOCK;
    const noSock: unknown[] = [];
    ext.default({ on: () => undefined, registerTool: (t: never) => noSock.push(t) } as never);
    assert.equal(noSock.length, 0);
    process.env.TORIEL_SOCK = sock;
    delete process.env.TORIEL_CHILD;
    const noChild: unknown[] = [];
    ext.default({ on: () => undefined, registerTool: (t: never) => noChild.push(t) } as never);
    assert.equal(noChild.length, 0);
    process.env.TORIEL_CHILD = "1";
    const [tool] = registered();
    assert.equal(tool?.name, "toriel_goal");
    assert.match(tool?.description ?? "", /not when you are close/);
  });

  it("marks the goal done in its own session, marked as the agent's", async () => {
    const d = await fakeGoalDaemon({ text: "fix the flaky build", setAt: 1, done: true, doneBy: "agent" });
    try {
      const out = await registered()[0]?.execute("t1", {}, undefined, undefined, {});
      assert.match(out?.content[0]?.text ?? "", /Goal marked done: fix the flaky build/);
      assert.deepEqual({ ...d.seen[0], id: undefined }, { type: "goal", action: "done", by: "agent", sessionId: process.env.TORIEL_SESSION_ID, id: undefined });
    } finally {
      d.close();
    }
  });

  it("says there is nothing to mark when the session has no goal, and errors it", async () => {
    const d = await fakeGoalDaemon(null);
    try {
      const out = await registered()[0]?.execute("t1", {}, undefined, undefined, {});
      assert.match(out?.content[0]?.text ?? "", /^There is no goal set for this session; nothing was marked\.$/);
      assert.deepEqual(out?.details, { error: true });
    } finally {
      d.close();
    }
  });

  it("tells the model there is no id when the tool runs before one exists", async () => {
    const keep = process.env.TORIEL_SESSION_ID;
    delete process.env.TORIEL_SESSION_ID;
    try {
      const out = await registered()[0]?.execute("t1", {}, undefined, undefined, {});
      assert.match(out?.content[0]?.text ?? "", /no id yet/);
      assert.deepEqual(out?.details, { error: true });
    } finally {
      if (keep === undefined) {
        delete process.env.TORIEL_SESSION_ID;
      } else {
        process.env.TORIEL_SESSION_ID = keep;
      }
    }
  });

  it("returns the daemon's refusal as text instead of throwing", async () => {
    const d = await fakeGoalDaemon(null, true);
    try {
      const out = await registered()[0]?.execute("t1", {}, undefined, undefined, {});
      assert.match(out?.content[0]?.text ?? "", /Goal not marked done: the goal store is locked/);
    } finally {
      d.close();
    }
  });

  it("says so when the daemon is not reachable", async () => {
    fs.rmSync(sock, { force: true });
    const out = await registered()[0]?.execute("t1", {}, undefined, undefined, {});
    assert.match(out?.content[0]?.text ?? "", /Goal not marked done: cannot reach the toriel daemon/);
  });
});

describe("goal reminders (the hooked flow)", () => {
  const OPEN: Rec = { text: "fix the flaky build", setAt: 1 };
  // fire a tool result through the stub's tool_result handler; the reminder appended to it, or undefined
  const call = (ps: PiStub): string | undefined => {
    const out = ps.fire("tool_result", { toolName: "bash", content: [] }) as { content: Array<{ text?: string }> } | undefined;
    return out === undefined ? undefined : out.content.at(-1)?.text;
  };

  it("asks the daemon for this session's goal at session start", async () => {
    const d = await fakeGoalDaemon(null);
    try {
      const ps = new PiStub();
      ext.default(ps as never);
      ps.fire("session_start", {});
      await until(() => d.seen.length > 0);
      assert.deepEqual({ type: d.seen[0]?.type, action: d.seen[0]?.action, sessionId: d.seen[0]?.sessionId }, { type: "goal", action: "get", sessionId: process.env.TORIEL_SESSION_ID });
    } finally {
      d.close();
    }
  });

  it("falls back to the sessionManager's id when TORIEL_SESSION_ID is unset", async () => {
    const d = await fakeGoalDaemon(null);
    const keep = process.env.TORIEL_SESSION_ID;
    delete process.env.TORIEL_SESSION_ID;
    try {
      const ps = new PiStub();
      ext.default(ps as never);
      ps.fire("session_start", {}, { sessionManager: { getSessionId: () => "ee1c2d3e-cccc-4ddd-8eee-555555555555" } });
      await until(() => d.seen.length > 0);
      assert.equal(d.seen[0]?.sessionId, "ee1c2d3e-cccc-4ddd-8eee-555555555555");
    } finally {
      d.close();
      if (keep === undefined) {
        delete process.env.TORIEL_SESSION_ID;
      } else {
        process.env.TORIEL_SESSION_ID = keep;
      }
    }
  });

  it("reminds at once when a goal is fetched, then again after MID_RUN_CALLS calls", async () => {
    const d = await fakeGoalDaemon(OPEN);
    try {
      const ps = new PiStub();
      ext.default(ps as never);
      await ps.fire("before_agent_start", {}); // the run-start refetch is awaited, so the goal is in the nudges
      assert.match(call(ps) ?? "", /^\n\nReminder: your goal is "fix the flaky build"/);
      const later: number[] = [];
      for (let i = 2; i <= 1 + MID_RUN_CALLS; i++) {
        if (call(ps) !== undefined) {
          later.push(i);
        }
      }
      assert.deepEqual(later, [1 + MID_RUN_CALLS], "the next reminder stays MID_RUN_CALLS after the announce");
    } finally {
      d.close();
    }
  });

  it("sees a goal set while the session already ran (the run-start refetch)", async () => {
    const d = await fakeGoalDaemon(null);
    try {
      const ps = new PiStub();
      ext.default(ps as never);
      await ps.fire("before_agent_start", {}); // no goal yet
      assert.equal(call(ps), undefined);
      d.say(OPEN); // the user runs /goal mid-session
      await ps.fire("before_agent_start", {}); // the next run picks it up before any tool call
      assert.match(call(ps) ?? "", /Reminder: your goal is "fix the flaky build"/);
    } finally {
      d.close();
    }
  });

  it("treats a reply without a text as no goal (the reply shape this consumes is pinned here)", async () => {
    const d = await fakeGoalDaemon({ setAt: 1 });
    try {
      const ps = new PiStub();
      ext.default(ps as never);
      await ps.fire("before_agent_start", {});
      for (let i = 0; i < MID_RUN_CALLS; i++) {
        assert.equal(call(ps), undefined);
      }
      assert.equal(await ps.fire("agent_before_settle", {}), undefined);
    } finally {
      d.close();
    }
  });

  it("says nothing when the goal is fetched as null, and does not buy a turn either", async () => {
    const d = await fakeGoalDaemon(null);
    try {
      const ps = new PiStub();
      ext.default(ps as never);
      await ps.fire("before_agent_start", {});
      for (let i = 0; i < END_OF_RUN_CALLS; i++) {
        assert.equal(call(ps), undefined);
      }
      assert.equal(await ps.fire("agent_before_settle", {}), undefined);
    } finally {
      d.close();
    }
  });

  it("buys one turn at settle when the goal is live, once per run, and before_agent_start re-arms it", async () => {
    const d = await fakeGoalDaemon(OPEN);
    try {
      const ps = new PiStub();
      ext.default(ps as never);
      await ps.fire("before_agent_start", {});
      for (let i = 0; i < END_OF_RUN_CALLS; i++) {
        call(ps);
      }
      const bought = (await ps.fire("agent_before_settle", {})) as { entries: Array<{ customType?: string; content?: string }>; continue?: boolean } | undefined;
      assert.equal(bought?.continue, true);
      assert.equal(bought?.entries[0]?.customType, "toriel-goal-reminder");
      assert.match(bought?.entries[0]?.content ?? "", /fix the flaky build/);
      assert.equal(d.seen.length, 2, "the settle re-checked the goal with the daemon before buying the turn");
      assert.equal(await ps.fire("agent_before_settle", {}), undefined, "once per run");
      assert.equal(d.seen.length, 2, "and did not ask the daemon again for it");
      await ps.fire("before_agent_start", {}); // a new run re-arms the allowance
      for (let i = 0; i < END_OF_RUN_CALLS; i++) {
        call(ps);
      }
      assert.equal((await ps.fire("agent_before_settle", {}) as { continue?: boolean } | undefined)?.continue, true, "a new run gets its own turn");
    } finally {
      d.close();
    }
  });

  it("does not buy the turn when the fresh fetch says the goal is done or gone", async () => {
    const d = await fakeGoalDaemon(OPEN);
    try {
      const ps = new PiStub();
      ext.default(ps as never);
      await ps.fire("before_agent_start", {});
      for (let i = 0; i < END_OF_RUN_CALLS; i++) {
        call(ps);
      }
      d.say({ ...OPEN, done: true }); // the goal was marked done while the run worked
      assert.equal(await ps.fire("agent_before_settle", {}), undefined);
      assert.equal(call(ps), undefined, "the reminders stop with it");
      d.say(null);
      await ps.fire("before_agent_start", {});
      for (let i = 0; i < END_OF_RUN_CALLS; i++) {
        call(ps);
      }
      assert.equal(await ps.fire("agent_before_settle", {}), undefined);
    } finally {
      d.close();
    }
  });

  it("leaves nothing unhandled when the daemon is down at any hook", async () => {
    const d = await fakeGoalDaemon(OPEN);
    const ps = new PiStub();
    ext.default(ps as never);
    await ps.fire("before_agent_start", {}); // the goal is fetched while the daemon is still up
    const unhandled: unknown[] = [];
    const saw = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", saw);
    try {
      d.close(); // the daemon goes away mid-session
      ps.fire("session_start", {}); // the fire-and-forget refetch has its own catch
      await ps.fire("before_agent_start", {}); // the awaited refetch resolves via its catch too
      for (let i = 0; i < END_OF_RUN_CALLS; i++) {
        call(ps);
      }
      assert.equal(await ps.fire("agent_before_settle", {}), undefined, "the fresh fetch fails, so no turn is bought");
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.off("unhandledRejection", saw);
      assert.deepEqual(unhandled, []);
    }
  });
});
