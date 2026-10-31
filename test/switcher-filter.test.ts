import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Host } from "../src/host.ts";
import { SwitcherFilter } from "../src/switcher-filter.ts";

/** Just the parts of the host the filter touches. */
function fixture() {
  const log = { refreshes: 0, chromes: 0, text: "" };
  const editor = {
    onChange: undefined as ((t: string) => void) | undefined,
    setText: (t: string) => {
      log.text = t;
    },
  };
  const switcher = { hint: "", moved: 0, move: (d: number) => {
      switcher.moved += d;
    },
  };
  const host = { editor, switcher, tui: { requestRender: () => {} }, renderChrome: () => void log.chromes++ } as unknown as Host;
  const filter = new SwitcherFilter(host, () => void log.refreshes++);
  return { filter, editor, switcher, log };
}

describe("SwitcherFilter", () => {
  it("sets a filter from text, redrawing the list and the status line", () => {
    const { filter, log } = fixture();
    assert.equal(filter.set("mealie", false), undefined);
    assert.equal(filter.current?.text, "mealie");
    assert.deepEqual([log.refreshes, log.chromes], [1, 1]);
  });

  it("reports a bad regex and keeps the previous filter", () => {
    const { filter } = fixture();
    filter.set("keep", false);
    assert.match(filter.set("(", true) ?? "", /./);
    assert.equal(filter.current?.text, "keep");
  });

  it("clears the filter and live mode, and gives the box's change hook back", () => {
    const { filter, editor } = fixture();
    filter.startLive();
    assert.ok(filter.live && editor.onChange);
    filter.clear();
    assert.equal(filter.current, null);
    assert.equal(filter.live, false);
    assert.equal(editor.onChange, undefined);
  });

  it("filters as text is typed in live mode, and ignores a half-typed flag", () => {
    const { filter, editor } = fixture();
    filter.startLive();
    editor.onChange?.("alpha");
    assert.equal(filter.current?.text, "alpha");
    editor.onChange?.("beta --regex");
    assert.equal(filter.current?.regex, true);
    editor.onChange?.('"unterminated');
    assert.equal(filter.current?.text, "beta", "a quote that is not closed yet keeps what is shown");
  });

  it("keeps the filter but ends live mode on enter, and drops it on escape", () => {
    const { filter, editor, log } = fixture();
    filter.startLive();
    editor.onChange?.("alpha");
    assert.equal(filter.liveKeys("\r"), true);
    assert.equal(filter.live, false);
    assert.equal(filter.current?.text, "alpha");
    assert.equal(log.text, "");
    filter.startLive();
    assert.equal(filter.liveKeys("\x1b"), true);
    assert.equal(filter.current, null);
  });

  it("leaves other keys to the editor in live mode", () => {
    const { filter } = fixture();
    filter.startLive();
    assert.equal(filter.liveKeys("a"), false);
  });
});
