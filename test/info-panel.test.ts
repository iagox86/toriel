import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Component, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { getScrollViewsAt, renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { InfoPanel, wrapHanging } from "../src/info-panel.ts";
import { listing } from "../src/cli.ts";
import { SESSION_COMMANDS } from "../src/commands.ts";
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

  describe("two-column rows (the /help listing)", () => {
    const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
    const row = "/btw [options] <question...>   ask a side question about this session; the answer pops up and the session never sees it";

    it("hangs a long description under its own column, not under the name", () => {
      const lines = wrapHanging(row, 80);
      assert.ok(lines.length > 1);
      const col = lines[0]?.indexOf("ask a side") as number;
      assert.ok(col > 10);
      for (const l of lines.slice(1)) {
        assert.ok(l.startsWith(" ".repeat(col)) && l[col] !== " ", l);
      }
      assert.ok(lines.every((l) => l.length <= 80));
    });

    it("finds the column by visible position when the row is styled", () => {
      const styled = `\x1b[36m/btw\x1b[0m \x1b[2m[options] <question...>\x1b[0m   ask a side question about this session; the answer pops up and the session never sees it`;
      const lines = wrapHanging(styled, 80);
      const plain = lines.map(strip);
      assert.ok(plain.length > 1);
      const col = plain[0]?.indexOf("ask a side") as number;
      assert.ok(plain.slice(1).every((l) => l.startsWith(" ".repeat(col)) && l[col] !== " "), plain.join("|"));
      assert.ok(lines[0]?.includes("\x1b[36m/btw"), "the name keeps its style");
    });

    it("keeps the description's open style on the rows it wraps onto", () => {
      const lines = wrapHanging(`/x   \x1b[2m${"word ".repeat(30)}\x1b[0m`, 60);
      assert.ok(lines.length > 1);
      assert.ok(lines.slice(1).every((l) => l.includes("\x1b[2m")), lines.join("|"));
    });

    it("keeps every real /help row's description out of the next row's name column", () => {
      const rows = listing(SESSION_COMMANDS).split("\n");
      const out = rows.flatMap((r) => wrapHanging(r, 80));
      assert.ok(out.length > rows.length, "some descriptions wrap at 80 columns");
      assert.equal(out.filter((l) => /^ \//.test(l)).length, rows.filter((r) => r.startsWith("/")).length, "a row starts at the name column only for a real row");
      assert.ok(out.every((l) => l.length <= 80));
    });

    it("leaves a row that fits alone", () => {
      assert.deepEqual(wrapHanging("/exit    leave toriel", 80), [" /exit    leave toriel"]);
    });

    it("falls back to the old hang when the column leaves too little room", () => {
      const lines = wrapHanging(row, 40);
      assert.ok(lines.length > 1);
      assert.ok(lines.slice(1).every((l) => l.startsWith(" ") && !l.startsWith("  ")), lines.join("|"));
    });

    it("hangs Options rows of a per-command page under their description", () => {
      const lines = wrapHanging("  -l, --list    show every session that matches the name given and nothing else at all", 60);
      const col = lines[0]?.indexOf("show every") as number;
      assert.ok(lines.length > 1 && lines.slice(1).every((l) => l.startsWith(" ".repeat(col)) && l[col] !== " "), lines.join("|"));
    });

    it("does not treat prose with a double space as columns unless it must wrap, and then only with room", () => {
      const lines = wrapHanging("Sentence one.  Sentence two is a good deal longer than the others and wraps.", 40);
      assert.ok(lines.length > 1);
      assert.ok(lines.every((l) => l.length <= 40));
    });
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
    assert.match(all.replace(/\s+/g, " "), /esc or enter closes/, "the footer may wrap, but it is all there");
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

  it("wraps a long footer inside the box instead of running past its edge", () => {
    const panel = new InfoPanel();
    panel.show("answer", [{ key: "c", label: "copies it to the clipboard", run: () => {} }, { key: "s", label: "saves it to a file", run: () => {} }, { key: "f", label: "opens the file", run: () => {} }]);
    const rows = panel.footerLines(40).map((r) => stripTerminalSequences(r));
    assert.ok(rows.length > 3, "the hint takes more than one row");
    assert.ok(rows.every((r) => visibleWidth(r) <= 40), rows.join("|"));
    assert.match(rows.join(" "), /esc or enter closes/);
  });

  it("keeps the wheel inside the popup at its top and bottom", () => {
    const scroller = (new InfoPanel() as unknown as { scroller: { overscroll: string } }).scroller;
    assert.equal(scroller.overscroll, "contain");
  });
});
