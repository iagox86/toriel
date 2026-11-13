// A line that starts with `/` and names no command at all (toriel's or pi's) is
// refused instead of being sent to the model as text. pi's skills, prompt
// templates and extension commands are real slash commands that toriel
// forwards, so the check needs pi's list; without it nothing can be judged.

/** Levenshtein distance, for "did you mean". */
export function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min((prev[j] as number) + 1, (row[j - 1] as number) + 1, (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length] as number;
}

/** The known name closest to `typed`: a prefix match, else within two edits (one for short names); undefined when nothing is close. */
export function nearestCommand(typed: string, names: readonly string[]): string | undefined {
  const t = typed.toLowerCase();
  const prefixed = names.filter((n) => n.toLowerCase().startsWith(t) && t.length >= 2);
  if (prefixed.length > 0) {
    return [...prefixed].sort((a, b) => a.length - b.length)[0];
  }
  const limit = t.length <= 4 ? 1 : 2;
  let best: { name: string; d: number } | undefined;
  for (const name of names) {
    const d = editDistance(t, name.toLowerCase());
    if (d <= limit && (!best || d < best.d)) {
      best = { name, d };
    }
  }
  return best?.name;
}

export type SlashCheck = { send: true } | { send: false; message: string };

/**
 * Whether the line `/name args` should go to pi. Anything that does not look
 * like a command name (a file path such as /tmp/x, a bare /) is ordinary text.
 * `piNames` is undefined when pi's command list has not arrived.
 */
export function checkSlash(line: string, ownNames: readonly string[], piNames: readonly string[] | undefined): SlashCheck {
  const typed = /^\/([A-Za-z][\w:.-]*)(?:\s|$)/.exec(line)?.[1];
  if (typed === undefined) {
    return { send: true };
  }
  const name = typed.toLowerCase();
  if (ownNames.includes(name) || piNames?.some((n) => n.toLowerCase() === name)) {
    return { send: true };
  }
  if (piNames === undefined || piNames.length === 0) {
    return {
      send: false,
      message: `/${typed} is not a toriel command, and pi's command list is not loaded yet (skills and extension commands live there), so it was not sent. Try again in a moment, or put a word before the slash to send it as text`,
    };
  }
  const near = nearestCommand(typed, [...ownNames, ...piNames]);
  return {
    send: false,
    message: `unknown command: /${typed}${near ? ` - did you mean /${near}?` : ""} (/help lists commands, /<command> --help describes one; to send it as text put a word before the slash)`,
  };
}
