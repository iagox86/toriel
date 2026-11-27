// `npm run check` (ticket 340): which steps run, when the test lock is abandoned, and what the summary prints.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chooseSteps, firstLine, LOCK_STALE_MS, lockIsStale, MAX_FAILURES_SHOWN, pickLines, testSummaryLines } from "../scripts/check-lib.ts";

describe("which steps a check runs", () => {
  it("runs everything by default, only the tests for named files or a name pattern, and only the named steps when given", () => {
    assert.deepEqual(chooseSteps({}, [], undefined), ["typecheck", "lint", "tests"]);
    assert.deepEqual(chooseSteps({}, ["test/a.test.ts"], undefined), ["tests"]);
    assert.deepEqual(chooseSteps({}, [], "x"), ["tests"]);
    assert.deepEqual(chooseSteps({ lint: true, typecheck: true }, ["test/a.test.ts"], undefined), ["typecheck", "lint"]);
  });
});

describe("the test lock", () => {
  const now = 1_800_000_000_000;
  it("holds while its process lives, and is abandoned when the process is gone, the file unreadable, or it is too old", () => {
    const owner = { pid: 42, root: "/r", startedAt: now - 1000 };
    assert.equal(lockIsStale(owner, () => true, now), false);
    assert.equal(lockIsStale(owner, () => false, now), true);
    assert.equal(lockIsStale(undefined, () => true, now), true);
    assert.equal(lockIsStale({ ...owner, startedAt: now - LOCK_STALE_MS - 1 }, () => true, now), true);
  });
});

describe("the summary", () => {
  it("says ok with the counts when everything passed", () => {
    assert.deepEqual(testSummaryLines({ passed: 5, failed: 0, skipped: 1, failures: [] }, 0, 3), ["tests: ok - 5 passed, 0 failed, 1 skipped (3s)"]);
  });

  it("names each failure with its file, suites and first message line, and caps the list", () => {
    const failures = Array.from({ length: MAX_FAILURES_SHOWN + 2 }, (_, i) => ({ file: "test/a.test.ts", path: ["suite", `t${i}`], message: "1 !== 2" }));
    const lines = testSummaryLines({ passed: 1, failed: failures.length, skipped: 0, failures }, 1, 2);
    assert.equal(lines[0], `tests: FAILED - 1 passed, ${failures.length} failed (2s)`);
    assert.equal(lines[1], "  FAIL test/a.test.ts > suite > t0");
    assert.equal(lines[2], "       1 !== 2");
    assert.equal(lines.at(-1), "  ... and 2 more in the log");
  });

  it("points at the log when the runner failed without a failed test (a file crashed)", () => {
    const lines = testSummaryLines({ passed: 3, failed: 0, skipped: 0, failures: [] }, 1, 1);
    assert.match(lines[0] ?? "", /FAILED/);
    assert.match(lines[1] ?? "", /crashed/);
  });

  it("keeps only the matching lines of tool output, and the first line of a message", () => {
    assert.deepEqual(pickLines("x\nsrc/a.ts(1,2): error TS2322: no\ny", /error TS\d+/), ["src/a.ts(1,2): error TS2322: no"]);
    assert.deepEqual(pickLines("e1\ne2\ne3", /e/, 2), ["e1", "e2", "... and 1 more in the log"]);
    assert.equal(firstLine("\n  Expected values to be strictly equal:\n\n1 !== 2\n"), "Expected values to be strictly equal: 1 !== 2");
    assert.equal(firstLine("boom\n    at x"), "boom");
  });
});
