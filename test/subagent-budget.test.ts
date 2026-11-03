import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { budgetNearCap, budgetText } from "../src/subagent-budget.ts";

const f = (over: Partial<Parameters<typeof budgetText>[0]> = {}) => ({ tokens: 38_000, budget: 150_000, turns: 7, ...over });

describe("budgetText", () => {
  it("reads tokens used against the cap", () => {
    assert.equal(budgetText(f()), "budget 38.0k/150.0k");
    assert.equal(budgetText(f({ tokens: 900 })), "budget 900/150.0k");
  });

  it("adds the turn count only when the profile caps turns", () => {
    assert.equal(budgetText(f({ maxTurns: 25 })), "budget 38.0k/150.0k, turn 7/25");
  });

  it("says when its parent left nothing to spend", () => {
    assert.equal(budgetText(f({ budget: 0, tokens: 0 })), "budget none left");
  });
});

describe("budgetNearCap", () => {
  it("warns from 80% of the tokens or of the turns on", () => {
    assert.equal(budgetNearCap(f()), false);
    assert.equal(budgetNearCap(f({ tokens: 120_000 })), true);
    assert.equal(budgetNearCap(f({ maxTurns: 25, turns: 19 })), false);
    assert.equal(budgetNearCap(f({ maxTurns: 25, turns: 20 })), true);
    assert.equal(budgetNearCap(f({ budget: 0 })), true);
  });
});
