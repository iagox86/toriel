// Goal changes as transcript lines (ticket 348): the wording, what counts as a change, and where a line goes among the items.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GoalEvent } from "../src/goals.ts";
import { changedGoals, goalLineText, placeGoalLines, sameGoalEvents } from "../src/goal-lines.ts";

describe("goal lines (ticket 348)", () => {
  it("says what happened to the goal, and who finished it when it was the agent", () => {
    assert.equal(goalLineText({ kind: "set", text: "fix the build", at: 1 }), "goal set: fix the build");
    assert.equal(goalLineText({ kind: "done", text: "fix the build", at: 2, by: "user" }), "goal done: fix the build");
    assert.equal(goalLineText({ kind: "done", text: "fix the build", at: 2, by: "agent" }), "goal done: fix the build (marked by the agent)");
    assert.equal(goalLineText({ kind: "cleared", text: "fix the build", at: 3 }), "goal cleared: fix the build");
  });

  it("counts a new goal, a re-set of the same text, a done and a cleared goal as changes, and nothing else", () => {
    const prev = { a: { text: "x", done: false, at: 1 }, b: { text: "y", done: false, at: 1 }, c: { text: "z", done: false, at: 1 }, d: { text: "w", done: false, at: 1 } };
    const next = { a: { text: "x", done: false, at: 1 }, b: { text: "y", done: false, at: 5 }, c: { text: "z", done: true, at: 6 }, e: { text: "new", done: false, at: 7 } };
    assert.deepEqual(changedGoals(prev, next).sort(), ["b", "c", "d", "e"]);
    assert.deepEqual(changedGoals(next, next), []);
  });

  it("places each line before the first item stamped later, after unstamped ones, and replaces the lines of an earlier placement", () => {
    type T = { name: string; at?: number; goalLine?: boolean };
    const items: T[] = [{ name: "u1", at: 10 }, { name: "nostamp" }, { name: "a1", at: 20 }, { name: "u2", at: 30 }];
    const row = (e: { kind: string; at: number }): T => ({ name: `${e.kind}@${e.at}` });
    const once = placeGoalLines(items, [{ kind: "done", text: "g", at: 25 }, { kind: "set", text: "g", at: 15 }, { kind: "cleared", text: "g", at: 99 }], row);
    assert.deepEqual(once.map((i) => i.name), ["u1", "nostamp", "set@15", "a1", "done@25", "u2", "cleared@99"]);
    const again = placeGoalLines(once, [{ kind: "set", text: "g", at: 5 }], row);
    assert.deepEqual(again.map((i) => i.name), ["set@5", "u1", "nostamp", "a1", "u2"], "the old lines go, the new ones come");
    assert.deepEqual(placeGoalLines(again, [], row).map((i) => i.name), ["u1", "nostamp", "a1", "u2"]);
    assert.equal(items.length, 4, "the input is not changed");
  });

  it("compares two event lists by field, so an unchanged refetch can skip the rebuild (ticket 348)", () => {
    const a: GoalEvent[] = [
      { kind: "set", text: "g", at: 1 },
      { kind: "done", text: "g", at: 2, by: "agent" },
    ];
    assert.equal(sameGoalEvents(a, [...a]), true, "identity not required");
    assert.equal(sameGoalEvents(a, a.slice()), true);
    assert.equal(sameGoalEvents(a, [{ kind: "set", text: "g", at: 1 }, { kind: "done", text: "g", at: 2, by: "user" }]), false);
    assert.equal(sameGoalEvents(a, [{ kind: "done", text: "g", at: 2, by: "agent" }, { kind: "set", text: "g", at: 1 }]), false);
    assert.equal(sameGoalEvents(a, [{ kind: "set", text: "g", at: 1 }]), false);
    assert.equal(sameGoalEvents([], []), true);
  });
});
