import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { repairFences } from "../src/fence-repair.ts";

describe("repairFences", () => {
  it("drops backticks from the remark after an opening fence so the block can render", () => {
    assert.equal(repairFences("```Pushback on `docs/x.md` here\ncode\n```"), "```Pushback on docs/x.md here\ncode\n```");
  });

  it("leaves well-formed fences and plain text alone", () => {
    for (const text of ["```ruby\nputs 1\n```", "no fences `here`", "```\nx\n```\n\n```js\ny\n```"]) {
      assert.equal(repairFences(text), text);
    }
  });

  it("leaves inline triple-backtick code spans alone", () => {
    assert.equal(repairFences("```a `b` c``` is a span"), "```a `b` c``` is a span");
  });

  it("does not touch a fence-looking line inside a real fence", () => {
    const text = "```text\n```not a `fence`\n```";
    assert.equal(repairFences(text), text);
  });

  it("keeps the indent and a longer fence", () => {
    assert.equal(repairFences("  ````x `y`\nbody\n````"), "  ````x y\nbody\n````");
  });

  it("repairs CRLF text the same way and keeps every line ending", () => {
    assert.equal(repairFences("```Pushback on `x`\r\nbody\r\n```\r\n"), "```Pushback on x\r\nbody\r\n```\r\n");
    assert.equal(repairFences("```a\r\n```b `c`\r\n```"), "```a\r\n```b `c`\r\n```");
  });

  it("moves a fence that ends a line of prose onto its own line, so both fences are handled (ticket 134)", () => {
    assert.equal(repairFences("starts on a line, like ```\nthis is some code\n```\n\ntrailing"), "starts on a line, like\n```\nthis is some code\n```\n\ntrailing");
    assert.equal(repairFences("like ```\r\ncode\r\n```\r\n"), "like\n```\r\ncode\r\n```\r\n");
  });

  it("leaves inline code spans with triple backticks, and fences inside a block, alone", () => {
    assert.equal(repairFences("use ```x``` here"), "use ```x``` here");
    assert.equal(repairFences("a ```b``` ```"), "a ```b``` ```");
    assert.equal(repairFences("```\nlike ```\n```"), "```\nlike ```\n```");
  });

  it("does not touch a backtick fence line inside a tilde fence, and a tilde line does not close a backtick fence", () => {
    assert.equal(repairFences("~~~\n```x `y`\n~~~"), "~~~\n```x `y`\n~~~");
    assert.equal(repairFences("```a\n~~~\n```b `c`\n```"), "```a\n~~~\n```b `c`\n```");
  });
});
