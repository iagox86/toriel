import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { END_OF_RUN_CALLS, GoalNudges, MID_RUN_CALLS, reminderText, TOOL_NAME } from "../pi/extensions/lib/goal-nudge.ts";
import { MID_RUN_CALLS as TASK_MID_RUN, END_OF_RUN_CALLS as TASK_END_OF_RUN } from "../pi/extensions/lib/task-nudge.ts";

const GOAL = "fix the flaky build";
const g = () => new GoalNudges();

describe("reminderText", () => {
  it("names the goal and the tool, and defers to a goal already done", () => {
    const text = reminderText(GOAL);
    assert.match(text, new RegExp(`"${GOAL}"`));
    assert.match(text, new RegExp(TOOL_NAME));
    assert.match(text, /already marked done, ignore this reminder/);
  });
});

describe("GoalNudges", () => {
  it("reuses the task-nudge thresholds, so both reminders share a cadence", () => {
    assert.equal(MID_RUN_CALLS, TASK_MID_RUN);
    assert.equal(END_OF_RUN_CALLS, TASK_END_OF_RUN);
  });

  it("announces the goal at the first tool call, then keeps the MID_RUN_CALLS cadence", () => {
    const n = g();
    n.setGoal({ text: GOAL });
    const at: number[] = [];
    for (let i = 1; i <= 1 + MID_RUN_CALLS * 2; i++) {
      if (n.afterToolCall("bash")) {
        at.push(i);
      }
    }
    assert.deepEqual(at, [1, 1 + MID_RUN_CALLS, 1 + MID_RUN_CALLS * 2]);
  });

  it("re-announces at once when the goal's text changes, but not on a refetch of the same text", () => {
    const n = g();
    n.setGoal({ text: GOAL });
    n.afterToolCall("bash"); // announced
    n.setGoal({ text: "ship the fix" });
    assert.match(n.afterToolCall("bash") ?? "", /"ship the fix"/, "a changed goal is announced at once");
    n.setGoal({ text: "ship the fix" });
    assert.equal(n.afterToolCall("bash"), undefined, "the same text again is not news");
  });

  it("does not nudge a run that did no work, even one that follows busy runs", () => {
    const n = g();
    n.setGoal({ text: GOAL });
    for (let i = 0; i < MID_RUN_CALLS * 3; i++) {
      n.afterToolCall("bash");
    }
    assert.match(n.beforeRunEnds(false) ?? "", new RegExp(`"${GOAL}"`), "this run's work earns the turn");
    n.runStarted();
    assert.equal(n.beforeRunEnds(false), undefined, "a new run with zero tool calls is left alone");
  });

  it("is silent without a goal, and after one is marked done", () => {
    const none = g();
    none.setGoal(null);
    for (let i = 0; i < MID_RUN_CALLS * 2; i++) {
      assert.equal(none.afterToolCall("bash"), undefined);
    }
    const done = g();
    done.setGoal({ text: GOAL, done: true });
    assert.equal(done.afterToolCall("bash"), undefined);
    const open = g();
    open.setGoal({ text: GOAL });
    for (let i = 0; i < MID_RUN_CALLS; i++) {
      open.afterToolCall("bash");
    }
    open.markedDone();
    assert.equal(open.afterToolCall("bash"), undefined);
  });

  it("does not count a toriel_goal call, since the tool already stopped the nudging", () => {
    const n = g();
    n.setGoal({ text: GOAL });
    for (let i = 0; i < MID_RUN_CALLS - 1; i++) {
      n.afterToolCall("bash");
    }
    assert.equal(n.afterToolCall(TOOL_NAME), undefined);
    n.markedDone();
    assert.equal(n.afterToolCall("bash"), undefined, "the goal is done, so nothing more is said");
  });

  it("asks for one more turn at the end of a run with work done, at most once, and not when aborted", () => {
    const n = g();
    n.setGoal({ text: GOAL });
    for (let i = 0; i < END_OF_RUN_CALLS - 1; i++) {
      n.afterToolCall("bash");
    }
    assert.equal(n.beforeRunEnds(false), undefined, "no real work yet");
    n.afterToolCall("bash");
    const first = n.beforeRunEnds(false);
    assert.match(first ?? "", new RegExp(`"${GOAL}"`));
    assert.equal(n.beforeRunEnds(false), undefined, "once per run");
    n.runStarted();
    n.afterToolCall("bash");
    n.afterToolCall("bash");
    n.afterToolCall("bash");
    assert.equal(n.beforeRunEnds(true), undefined, "an aborted run is not given a turn (fresh run, enough calls)");
    assert.match(n.beforeRunEnds(false) ?? "", new RegExp(`"${GOAL}"`), "a non-aborted run of the same work gets its own turn");
  });

  it("resets the cadence when the goal changes", () => {
    const n = g();
    n.setGoal({ text: GOAL });
    for (let i = 0; i < MID_RUN_CALLS; i++) {
      n.afterToolCall("bash");
    }
    n.setGoal({ text: "ship the fix" });
    assert.match(n.afterToolCall("bash") ?? "", /"ship the fix"/, "a changed goal announces at once");
    for (let i = 0; i < MID_RUN_CALLS - 2; i++) {
      n.afterToolCall("bash");
    }
    assert.equal(n.afterToolCall("bash"), undefined, "MID_RUN_CALLS calls are still owed after the announce");
    assert.match(n.afterToolCall("bash") ?? "", /"ship the fix"/, "the cadence restarts from the announce");
  });
});
