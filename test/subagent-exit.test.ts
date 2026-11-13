import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { abnormalEnd } from "../src/subagents.ts";
import { briefReason, exitNote, scrubSecrets, stderrTail, verbLine } from "../src/subagent-exit.ts";

describe("exitNote", () => {
  it("names the code, or the signal when there is one", () => {
    assert.equal(exitNote(1, null), "its process exited (code 1)");
    assert.equal(exitNote(null, "SIGKILL"), "its process exited (signal SIGKILL)");
    assert.equal(exitNote(null, null), "its process exited (no exit code)");
  });

  it("appends a one-line stderr tail", () => {
    assert.equal(exitNote(1, null, "boom\n  at x"), "its process exited (code 1): boom at x");
  });
});

describe("stderrTail", () => {
  it("keeps the end of a long stderr and marks the cut", () => {
    const tail = stderrTail(`${"a".repeat(500)}END`);
    assert.ok(tail.startsWith("..."));
    assert.ok(tail.endsWith("END"));
    assert.ok(tail.length <= 203);
  });

  it("is empty without stderr", () => {
    assert.equal(stderrTail(undefined), "");
    assert.equal(stderrTail("  \n "), "");
  });

  it("scrubs credentials before they reach a parent's context", () => {
    const tail = stderrTail("ANTHROPIC_API_KEY=sk-abcdef123456789 Authorization: Bearer abc.def-ghi failed; token: hunter2");
    assert.doesNotMatch(tail, /abcdef123456789|abc\.def|hunter2/);
    assert.match(tail, /failed/);
  });
});

describe("scrubSecrets", () => {
  it("leaves ordinary text alone", () => {
    assert.equal(scrubSecrets("TypeError: x is not a function (a=1)"), "TypeError: x is not a function (a=1)");
  });
});

describe("verbLine", () => {
  it("says what happened, and why when it was not a normal finish", () => {
    assert.equal(verbLine("done", undefined), "finished");
    assert.equal(verbLine("done", "ignored"), "finished");
    assert.equal(verbLine("stopped", "its parent cancelled the call"), "was cut short (its parent cancelled the call)");
    assert.equal(verbLine("failed", "its process exited (code 1): boom"), "failed (its process exited (code 1))");
    assert.equal(verbLine("stopped", undefined), "was cut short");
  });

  it("keeps the first line short", () => {
    assert.ok(briefReason(`${"x".repeat(200)}: more`).length <= 80);
  });
});

describe("abnormalEnd on the aborted path", () => {
  it("prefers pi's error text when there is one", () => {
    assert.deepEqual(abnormalEnd("aborted", "429 rate limited"), { state: "stopped", note: "was aborted: 429 rate limited" });
  });

  it("says no stop was requested otherwise", () => {
    const r = abnormalEnd("aborted", undefined);
    assert.equal(r?.state, "stopped");
    assert.match(r?.note ?? "", /no stop was requested/);
  });
});
