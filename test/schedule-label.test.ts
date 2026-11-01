import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { displayScheduled, formatScheduled, parseScheduled } from "../src/schedule-label.ts";

describe("scheduled prompt labels", () => {
  it("round-trips every field", () => {
    const text = formatScheduled({ id: 3, name: "nightly", run: 4, max: 20, late: "2h" }, "check the build\nthen report");
    assert.equal(text, '[scheduled #3 "nightly", run 4/20, late 2h]: check the build\nthen report');
    assert.deepEqual(parseScheduled(text), { label: { id: 3, name: "nightly", run: 4, max: 20, late: "2h" }, prompt: "check the build\nthen report" });
  });

  it("leaves out what is not set", () => {
    const text = formatScheduled({ id: 9, run: 1 }, "x");
    assert.equal(text, "[scheduled #9, run 1]: x");
    assert.deepEqual(parseScheduled(text)?.label, { id: 9, run: 1 });
  });

  it("keeps a quote in a name from breaking the label", () => {
    assert.equal(parseScheduled(formatScheduled({ id: 1, name: 'say "hi"', run: 1 }, "p"))?.label.name, "say 'hi'");
  });

  it("does not mistake an ordinary message for a scheduled one", () => {
    assert.equal(parseScheduled("[scheduled] please run"), undefined);
    assert.equal(parseScheduled("hello"), undefined);
  });

  it("shows a transcript header over the prompt, and plain text unchanged", () => {
    assert.equal(displayScheduled('[scheduled #3 "nightly", run 4/20]: go'), "⏱ scheduled #3 nightly (run 4/20)\ngo");
    assert.equal(displayScheduled("not scheduled"), "not scheduled");
  });
});
