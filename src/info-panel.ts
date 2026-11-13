// A docked, dismissable text panel for multi-line command output (--help,
// /help). Shares the popup look of the dialog and rewind panels. It is a small
// stack of its own (padding, a ScrollView holding the text, the footer), so the
// layout engine can shrink the text to the screen and the user scrolls it: the
// padding and the footer with its keys always stay in view.
import type { Component, KeyId } from "@earendil-works/pi-tui";
import { Key, matchesKey, ScrollView, visibleWidth, VStack, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { dim, panelInnerWidth, panelRowPainter } from "./theme.ts";

export interface PanelAction {
  key: string;
  label: string;
  run: () => void;
}

/** A line's own indent and list marker ("  - ", "1. "), which wrapped lines hang under. */
const LEADING = /^( *)((?:[-*] |\d+[.)] )?)/;

/** Least width a hung description column may leave for its text; narrower and the row wraps the old way. */
const MIN_DESCRIPTION_ROOM = 20;

/** The escape sequences the width math skips: CSI (colours) and OSC (links, ended by BEL or ST). */
const ESCAPE = /^(?:\x1b\[[0-9;:?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))/;

/**
 * Split a "name  description" row at its first run of two or more spaces between
 * visible characters. `col` is the visible column where the description starts;
 * `before` is the text up to the run (styles intact), `after` the description
 * with the styles that were still open at the split restored. The run is found
 * by visible position, because styled rows carry escapes that shift string indexes.
 */
export function splitColumns(row: string): { before: string; after: string; col: number } | undefined {
  let visible = 0;
  let spaces = 0;
  let runStart = -1; // string index where the current run of spaces began
  let seenText = false;
  let open: string[] = []; // sequences since the last reset
  for (let i = 0; i < row.length; ) {
    const esc = ESCAPE.exec(row.slice(i));
    if (esc) {
      open = /^\x1b\[0?m$/.test(esc[0]) ? [] : [...open, esc[0]];
      i += esc[0].length;
      continue;
    }
    const ch = row[i] as string;
    if (ch === " ") {
      if (seenText && spaces === 0) {
        runStart = i;
      }
      spaces++;
    } else {
      if (seenText && spaces >= 2) {
        const col = visible;
        return { before: row.slice(0, runStart), after: open.join("") + row.slice(i), col };
      }
      spaces = 0;
      seenText = true;
    }
    visible++;
    i++;
  }
  return undefined;
}

/** One space of gutter, then `line` wrapped to `width` with continuation lines under the text, not under the marker. */
export function wrapHanging(line: string, width: number): string[] {
  const [lead = "", spaces = "", marker = ""] = LEADING.exec(line) ?? [];
  const prefix = ` ${spaces}${marker}`;
  const hang = " ".repeat(prefix.length);
  const columns = marker === "" && visibleWidth(line) > width - 1 ? splitColumns(line.slice(lead.length)) : undefined;
  if (columns) {
    // "name   description" rows: the description hangs under its own column, when that leaves room to read it
    const room = width - prefix.length - columns.col;
    if (room >= MIN_DESCRIPTION_ROOM) {
      const wrapped = wrapTextWithAnsi(columns.after, room);
      const gap = " ".repeat(columns.col - visibleWidth(columns.before));
      return (wrapped.length > 0 ? wrapped : [""]).map((w, i) => (i === 0 ? `${prefix}${columns.before}${gap}` : `${hang}${" ".repeat(columns.col)}`) + w);
    }
  }
  const wrapped = wrapTextWithAnsi(line.slice(lead.length), Math.max(1, width - prefix.length));
  return (wrapped.length > 0 ? wrapped : [""]).map((w, i) => (i === 0 ? prefix : hang) + w);
}

/** A component that renders whatever `lines` returns; the panel's pieces are views on its state. */
class Lines implements Component {
  private readonly lines: (width: number) => string[];

  constructor(lines: (width: number) => string[]) {
    this.lines = lines;
  }

  render(width: number): string[] {
    return this.lines(width);
  }

  invalidate(): void {}
}

/** The keys that scroll the panel (they never close it). */
const SCROLL_KEYS: Array<[KeyId, (view: ScrollView) => void]> = [
  [Key.up, (v) => void v.scrollBy(-1)],
  [Key.down, (v) => void v.scrollBy(1)],
  [Key.pageUp, (v) => void v.scrollBy(-Math.max(1, v.viewportHeight - 1))],
  [Key.pageDown, (v) => void v.scrollBy(Math.max(1, v.viewportHeight - 1))],
  [Key.home, (v) => v.scrollToStart()],
  [Key.end, (v) => v.scrollToEnd()],
];

export class InfoPanel extends VStack {
  private lines!: string[];
  private actions!: PanelAction[];
  private scroller!: ScrollView;
  /** Rows of text at the width last rendered, for the "more below" cue. */
  private bodyRows!: number;

  constructor() {
    // the pieces read this panel's state when they render, which is after construction
    const self: { panel?: InfoPanel } = {};
    const paint = (width: number) => panelRowPainter(width);
    const text = new Lines((width) => (self.panel?.isOpen ? (self.panel.bodyLines(width)).map(paint(width)) : []));
    const top = new Lines((width) => (self.panel?.isOpen ? ["", paint(width)("")] : []));
    const foot = new Lines((width) => (self.panel?.isOpen ? self.panel.footerLines(width).map(paint(width)) : []));
    // "contain": at the popup's top or bottom the wheel stops, instead of moving the transcript behind it
    const scroller = new ScrollView(text, { scrollbar: "auto", overscroll: "contain" });
    // the text takes what it needs and gives way (and scrolls) when the screen is shorter; top and foot never shrink
    super([
      { component: top, basis: "auto", grow: 0, shrink: 0, minSize: 0 },
      { component: scroller, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
      { component: foot, basis: "auto", grow: 0, shrink: 0, minSize: 0 },
    ]);
    self.panel = this;
    this.lines = [];
    this.actions = [];
    this.bodyRows = 0;
    this.scroller = scroller;
  }

  get isOpen(): boolean {
    return this.lines.length > 0;
  }

  /** `actions` add single-key choices (shown in the footer) next to the usual "any key closes". */
  show(text: string, actions: PanelAction[] = []): void {
    this.lines = text.split("\n");
    this.actions = actions;
    this.scroller.scrollToStart();
  }

  close(): void {
    this.lines = [];
    this.actions = [];
  }

  /** Runs the action bound to `data` and closes the panel; false when the key is not one of them. */
  act(data: string): boolean {
    const action = this.actions.find((a) => a.key === data);
    if (!action) {
      return false;
    }
    this.close();
    action.run();
    return true;
  }

  /** Scrolls for an arrow, page, home or end key; false for any other key (which the caller treats as "close"). */
  scrollKey(data: string): boolean {
    const hit = SCROLL_KEYS.find(([key]) => matchesKey(data, key));
    if (!hit) {
      return false;
    }
    hit[1](this.scroller);
    return true;
  }

  private bodyLines(width: number): string[] {
    const rows = this.lines.flatMap((l) => wrapHanging(l, panelInnerWidth(width)));
    this.bodyRows = rows.length;
    return rows;
  }

  /** The key hints, wrapped to the panel so a long action list never runs past the box. */
  footerLines(width: number): string[] {
    const keys = this.actions.map((a) => `${a.key} ${a.label}`).join(", ");
    const hidden = this.scroller.viewportHeight > 0 && this.bodyRows > this.scroller.viewportHeight;
    const above = hidden && this.scroller.scrollTop > 0;
    const below = hidden && this.scroller.scrollTop + this.scroller.viewportHeight < this.bodyRows;
    const more = [above ? "more above" : "", below ? "more below" : ""].filter(Boolean).join(" and ");
    const where = hidden ? `${more} (up/down/pgup/pgdn scroll) - ` : "";
    const hint = `${where}${keys ? `${keys} - ` : ""}esc or enter closes`;
    return ["", ...wrapHanging(hint, panelInnerWidth(width)).map((row) => dim(row)), ""];
  }
}
