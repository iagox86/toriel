// Permission/extension dialogs forwarded from a child. confirm and select are
// answered from a docked panel; input/editor are answered by typing in the
// input box (pi-permission-system uses one for the optional deny reason).
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { durationWords } from "./permission-format.ts";
import { attention, dim, panel, panelInnerWidth, selected } from "./theme.ts";

export interface DialogRequest {
  id: string;
  method: string;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  /** Which session raised the dialog, e.g. "Session 3 'Worker'"; set by the controller. */
  origin?: string;
  /** When the controller received it (ms); set by withOrigin. */
  shownAt?: number;
  /** The grant pi would record for this ask, attached by the daemon when it can be granted (docs/permissions.md). */
  toriel?: { grants: Array<{ surface: string; pattern: string }> };
  /** toriel's own "allow for ..." rows, already appended to `options` (see withGrantRows). */
  extraRows?: GrantRow[];
}

/** A row toriel adds below pi's options: answering it says "Yes" to pi and stores a grant lasting `for`. */
export interface GrantRow {
  label: string;
  /** A duration ("1h") or "session". */
  for: string;
}

/** Lifetimes of the extra rows when the setting does not say. */
export const DEFAULT_GRANT_DURATIONS: readonly string[] = ["1h", "session"];

/**
 * The dialog with toriel's rows appended after pi's options, when the ask can be granted: a
 * select whose plain "Yes" exists and that carries a suggested grant. pi's own options stay as
 * they are (each is the literal answer value). At most nine rows in all, so digits still pick.
 */
export function withGrantRows(d: DialogRequest, durations: readonly string[]): DialogRequest {
  const grants = d.toriel?.grants ?? [];
  const options = d.options ?? [];
  const room = Math.max(0, 9 - options.length);
  if (d.method !== "select" || grants.length === 0 || room === 0 || !options.includes("Yes") || (d.extraRows?.length ?? 0) > 0) {
    return d;
  }
  const what = grants.map((g) => JSON.stringify(g.pattern)).join(" + ");
  const rows = durations.slice(0, room).map((life) => ({ label: `Yes, and allow ${what} for ${life === "session" ? "this session, kept across restarts" : durationWords(life)} [toriel]`, for: life }));
  return rows.length === 0 ? d : { ...d, options: [...options, ...rows.map((r) => r.label)], extraRows: rows };
}

/** The extra row an answer value picked, if it was one. */
export function grantRowFor(d: DialogRequest, value: unknown): GrantRow | undefined {
  return d.extraRows?.find((r) => r.label === value);
}

/**
 * The pattern a toriel "allow for ..." row would store, when `option` is one of those rows and the
 * ask carries exactly one suggested grant: tab on the row types a different (usually broader)
 * pattern in its place. With several grants there is no single pattern to edit, so none is offered.
 */
export function editablePattern(d: DialogRequest, option: string | undefined): string | undefined {
  const grants = d.toriel?.grants ?? [];
  return grants.length === 1 && grantRowFor(d, option) !== undefined ? grants[0].pattern : undefined;
}

/** Whether choosing `option` chains a free-text reason dialog; toriel's own rows never do, whatever their pattern says. */
export function optionTakesReason(d: DialogRequest, option: string | undefined): boolean {
  return grantRowFor(d, option) === undefined && takesReason(option);
}

/**
 * Affirmative answers are ignored this long after a dialog appears: a prompt that
 * pops up mid-sentence must not be answered by the keys still being typed.
 */
export const DIALOG_GUARD_MS = 700;

/**
 * Label a dialog request with the session that raised it. The numeric id
 * goes in because session names can repeat.
 */
export function withOrigin(d: DialogRequest, id: number, name?: string, kind = "Session"): DialogRequest {
  return { ...d, origin: name ? `${kind} ${id} '${name}'` : `${kind} ${id}`, shownAt: Date.now() };
}

/** Whether an answer that grants something must still be ignored (denying never is). */
export function grantGuarded(d: DialogRequest, fields: Record<string, unknown>, now = Date.now()): boolean {
  const denies = fields.confirmed === false || fields.cancelled === true || (d.method === "select" && fields.value === denyOption(d.options ?? []));
  return !denies && d.shownAt !== undefined && now - d.shownAt < DIALOG_GUARD_MS;
}

/** Keys that would type into the box or submit it: a pending prompt owns the keyboard, so these are swallowed. */
export function isTypingKey(data: string): boolean {
  return data === "\r" || data === "\n" || data === "\x7f" || data === "\b" || (data.length > 0 && !/[\x00-\x1f\x7f]/.test(data) && !data.startsWith("\x1b"));
}

/** Free-text dialogs: answered by typing in the input box. */
export const isTextDialog = (d: DialogRequest): boolean => d.method === "input" || d.method === "editor";

/**
 * The option that means "deny": the first starting with "No", else the last.
 * A presentation heuristic - dismissal always means deny, and the option list
 * comes from the permission package, not the model.
 */
export function denyOption(options: string[]): string | undefined {
  return options.find((o) => o.startsWith("No")) ?? options[options.length - 1];
}

/**
 * Map a keypress to the extension_ui_response fields that answer `dialog`,
 * or null when the key is not an answer. `index` is the highlighted option.
 */
export function dialogAnswer(dialog: DialogRequest, data: string, index = 0): Record<string, unknown> | null {
  if (dialog.method === "confirm") {
    if (data === "y") {
      return { confirmed: true };
    }
    if (data === "n" || data === "\x1b") {
      return { confirmed: false };
    }
    return null;
  }
  if (dialog.method === "select") {
    const options = dialog.options ?? [];
    const idx = Number.parseInt(data, 10);
    if (data.length === 1 && !Number.isNaN(idx) && idx >= 1 && idx <= options.length) {
      return { value: options[idx - 1] };
    }
    if (data === "\r" || data === "\n") {
      return options[index] === undefined ? null : { value: options[index] };
    }
    if (data === "\x1b") {
      const deny = denyOption(options);
      return deny === undefined ? { cancelled: true } : { value: deny };
    }
  }
  return null;
}

/** Status-line hint while a dialog is pending (unstyled). */
export function dialogPrompt(d: DialogRequest): string {
  const who = d.origin ? ` (${d.origin})` : "";
  if (d.method === "confirm") {
    return `PERMISSION pending${who} - y yes, n or esc no`;
  }
  if (isTextDialog(d)) {
    return `PERMISSION pending${who} - type a reply, enter send, esc skip`;
  }
  return `PERMISSION pending${who} - up/down choose, enter or 1-9 answer, tab reason or edit pattern, esc deny`;
}

/** Options that chain a free-text dialog afterwards ("No, provide reason"). */
export const takesReason = (option: string | undefined): boolean => /reason/i.test(option ?? "");

/**
 * `text` wrapped to `width`: the first line starts with `first`, the others with `hang` (same width), so a long
 * command or a typed reason stays readable to its end instead of being cut at the right edge. A word longer than a
 * line is broken. Always at least one line.
 */
export function wrapRows(text: string, width: number, first = " ", hang = " "): string[] {
  const room = Math.max(1, width - Math.max(first.length, hang.length));
  const rows = wrapTextWithAnsi(text, room);
  return (rows.length > 0 ? rows : [""]).map((row, i) => (i === 0 ? first : hang) + row);
}

/** `reason` non-null = the highlighted option is being edited inline. */
export function dialogLines(d: DialogRequest, index: number, width: number, reason: string | null = null): string[] {
  const out: string[] = [];
  const title = (d.title ?? d.method).split("\n");
  const head = d.origin ? `${d.origin}: ` : "";
  out.push(...wrapRows(`${head}${title[0]}`, width).map(attention));
  for (const line of title.slice(1)) {
    out.push(...wrapRows(line, width));
  }
  if (d.message) {
    out.push(...wrapRows(d.message, width));
  }
  if (d.method === "confirm") {
    out.push(dim(" [y]es  [n]o"));
    return out;
  }
  if (isTextDialog(d)) {
    out.push(dim(truncateToWidth(` ${d.placeholder ?? "type a reply in the box below"}`, width)));
    out.push(dim(" enter send - empty enter or esc skips"));
    return out;
  }
  const extraFrom = (d.options?.length ?? 0) - (d.extraRows?.length ?? 0);
  (d.options ?? []).forEach((o, i) => {
    if (d.extraRows?.length && i === extraFrom) {
      out.push(dim(" -- toriel: also remember this --"));
    }
    const row = grantRowFor(d, o);
    const lead = `${i + 1}. `;
    if (i === index && reason !== null) {
      const label = row && editablePattern(d, o) !== undefined ? `Yes, and allow pattern (${row.for === "session" ? "this session" : durationWords(row.for)})` : o;
      // wrapped, not cut: the text being typed and the cursor must stay in view however long it gets
      out.push(...wrapRows(`${lead}${label}: ${reason}\u2588`, width, " > ", `   ${" ".repeat(lead.length)}`).map(selected));
      return;
    }
    if (i === index) {
      const hint = optionTakesReason(d, o) ? "  (tab: type a reason)" : editablePattern(d, o) !== undefined ? "  (tab: edit the pattern)" : "";
      // the row you are on shows in full (it names the pattern a grant would store) with its tab hint at the end
      out.push(...wrapRows(`${lead}${o}${hint}`, width, " > ", `   ${" ".repeat(lead.length)}`).map(selected));
      return;
    }
    out.push(dim(`  ${truncateToWidth(` ${lead}${o}`, width - 2)}`));
  });
  return out;
}

/** Docked above the input box while the viewed session has a pending dialog. */
export class DialogPanel implements Component {
  private dialog: DialogRequest | undefined;
  private index = 0;
  private reason: string | null = null;

  /** Inline reason text while editing, else null. */
  get editing(): string | null {
    return this.reason;
  }

  edit(text: string | null): void {
    this.reason = text;
  }

  /** Show `dialog` (undefined hides); the highlight restarts for a new dialog. */
  sync(dialog: DialogRequest | undefined): void {
    if (dialog?.id !== this.dialog?.id) {
      this.index = 0;
      this.reason = null;
    }
    this.dialog = dialog;
  }

  get highlightedOption(): string | undefined {
    return this.dialog?.options?.[this.index];
  }

  get highlighted(): number {
    return this.index;
  }

  move(delta: number): void {
    this.reason = null;
    const n = this.dialog?.options?.length ?? 0;
    this.index = Math.max(0, Math.min(Math.max(0, n - 1), this.index + delta));
  }

  render(width: number): string[] {
    return this.dialog ? panel(dialogLines(this.dialog, this.index, panelInnerWidth(width), this.reason), width) : [];
  }

  invalidate(): void {}
}
