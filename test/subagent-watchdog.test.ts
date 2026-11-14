import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { DEFAULT_SUBAGENT_LIMITS, watchdogBreach } from "../src/subagents.ts";
import { type Client, type Harness, type Msg, startDaemon } from "./helpers.ts";

describe("watchdogBreach", () => {
  const base = { now: 100_000, startedAt: 0, lastEventAt: 90_000, background: false, idleMs: 0, maxMs: 0 };

  it("is off at 0, and fires on the idle gap alone", () => {
    assert.equal(watchdogBreach(base), undefined);
    assert.equal(watchdogBreach({ ...base, idleMs: 20_000 }), undefined);
    assert.match(watchdogBreach({ ...base, idleMs: 10_000 }) ?? "", /produced nothing for 10 s/);
    assert.match(watchdogBreach({ ...base, idleMs: 120_000, lastEventAt: -30_000 }) ?? "", /produced nothing for 2 min/);
  });

  it("caps the total time of a background run only", () => {
    assert.equal(watchdogBreach({ ...base, maxMs: 50_000 }), undefined, "a foreground caller can stop its own");
    assert.match(watchdogBreach({ ...base, maxMs: 60_000, background: true }) ?? "", /ran for 1 min, the time limit/);
    assert.equal(watchdogBreach({ ...base, maxMs: 200_000, background: true }), undefined);
  });

  it("defaults to a 15 minute idle limit and no total cap", () => {
    assert.equal(DEFAULT_SUBAGENT_LIMITS.idleMs, 15 * 60_000);
    assert.equal(DEFAULT_SUBAGENT_LIMITS.maxMs, 0);
  });
});

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const isSettled = (m: Msg) => m.type === "event" && m.event?.type === "agent_settled";

/** A session that has answered once, so it has a UUID to spawn from, and a project profile to spawn. */
async function parentSession(h: Harness): Promise<{ c: Client; uuid: string }> {
  const dir = path.join(h.dir, ".toriel", "agents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "worker.md"), "---\nname: worker\ndescription: test agent worker\n---\nBe brief.\n");
  const c = await h.connect();
  const { sessionId } = await c.request({ type: "spawn", cwd: h.dir });
  await c.waitFor((m) => m.type === "history" && m.session === sessionId);
  await c.request({ type: "prompt", session: sessionId, message: "hi" });
  await c.waitFor(isSettled);
  for (let i = 0; i < 40; i++) {
    const uuid = c.sessions().find((s) => s.id === sessionId)?.sessionId as string | undefined;
    if (uuid) {
      return { c, uuid };
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("the session never reported an id");
}

const spawn = (c: Client, from: string, over: Msg = {}) => c.request({ type: "agent_spawn", from, agent: "worker", task: "look around", description: "look", ...over });

describe("daemon: subagent watchdog (ticket 159)", () => {
  it("stops a subagent that goes silent, keeps what it said, and tells the parent why", async () => {
    harness = await startDaemon({ TORIEL_SUBAGENT_IDLE_MS: "600" });
    const { c, uuid } = await parentSession(harness);
    const started = Date.now();
    const r = await spawn(c, uuid, { task: "[turns 2] [hang]" });
    assert.equal(r.state, "stopped");
    assert.match(r.text, /produced nothing for 1 s \(stuck in a tool call\?\)/);
    assert.match(r.text, /Partial result:\nstep 1/);
    assert.ok(Date.now() - started < 8000);
  });

  it("leaves a subagent alone while it keeps producing events", async () => {
    harness = await startDaemon({ TORIEL_SUBAGENT_IDLE_MS: "600" });
    const { c, uuid } = await parentSession(harness);
    const started = Date.now();
    const r = await spawn(c, uuid, { task: "[turns 40] steady" });
    assert.equal(r.state, "done", r.text);
    assert.ok(Date.now() - started > 900, "the run outlasted the idle limit");
  });

  it("caps a background subagent's total time, however busy it is", async () => {
    harness = await startDaemon({ TORIEL_SUBAGENT_IDLE_MS: "0", TORIEL_SUBAGENT_MAX_MS: "700" });
    const { c, uuid } = await parentSession(harness);
    await spawn(c, uuid, { task: "[turns 200] busy", background: true });
    const done = await c.request({ type: "agents_op", from: uuid, action: "wait", ref: "#1", timeoutMs: 8000 });
    assert.match(done.text, /ran for 1 s, the time limit for a background subagent/);
  });
});
