// A docked, dismissable text panel for multi-line command output (--help,
// /help). Shares the popup look of the dialog and rewind panels.
import type { Component } from "@earendil-works/pi-tui";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { dim, panel, panelInnerWidth } from "./theme.ts";

export interface PanelAction {
  key: string;
  label: string;
  run: () => void;
}

/** A line's own indent and list marker ("  - ", "1. "), which wrapped lines hang under. */
const LEADING = /^( *)((?:[-*] |\d+[.)] )?)/;

/** One space of gutter, then `line` wrapped to `width` with continuation lines under the text, not under the marker. */
export function wrapHanging(line: string, width: number): string[] {
  const [lead = "", spaces = "", marker = ""] = LEADING.exec(line) ?? [];
  const prefix = ` ${spaces}${marker}`;
  const hang = " ".repeat(prefix.length);
  const wrapped = wrapTextWithAnsi(line.slice(lead.length), Math.max(1, width - prefix.length));
  return (wrapped.length > 0 ? wrapped : [""]).map((w, i) => (i === 0 ? prefix : hang) + w);
}

export class InfoPanel implements Component {
  private lines: string[] = [];
  private actions: PanelAction[] = [];

  get isOpen(): boolean {
    return this.lines.length > 0;
  }

  /** `actions` add single-key choices (shown in the footer) next to the usual "any key closes". */
  show(text: string, actions: PanelAction[] = []): void {
    this.lines = text.split("\n");
    this.actions = actions;
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

  render(width: number): string[] {
    if (!this.isOpen) {
      return [];
    }
    const inner = panelInnerWidth(width);
    const body = this.lines.flatMap((l) => wrapHanging(l, inner));
    const keys = this.actions.map((a) => `${a.key} ${a.label}`).join(", ");
    return panel([...body, "", dim(` ${keys ? `${keys} - ` : ""}esc or enter closes`)], width);
  }

  invalidate(): void {}
}
