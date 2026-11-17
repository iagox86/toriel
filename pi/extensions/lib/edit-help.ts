// Help for a failed edit (tool-efficiency study, ticket 63). pi's edit tool says only "could not find the exact text" or "found N
// occurrences", so the model re-reads the whole file to find out why. These functions look at the file and say what is nearest, and
// where the matches are, so the next call can be right. Pure: the extension reads the file and passes its text in.

export interface EditArg {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

/** The edits of an edit call, tolerating what pi's own argument preparation tolerates (a JSON string, one object, the old oldText/newText form). */
export function editsOf(input: unknown): EditArg[] {
  const args = (input ?? {}) as { edits?: unknown; oldText?: unknown; newText?: unknown };
  let edits: unknown = args.edits;
  if (typeof edits === "string") {
    try {
      edits = JSON.parse(edits);
    } catch {
      edits = undefined;
    }
  }
  const list: unknown[] = Array.isArray(edits) ? [...edits] : edits !== undefined && typeof edits === "object" ? [edits] : [];
  if (typeof args.oldText === "string" && typeof args.newText === "string") {
    list.push({ oldText: args.oldText, newText: args.newText });
  }
  const out: EditArg[] = [];
  for (const e of list) {
    const edit = e as { oldText?: unknown; newText?: unknown; replaceAll?: unknown } | null;
    if (edit !== null && typeof edit?.oldText === "string" && typeof edit.newText === "string") {
      out.push({ oldText: edit.oldText, newText: edit.newText, replaceAll: edit.replaceAll === true });
    }
  }
  return out;
}

/** Sørensen-Dice similarity of two strings by their character pairs: 1 for equal, 0 for nothing shared. */
export function dice(a: string, b: string): number {
  if (a === b) {
    return 1;
  }
  if (a.length < 2 || b.length < 2) {
    return 0;
  }
  const pairs = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const p = a.slice(i, i + 2);
    pairs.set(p, (pairs.get(p) ?? 0) + 1);
  }
  let shared = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const p = b.slice(i, i + 2);
    const n = pairs.get(p) ?? 0;
    if (n > 0) {
      pairs.set(p, n - 1);
      shared++;
    }
  }
  return (2 * shared) / (a.length + b.length - 2);
}

const MIN_SIMILARITY = 0.6;
const MAX_SHOWN_LINES = 15;
const MAX_LINE_CHARS = 200;
const MAX_SCANNED_LINES = 200_000;

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();
const cut = (s: string): string => (s.length > MAX_LINE_CHARS ? `${s.slice(0, MAX_LINE_CHARS)}...` : s);

/**
 * What the file holds where `oldText` was meant to be: the lines nearest its first non-blank line (by character-pair similarity), shown
 * as they are so they can be copied, and whether they differ from oldText only in whitespace. Undefined when there is nothing to say.
 */
export function nearestText(content: string, oldText: string, shown: string): string | undefined {
  const old = oldText.replace(/\r\n/g, "\n").split("\n");
  const anchorAt = old.findIndex((l) => l.trim() !== "");
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (anchorAt < 0 || lines.length > MAX_SCANNED_LINES) {
    return undefined;
  }
  const anchor = old[anchorAt].trim();
  let best = -1;
  let score = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === "") {
      continue;
    }
    const s = dice(anchor, t);
    if (s > score) {
      score = s;
      best = i;
      if (s === 1) {
        break;
      }
    }
  }
  if (best < 0 || score < MIN_SIMILARITY) {
    return `No line of ${shown} resembles the first line of oldText: the text may be in another file or already changed, so read the file again.`;
  }
  const start = Math.max(0, best - anchorAt);
  const end = Math.min(lines.length, start + Math.min(old.length, MAX_SHOWN_LINES));
  const window = lines.slice(start, end);
  const same = collapse(window.join("\n")) === collapse(old.join("\n"));
  const how = same ? "it differs from your oldText only in whitespace (indentation, tabs or trailing spaces)" : "it differs from your oldText";
  return `The nearest text in ${shown} is at lines ${start + 1}-${end}; ${how}. Copy it exactly:\n${window.map(cut).join("\n")}`;
}

/** The 1-based line numbers where `text` occurs in `content` (exact match), at most `max` of them, and the total count. */
export function occurrences(content: string, text: string, max = 8): { lines: number[]; total: number } {
  const lines: number[] = [];
  let total = 0;
  if (text === "") {
    return { lines, total };
  }
  const body = content.replace(/\r\n/g, "\n");
  const needle = text.replace(/\r\n/g, "\n");
  let from = 0;
  let line = 1;
  let counted = 0;
  for (;;) {
    const at = body.indexOf(needle, from);
    if (at < 0) {
      break;
    }
    for (let i = counted; i < at; i++) {
      if (body.charCodeAt(i) === 10) {
        line++;
      }
    }
    counted = at;
    total++;
    if (lines.length < max) {
      lines.push(line);
    }
    from = at + needle.length;
  }
  return { lines, total };
}

/**
 * The note to add to a failed edit's error, or undefined when the error is not one this knows. `message` is pi's error text, `edits`
 * the call's edits, `content` the file as it is now, `shown` the path as the model wrote it.
 */
export function editHint(message: string, edits: readonly EditArg[], content: string, shown: string): string | undefined {
  const missing = /^Could not find (?:the exact text|edits\[(\d+)\]) in /.exec(message);
  if (missing) {
    const edit = edits[missing[1] === undefined ? 0 : Number(missing[1])];
    return edit === undefined ? undefined : nearestText(content, edit.oldText, shown);
  }
  const many = /^Found (\d+) occurrences of (?:the text|edits\[(\d+)\]) in /.exec(message);
  if (many) {
    const edit = edits[many[2] === undefined ? 0 : Number(many[2])];
    if (edit === undefined) {
      return undefined;
    }
    const { lines, total } = occurrences(content, edit.oldText);
    if (lines.length === 0) {
      return undefined;
    }
    const more = total > lines.length ? ` and ${total - lines.length} more` : "";
    return `It matches at lines ${lines.join(", ")}${more}. Add the lines around the one you mean to oldText so it matches once, or set replaceAll: true on the edit to change every occurrence.`;
  }
  return undefined;
}
