import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import { getScrollViewsAt, renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { InfoPanel, wrapHanging } from "../src/info-panel.ts";
import { buildLayouts } from "../src/layout.ts";

describe("info panel wrapping", () => {
  const long = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda";

  it("keeps the gutter on every line of a wrapped paragraph", () => {
    const lines = wrapHanging(long, 24);
    assert.ok(lines.length > 1);
    assert.ok(lines.every((l) => l.startsWith(" ") && !l.startsWith("  ")), lines.join("|"));
  });

  it("wraps indented text under its own indent", () => {
    const lines = wrapHanging(`    ${long}`, 30);
    assert.ok(lines.length > 1);
    assert.ok(lines.every((l) => l.startsWith("     ") && !l.startsWith("      ")), lines.join("|"));
  });

  it("hangs a bullet's continuation lines under its text", () => {
    const lines = wrapHanging(`  - ${long}`, 30);
    assert.ok(lines[0]?.startsWith("   - alpha"));
    assert.ok(lines.slice(1).every((l) => l.startsWith("     ") && !l.startsWith("      ")), lines.join("|"));
  });

  it("leaves short lines and blank lines alone", () => {
    assert.deepEqual(wrapHanging("short", 40), [" short"]);
    assert.deepEqual(wrapHanging("", 40), [" "]);
  });
});

describe("info panel taller than the screen", () => {
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const text = (line: string): Component => ({ render: () => [line], invalidate: () => {} });
  const nothing: Component = { render: () => [], invalidate: () => {} }; // a panel that is closed takes no rows
  const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

  /** The chat layout at 60x16 with `panel` docked in it, as the screen would draw it. */
  function screen(panel: InfoPanel, height = 16): string[] {
    return frame(panel, height).lines.map(strip);
  }

  function frame(panel: InfoPanel, height = 16): ReturnType<typeof renderLayoutFrame> {
    const { chat } = buildLayouts({
      editor: text("EDITOR"),
      statusLine: text("STATUS"),
      scroll: text("CHAT"),
      activityLine: nothing,
      rewindPicker: nothing,
      dialogPanel: nothing,
      infoPanel: panel,
      choicePanel: nothing,
      banner: nothing,
      scheduleStrip: nothing,
      switcher: text("switcher"),
      dialogOpen: () => false,
    });
    // first frame lets the scroll view learn its height; the second is what the user sees
    renderLayoutFrame(chat, 60, height, () => {});
    return renderLayoutFrame(chat, 60, height, () => {});
  }

  it("fits the screen, keeping the editor, the footer and the first lines visible", () => {
    const panel = new InfoPanel();
    panel.show(numbered(60));
    const lines = screen(panel);
    assert.equal(lines.length, 16);
    const all = lines.join("\n");
    assert.match(all, /EDITOR/);
    assert.match(all, /line 1\b/);
    assert.doesNotMatch(all, /line 60\b/);
    assert.match(all, /esc or enter closes/);
    assert.match(all, /more below/);
    assert.doesNotMatch(all, /more above/);
  });

  it("scrolls with the arrow, page, home and end keys, and says what is hidden", () => {
    const panel = new InfoPanel();
    panel.show(numbered(60));
    screen(panel);
    assert.equal(panel.scrollKey("\x1b[B"), true, "down");
    assert.doesNotMatch(screen(panel).join("\n"), /line 1\b/);
    assert.match(screen(panel).join("\n"), /more above and more below/);
    assert.equal(panel.scrollKey("\x1b[6~"), true, "page down");
    assert.equal(panel.scrollKey("\x1b[F"), true, "end");
    const end = screen(panel).join("\n");
    assert.match(end, /line 60\b/);
    assert.match(end, /more above/);
    assert.doesNotMatch(end, /more below/);
    assert.equal(panel.scrollKey("\x1b[H"), true, "home");
    assert.match(screen(panel).join("\n"), /line 1\b/);
  });

  it("scrolls under the mouse wheel when the pointer is over it, and not when it is elsewhere", () => {
    const panel = new InfoPanel();
    panel.show(numbered(60));
    const f = frame(panel);
    const row = f.lines.findIndex((l) => strip(l).includes("line 2"));
    const over = getScrollViewsAt(f, 5, row);
    assert.ok(over.length > 0, "a scroll view sits under the panel text");
    over[0]?.scrollBy(3);
    const after = screen(panel).join("\n");
    assert.doesNotMatch(after, /line 1\b/);
    assert.match(after, /more above and more below/);
    assert.equal(getScrollViewsAt(f, 5, 0).length, 0, "nothing scrolls over the chat stub");
  });

  it("leaves other keys for the caller, which closes the panel on them", () => {
    const panel = new InfoPanel();
    panel.show("a\nb");
    assert.equal(panel.scrollKey("x"), false);
    assert.equal(panel.scrollKey("\r"), false);
  });

  it("shows a short panel in full with no scroll hint, and starts at the top when shown again", () => {
    const panel = new InfoPanel();
    panel.show(numbered(3));
    const all = screen(panel).join("\n");
    assert.match(all, /line 3\b/);
    assert.doesNotMatch(all, /more below|more above/);
    panel.show(numbered(60));
    panel.scrollKey("\x1b[F");
    screen(panel);
    panel.show(numbered(60));
    assert.match(screen(panel).join("\n"), /line 1\b/);
  });
});

describe("a closed info panel", () => {
  const tall = (name: string): Component => ({ render: () => Array.from({ length: 60 }, (_, i) => `${name} ${i}`), invalidate: () => {} });
  const nothing: Component = { render: () => [], invalidate: () => {} };
  const stub = (line: string): Component => ({ render: () => [line], invalidate: () => {} });

  function layouts(panel: InfoPanel) {
    return buildLayouts({
      editor: stub("EDITOR"),
      statusLine: stub("STATUS"),
      scroll: tall("chat"),
      activityLine: nothing,
      rewindPicker: nothing,
      dialogPanel: nothing,
      infoPanel: panel,
      choicePanel: nothing,
      banner: nothing,
      scheduleStrip: nothing,
      switcher: tall("list"),
      dialogOpen: () => false,
    });
  }

  it("leaves no gap between the chat and the input", () => {
    const { chat } = layouts(new InfoPanel());
    const lines = renderLayoutFrame(chat, 60, 20, () => {}).lines;
    const editor = lines.indexOf("EDITOR");
    assert.ok(editor > 0);
    assert.match(lines[editor - 1] ?? "", /chat \d+/, lines.join("|"));
  });

  it("leaves no gap between the session list and the input", () => {
    const { switcher } = layouts(new InfoPanel());
    const lines = renderLayoutFrame(switcher, 60, 20, () => {}).lines;
    const editor = lines.indexOf("EDITOR");
    assert.ok(editor > 0);
    assert.match(lines[editor - 1] ?? "", /list \d+/, lines.join("|"));
  });

  it("takes the rows back after it was shown and closed", () => {
    const panel = new InfoPanel();
    const { chat } = layouts(panel);
    panel.show("a\nb");
    renderLayoutFrame(chat, 60, 20, () => {});
    panel.close();
    const lines = renderLayoutFrame(chat, 60, 20, () => {}).lines;
    assert.match(lines[lines.indexOf("EDITOR") - 1] ?? "", /chat \d+/);
  });
});

describe("info panel actions", () => {
  it("runs the action for its key, closes, and ignores other keys", () => {
    const panel = new InfoPanel();
    const ran: string[] = [];
    panel.show("answer", [{ key: "c", label: "copies", run: () => ran.push("c") }]);
    assert.equal(panel.act("x"), false);
    assert.ok(panel.isOpen);
    assert.equal(panel.act("c"), true);
    assert.deepEqual(ran, ["c"]);
    assert.equal(panel.isOpen, false);
  });

  it("lists the keys in the footer", () => {
    const panel = new InfoPanel();
    panel.show("answer", [{ key: "s", label: "saves", run: () => {} }]);
    assert.match(panel.render(60).join("\n"), /s saves - esc or enter closes/);
  });
});
