// The message list behind double-Esc: a short docked list of earlier user
// messages, newest at the bottom, the selection starting on the newest.
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { firstMessageLabel } from "./format.ts";
import type { RewindTarget } from "./rewind.ts";
import type { CodeSummary } from "./rewind-code.ts";
import { attention, dim, panel, panelInnerWidth, selected, success } from "./theme.ts";

const VISIBLE = 8;

/** "3 files changed +12 -4" (the counts coloured), and what a restore would leave alone. */
export function codeLine(code: CodeSummary): string {
  const files = code.files > 0 ? `${code.files} file${code.files === 1 ? "" : "s"} changed ${success(`+${code.added}`)} ${attention(`-${code.removed}`)}` : "no file can be put back";
  const left = code.leftAlone > 0 ? dim(` (${code.leftAlone} more changed since or too big: left alone)`) : "";
  return ` ${dim("code since:")} ${files}${left}`;
}

export function pickerLines(targets: RewindTarget[], index: number, width: number, code?: CodeSummary): string[] {
  const restoring = targets.length > 0 && targets.every((t) => t.restore);
  const title = restoring
    ? " This session was cleared. Restore the conversation?"
    : " Rewind to before which message? The agent's file changes since can be undone too.";
  const lines = [dim(truncateToWidth(title, width))];
  const start = Math.max(0, Math.min(index - Math.floor(VISIBLE / 2), targets.length - VISIBLE));
  const shown = targets.slice(start, start + VISIBLE);
  if (start > 0) {
    lines.push(dim(`   ... ${start} earlier`));
  }
  shown.forEach((t, i) => {
    const text = firstMessageLabel(t.text, Math.max(10, width - 6)) || "(empty message)";
    const mark = t.compacted ? " [before a compaction]" : "";
    lines.push(truncateToWidth(start + i === index ? selected(` > ${text}${mark}`) : dim(`   ${text}${mark}`), width));
  });
  if (targets[index]?.compacted) {
    lines.push(attention(" rewinding here also undoes the compaction: the model gets the full earlier conversation back"));
  }
  if (code !== undefined) {
    lines.push(truncateToWidth(codeLine(code), width));
  }
  lines.push(dim(restoring ? " enter restore - esc cancel" : " up/down choose - enter rewind - esc cancel"));
  return lines;
}

export class RewindPicker implements Component {
  private targets: RewindTarget[] = [];
  private index = 0;
  private summarize: ((t: RewindTarget) => CodeSummary | undefined) | undefined;
  private summaries = new Map<string, CodeSummary | undefined>();

  get isOpen(): boolean {
    return this.targets.length > 0;
  }

  /** `summarize` says what undoing the code back to a message would do (asked once per message, when it is highlighted). */
  open(targets: RewindTarget[], summarize?: (t: RewindTarget) => CodeSummary | undefined): void {
    this.targets = targets;
    this.index = targets.length - 1;
    this.summarize = summarize;
    this.summaries = new Map();
  }

  /** The code summary of the highlighted message (or of `target`), computed once. */
  codeOf(target: RewindTarget | undefined = this.current()): CodeSummary | undefined {
    if (target === undefined || target.restore || this.summarize === undefined) {
      return undefined;
    }
    if (!this.summaries.has(target.entryId)) {
      let summary: CodeSummary | undefined;
      try {
        summary = this.summarize(target);
      } catch {
        summary = undefined; // a journal that cannot be read is no summary, and the rewind itself still works
      }
      this.summaries.set(target.entryId, summary);
    }
    return this.summaries.get(target.entryId);
  }

  close(): void {
    this.targets = [];
  }

  move(delta: number): void {
    this.index = Math.max(0, Math.min(this.targets.length - 1, this.index + delta));
  }

  current(): RewindTarget | undefined {
    return this.targets[this.index];
  }

  render(width: number): string[] {
    return this.isOpen ? panel(pickerLines(this.targets, this.index, panelInnerWidth(width), this.codeOf()), width) : [];
  }

  invalidate(): void {}
}
