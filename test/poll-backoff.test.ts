import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PollBackoff } from "../src/poll-backoff.ts";

/** Ticks until `id` is polled again after a failed poll. */
function skipped(b: PollBackoff, id: number): number {
  let n = 0;
  while (!b.due(id)) {
    n++;
  }
  return n;
}

describe("PollBackoff", () => {
  it("polls a healthy session every tick", () => {
    const b = new PollBackoff();
    b.result(1, false);
    assert.deepEqual([b.due(1), b.due(1)], [true, true]);
  });

  it("skips more and more ticks after each failed poll, at most 8", () => {
    const b = new PollBackoff();
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      b.result(1, true);
      waits.push(skipped(b, 1));
    }
    assert.deepEqual(waits, [1, 2, 4, 8, 8, 8]);
  });

  it("polls a recovered session at once and treats sessions separately", () => {
    const b = new PollBackoff();
    b.result(1, true);
    b.result(1, true);
    assert.equal(b.due(2), true);
    b.result(1, false);
    assert.equal(b.due(1), true);
    b.result(1, true);
    assert.equal(skipped(b, 1), 1, "the wait starts over");
  });
});
