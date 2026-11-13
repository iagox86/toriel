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
  /**
   * What the daemon knows about this ask (docs/permissions.md): the grants pi would record for it, or `protectedAsk` when
   * it is about the grants file or pi's own configuration, which no grant ever covers.
   */
  toriel?: { grants?: Array<{ surface: string; pattern: string }>; protectedAsk?: boolean };
  /** toriel's own "allow for ..." rows, among `options` (see withOwnLayout). */
  extraRows?: GrantRow[];
  /** When toriel relabelled the options: what pi is told for each label, since pi only understands its own wording. */
  answers?: Record<string, string>;
}

/** A row that answers "Yes" to pi and stores a grant lasting `for`. */
export interface GrantRow {
  label: string;
  /** A duration ("1h") or "session". */
  for: string;
}

/** Lifetimes of the allow rows when the setting does not say. */
export const DEFAULT_GRANT_DURATIONS: readonly string[] = ["1h", "session"];

/** pi's permission prompt: a select titled "Permission Required" with a plain Yes and No. Any other select (an extension's own picker) is left alone. */
export function isPermissionPrompt(d: DialogRequest): boolean {
  const options = d.options ?? [];
  return d.method === "select" && (d.title ?? "").startsWith("Permission Required") && options.includes("Yes") && options.includes("No");
}

/**
 * A permission prompt in toriel's own layout, the same whatever pi offered:
 *
 *   Yes, this once  /  Yes, and allow ... for 1 hour  /  ... for this session  /  No  /  No, with a reason
 *
 * Each row maps to one of pi's literal answers (`answers`), or to "Yes" plus a stored grant (`extraRows`). pi's own "for this
 * session" rows are never shown, because pi keeps that answer in memory where toriel can neither see nor limit it - it would
 * cover files toriel refuses to grant; only when there is no grant to offer does one stand in (labelled as pi's). An ask about
 * a protected file (`protectedAsk`) gets neither. The rest of the dialogs come back untouched.
 */
export function withOwnLayout(d: DialogRequest, durations: readonly string[]): DialogRequest {
  if (!isPermissionPrompt(d) || d.answers !== undefined) {
    return d;
  }
  const options = d.options ?? [];
  const protectedAsk = d.toriel?.protectedAsk === true;
  const grants = protectedAsk ? [] : (d.toriel?.grants ?? []);
  const piSession = protectedAsk || grants.length > 0 ? undefined : options.find((o) => o.startsWith("Yes") && o !== "Yes");
  const reason = options.find((o) => o.startsWith("No") && o !== "No" && takesReason(o));
  const labels: string[] = [];
  const answers: Record<string, string> = {};
  const rows: GrantRow[] = [];
  const add = (label: string, answer: string): void => {
    labels.push(label);
    answers[label] = answer;
  };
  add("Yes, this once", "Yes");
  if (grants.length > 0) {
    const what = grants.map((g) => JSON.stringify(g.pattern)).join(" + ");
    for (const life of durations) {
      const row = { label: `Yes, and allow ${what} for ${life === "session" ? "this session, kept across restarts" : durationWords(life)}`, for: life };
      rows.push(row);
      labels.push(row.label);
      answers[row.label] = "Yes";
    }
  } else if (piSession !== undefined) {
    add("Yes, and allow for this session (pi's own: lost on restart)", piSession);
  }
  add("No", "No");
  if (reason !== undefined) {
    add("No, with a reason", reason);
  }
  return { ...d, options: labels, extraRows: rows, answers };
}

/** What pi is told when `label` is picked: its own wording for a relabelled row, else the label itself. */
export function answerValue(d: DialogRequest, label: unknown): unknown {
  return typeof label === "string" ? (d.answers?.[label] ?? label) : label;
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

/** `text` with a cursor drawn at `at`: a block after the end, else the character under it in reverse video. */
export function withCursor(text: string, at: number): string {
  return at >= text.length ? `${text}█` : `${text.slice(0, at)}\x1b[7m${text[at]}\x1b[27m${text.slice(at + 1)}`;
}

/** `reason` non-null = the highlighted option is being edited inline, with the cursor at `cursor` (default: the end). */
export function dialogLines(d: DialogRequest, index: number, width: number, reason: string | null = null, cursor = reason?.length ?? 0): string[] {
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
  (d.options ?? []).forEach((o, i) => {
    const row = grantRowFor(d, o);
    const lead = `${i + 1}. `;
    if (i === index && reason !== null) {
      const label = row && editablePattern(d, o) !== undefined ? `Yes, and allow pattern (${row.for === "session" ? "this session" : durationWords(row.for)})` : o;
      // wrapped, not cut: the text being typed and the cursor must stay in view however long it gets
      out.push(...wrapRows(`${lead}${label}: ${withCursor(reason, cursor)}`, width, " > ", `   ${" ".repeat(lead.length)}`).map(selected));
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
  if (d.toriel?.protectedAsk) {
    out.push(...wrapRows("toriel: grants never cover the permission grants file or pi's own configuration, so this is always asked", width, " -- ", "    ").map(dim));
  }
  return out;
}

/** Docked above the input box while the viewed session has a pending dialog. */
export class DialogPanel implements Component {
  private dialog: DialogRequest | undefined;
  private index = 0;
  private reason: string | null = null;
  private cursor = 0;

  /** Inline reason text while editing, else null. */
  get editing(): string | null {
    return this.reason;
  }

  /** Start editing `text` (null stops), the cursor at its end. */
  edit(text: string | null): void {
    this.reason = text;
    this.cursor = text?.length ?? 0;
  }

  /** Type `text` at the cursor. */
  insert(text: string): void {
    if (this.reason !== null) {
      this.reason = this.reason.slice(0, this.cursor) + text + this.reason.slice(this.cursor);
      this.cursor += text.length;
    }
  }

  /** Delete the character before the cursor (`forward`: under it). */
  erase(forward = false): void {
    if (this.reason === null) {
      return;
    }
    const at = forward ? this.cursor : this.cursor - 1;
    if (at >= 0 && at < this.reason.length) {
      this.reason = this.reason.slice(0, at) + this.reason.slice(at + 1);
      this.cursor = at;
    }
  }

  /** Move the cursor by `delta` characters, or to the start (-Infinity) or end (Infinity); it stays inside the text. */
  moveCursor(delta: number): void {
    this.cursor = Math.max(0, Math.min(this.reason?.length ?? 0, this.cursor + delta));
  }

  /** Show `dialog` (undefined hides); the highlight restarts for a new dialog. */
  sync(dialog: DialogRequest | undefined): void {
    if (dialog?.id !== this.dialog?.id) {
      this.index = 0;
      this.reason = null;
      this.cursor = 0;
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
    return this.dialog ? panel(dialogLines(this.dialog, this.index, panelInnerWidth(width), this.reason, this.cursor), width) : [];
  }

  invalidate(): void {}
}
