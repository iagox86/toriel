import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { modeOf, nextMode, switches } from "../src/mode-cycle.ts";

describe("mode cycle (ticket 233)", () => {
  it("names the mode a session is in, plan outranking auto", () => {
    assert.equal(modeOf({}), "normal");
    assert.equal(modeOf({ auto: true }), "auto");
    assert.equal(modeOf({ plan: true }), "plan");
    assert.equal(modeOf({ auto: true, plan: true }), "plan");
  });

  it("goes normal, auto, plan, normal", () => {
    assert.equal(nextMode({ sessionId: "u" }), "auto");
    assert.equal(nextMode({ sessionId: "u", auto: true }), "plan");
    assert.equal(nextMode({ sessionId: "u", plan: true }), "normal");
  });

  it("skips plan for a session with no id yet", () => {
    assert.equal(nextMode({ auto: true }), "normal");
    assert.equal(nextMode({}), "auto");
  });

  it("changes only the flags that differ, plan first", () => {
    assert.deepEqual(switches({}, "auto"), [{ flag: "auto", on: true }]);
    assert.deepEqual(switches({ auto: true }, "plan"), [
      { flag: "plan", on: true },
      { flag: "auto", on: false },
    ]);
    assert.deepEqual(switches({ plan: true }, "normal"), [{ flag: "plan", on: false }]);
    assert.deepEqual(switches({ auto: true, plan: true }, "normal"), [
      { flag: "plan", on: false },
      { flag: "auto", on: false },
    ]);
    assert.deepEqual(switches({ auto: true }, "auto"), []);
  });
});
