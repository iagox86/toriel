import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UserMessage } from "../src/components.ts";
import { visibleFenceInfo } from "../src/fence-info.ts";
import { fenceBorder, mdTheme } from "../src/pi-theme.ts";

const known = (name: string) => ["python", "js", "sh"].includes(name);
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("visibleFenceInfo", () => {
  it("hides a bare fence and a single known language, aliases included", () => {
    assert.equal(visibleFenceInfo("", known), undefined);
    assert.equal(visibleFenceInfo("python", known), undefined);
    assert.equal(visibleFenceInfo("js", known), undefined);
  });

  it("hides the names that mean plain text, whatever the case", () => {
    for (const name of ["text", "TXT", "console", "output", "mermaid"]) {
      assert.equal(visibleFenceInfo(name, () => false), undefined, name);
    }
  });

  it("shows text that is not a language, trimmed", () => {
    assert.equal(visibleFenceInfo("this is the first line, not a language line", known), "this is the first line, not a language line");
    assert.equal(visibleFenceInfo("  oops  ", known), "oops");
  });

  it("shows several words even when the first one is a language", () => {
    assert.equal(visibleFenceInfo("python title=\"app.py\"", known), "python title=\"app.py\"");
    assert.equal(visibleFenceInfo("go for it", () => true), "go for it");
  });
});

describe("fence lines in rendered messages", () => {
  it("keeps the text on a fence line that is not a language, above the code", () => {
    const text = "```this is the first line, not a language line\nAnd this is another line\n```";
    const out = new UserMessage(text, mdTheme as never, 1).render(80).map(strip).join("\n");
    assert.match(out, /this is the first line, not a language line/);
    assert.match(out, /And this is another line/);
    assert.doesNotMatch(out, /```/);
  });

  it("still hides the fence line of a real language", () => {
    const out = new UserMessage("```python\nprint(1)\n```", mdTheme as never, 1).render(80).map(strip).join("\n");
    assert.doesNotMatch(out, /python/);
    assert.match(out, /print/);
  });

  it("turns a closing fence and a bare opening fence into the mark that components drop", () => {
    assert.equal(strip(fenceBorder("```")), strip(fenceBorder("```")));
    assert.ok(fenceBorder("```").includes("toriel-fence"));
    assert.ok(!fenceBorder("```not a language").includes("toriel-fence"));
  });
});
