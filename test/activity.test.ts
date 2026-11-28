import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Activity, type ActivityState, activityLines, floorActivity, formatElapsed, reduceActivity } from "../src/activity.ts";

const fresh = (): ActivityState => ({ queue: [] });

describe("activity", () => {
  it("follows a run from start through tool use to settled", () => {
    const s = fresh();
    reduceActivity(s, { type: "agent_start" }, 1000);
    assert.equal(s.activity?.label, "working");
    reduceActivity(s, { type: "message_update", assistantMessageEvent: { type: "thinking_delta" } }, 2000);
    assert.equal(s.activity?.label, "thinking");
    reduceActivity(s, { type: "tool_execution_start", toolName: "bash" }, 3000);
    assert.equal(s.activity?.label, "running bash");
    reduceActivity(s, { type: "message_update", assistantMessageEvent: { type: "text_delta" } }, 4000);
    assert.equal(s.activity?.label, "writing");
    assert.equal(s.activity?.since, 1000, "elapsed counts from the start of the run, not the phase");
    reduceActivity(s, { type: "agent_settled" }, 5000);
    assert.equal(s.activity, undefined);
  });

  it("keeps the elapsed start when pi re-emits agent_start for a continued turn inside one run", () => {
    const s = fresh();
    const act = (): Activity | undefined => s.activity; // reads after TS narrows the settled assert to undefined
    reduceActivity(s, { type: "agent_start" }, 1000);
    reduceActivity(s, { type: "tool_execution_start", toolName: "bash" }, 2000);
    // a continue's agent_start (the turn a task reminder bought, a queued message, a retry): the same busy period
    reduceActivity(s, { type: "agent_start" }, 30_000);
    assert.equal(act()?.label, "running bash");
    assert.equal(act()?.since, 1000, "no restart of the timer mid-run");
    reduceActivity(s, { type: "agent_settled" }, 31_000);
    assert.equal(s.activity, undefined);
    reduceActivity(s, { type: "agent_start" }, 32_000);
    assert.equal(act()?.label, "working", "a run that starts from idle opens a fresh one");
    assert.equal(act()?.since, 32_000, "a run that starts from idle opens a fresh one");
  });

  it("shows retry and compaction as activity, not a hang", () => {
    const s = fresh();
    reduceActivity(s, { type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 4000 }, 0);
    assert.equal(s.activity?.label, "retrying (2/3) in 4s");
    reduceActivity(s, { type: "compaction_start" }, 0);
    assert.equal(s.activity?.label, "compacting context");
  });

  it("stops showing activity when a manual compaction ends, but not an automatic one", () => {
    const manual = fresh();
    reduceActivity(manual, { type: "compaction_start" }, 0);
    reduceActivity(manual, { type: "compaction_end", reason: "manual" }, 5);
    assert.equal(manual.activity, undefined);
    const auto = fresh();
    reduceActivity(auto, { type: "compaction_start" }, 0);
    reduceActivity(auto, { type: "compaction_end", reason: "threshold" }, 5);
    assert.equal(auto.activity?.label, "working");
  });

  it("replaces the queue wholesale on each queue_update", () => {
    const s = fresh();
    reduceActivity(s, { type: "queue_update", steering: ["a", "b"], followUp: [] }, 0);
    assert.deepEqual(s.queue, ["a", "b"]);
    reduceActivity(s, { type: "queue_update", steering: [], followUp: [] }, 0);
    assert.deepEqual(s.queue, []);
  });

  it("lists queued messages above the spinner line, capped", () => {
    const s: ActivityState = { queue: ["one", "two", "three", "four"], activity: { label: "thinking", since: 0 } };
    const lines = activityLines(s, 80, 65_000);
    assert.equal(lines.length, 6);
    assert.match(lines[0] as string, /queued: one/);
    assert.match(lines[3] as string, /\+1 more/);
    assert.match(lines[4] as string, /ctrl-s: send now \(stops the running step\)/, "ticket 222: the key is offered while something is queued");
    assert.match(lines[5] as string, /thinking.*1m05s/);
  });

  it("draws nothing when idle with an empty queue", () => {
    assert.deepEqual(activityLines(fresh(), 80, 0), []);
  });

  it("formats elapsed time", () => {
    assert.equal(formatElapsed(9_400), "9s");
    assert.equal(formatElapsed(125_000), "2m05s");
    assert.equal(formatElapsed(1126 * 60_000 + 4_000), "18h46m04s");
    assert.equal(formatElapsed(3_600_000), "1h00m00s");
    assert.equal(formatElapsed((26 * 3600 + 5 * 60 + 9) * 1000), "1d02h05m09s");
  });
});

describe("activity timer while a dialog is open", () => {
  const strip = (s: ActivityState, now: number) => activityLines(s, 80, now).join("\n").replace(/\x1b\[[0-9;]*m/g, "");

  it("freezes and says it is waiting on the user, then resumes without the wait", () => {
    const s = fresh();
    reduceActivity(s, { type: "agent_start" }, 0);
    assert.match(strip(s, 10_000), /working 10s/);
    s.dialog = { id: "d" };
    assert.match(strip(s, 12_000), /waiting on you 12s/);
    assert.match(strip(s, 600_000), /waiting on you 12s/, "no ticking while blocked");
    s.dialog = undefined;
    assert.match(strip(s, 605_000), /working 12s/, "the wait is not counted");
    assert.match(strip(s, 610_000), /working 17s/);
  });

  it("keeps the paused time across phase changes", () => {
    const s = fresh();
    reduceActivity(s, { type: "agent_start" }, 0);
    s.dialog = {};
    strip(s, 5_000);
    s.dialog = undefined;
    strip(s, 65_000);
    reduceActivity(s, { type: "tool_execution_start", toolName: "bash" }, 66_000);
    assert.match(strip(s, 70_000), /running bash 10s/);
  });

  it("says how to move a running shell command to the background, only for bash and not while waiting on a dialog", () => {
    const s = fresh();
    reduceActivity(s, { type: "agent_start" }, 0);
    reduceActivity(s, { type: "tool_execution_start", toolName: "bash" }, 1000);
    assert.match(strip(s, 5000), /running bash 5s\s+ctrl-b: run in background/);
    s.dialog = {};
    assert.doesNotMatch(strip(s, 6000), /ctrl-b/);
    s.dialog = undefined;
    reduceActivity(s, { type: "tool_execution_start", toolName: "read" }, 7000);
    assert.doesNotMatch(strip(s, 8000), /ctrl-b/);
  });

  it("says the same for a subagent the agent is waiting for (ticket 212)", () => {
    const s = fresh();
    reduceActivity(s, { type: "agent_start" }, 0);
    reduceActivity(s, { type: "tool_execution_start", toolName: "toriel_agent" }, 1000);
    assert.match(strip(s, 5000), /running toriel_agent 5s\s+ctrl-b: run in background/);
  });
});

describe("floorActivity (ticket 352)", () => {
  it("shows working when a run begins and the view has seen no event of it yet", () => {
    const state: ActivityState = { queue: [] };
    floorActivity(state, { streaming: true }, false, 1000);
    assert.deepEqual(state.activity, { label: "working", since: 1000 });
  });

  it("keeps what the events already say", () => {
    const state: ActivityState = { queue: [], activity: { label: "running bash", since: 5 } };
    floorActivity(state, { streaming: true }, false, 1000);
    assert.equal(state.activity?.label, "running bash");
  });

  it("trusts only the rising edge: a flag still on after the run settled brings no spinner back", () => {
    const state: ActivityState = { queue: [] };
    floorActivity(state, { streaming: true }, true, 1000);
    assert.equal(state.activity, undefined);
    floorActivity(state, { streaming: false }, false, 1000);
    assert.equal(state.activity, undefined);
  });
});
