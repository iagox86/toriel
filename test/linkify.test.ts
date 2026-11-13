import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { linkifyLine, linkifyLines } from "../src/linkify.ts";

const link = (url: string, text = url) => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;

describe("linkifyLine", () => {
  it("wraps a bare URL in an OSC 8 link and leaves the text alone", () => {
    const out = linkifyLine("see https://example.com/a?b=1#c now", 80);
    assert.equal(out, `see ${link("https://example.com/a?b=1#c")} now`);
    assert.equal(stripTerminalSequences(out), "see https://example.com/a?b=1#c now");
  });

  it("keeps sentence punctuation outside the link", () => {
    assert.equal(linkifyLine("go to https://example.com.", 80), `go to ${link("https://example.com")}.`);
    assert.equal(linkifyLine("(https://example.com/x)", 80), `(${link("https://example.com/x")})`);
    assert.equal(linkifyLine("it is https://example.com/a,", 80), `it is ${link("https://example.com/a")},`);
  });

  it("keeps a closing bracket that matches one inside the URL", () => {
    assert.equal(linkifyLine("https://en.wikipedia.org/wiki/Foo_(bar) ok", 80), `${link("https://en.wikipedia.org/wiki/Foo_(bar)")} ok`);
  });

  it("links several URLs on one line", () => {
    const out = linkifyLine("https://a.test/1 and https://b.test/2", 80);
    assert.equal(out, `${link("https://a.test/1")} and ${link("https://b.test/2")}`);
  });

  it("links a URL inside styled text and keeps the styling", () => {
    const out = linkifyLine("\x1b[2mopen https://example.com/x here\x1b[22m", 80);
    assert.equal(out, `\x1b[2mopen ${link("https://example.com/x")} here\x1b[22m`);
  });

  it("leaves a line that already carries a hyperlink alone (no double wrapping)", () => {
    const already = `see ${link("https://example.com", "the docs")} or https://other.test/x`;
    assert.equal(linkifyLine(already, 80), already);
  });

  it("does not link a URL that runs to the last column: it may continue on the next line", () => {
    const line = "x https://example.com/abcdef";
    assert.equal(linkifyLine(line, line.length), line);
    assert.notEqual(linkifyLine(line, line.length + 5), line);
  });

  it("does not link a URL whose tail is cut off by a style change", () => {
    const line = "https://example.com/ab\x1b[1mcd\x1b[22m";
    assert.equal(linkifyLine(line, 80), line);
  });

  it("ignores lines with no URL, other schemes and bare hosts", () => {
    for (const l of ["plain text", "ftp://example.com/x", "example.com/x", "http://", "https://."]) {
      assert.equal(linkifyLine(l, 80), l);
    }
  });
});

describe("linkifyLines", () => {
  it("maps every line", () => {
    assert.deepEqual(linkifyLines(["a", "https://example.com/x"], 80), ["a", link("https://example.com/x")]);
  });
});
