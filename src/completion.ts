// Helpers for argument completion (see CommandSpec.complete).

/**
 * The choices whose text contains every word typed so far, case-insensitively.
 * Typing flags (a word starting with "-") ends completion: it is for values.
 */
export function matching(choices: readonly string[], typed: string): string[] {
  const words = typed.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.some((w) => w.startsWith("-"))) {
    return [];
  }
  return choices.filter((c) => words.every((w) => c.toLowerCase().includes(w)));
}

/**
 * After "... -m " or "--model ": the models containing what was typed. The value replaces the whole line
 * typed after the command, like the other completers (so the flags before it are kept).
 */
export function modelFlagCompletions(typed: string, models: readonly string[]): string[] {
  const at = flagValueAt(typed, "m", "model");
  if (!at) {
    return [];
  }
  return models.filter((c) => c.toLowerCase().includes(at.prefix.toLowerCase())).map((c) => `${at.head}${c}`);
}

/**
 * Where the value of a flag (`-m` / `--model`: `short` and `long` without the dashes) is being typed at the end of `typed`: the text up
 * to the value (the separator included; a space is added after a bare trailing flag, since typing one there opens no popup by itself)
 * and the value so far. Undefined when the line does not end in that flag's value.
 */
export function flagValueAt(typed: string, short: string, long: string): { head: string; prefix: string } | undefined {
  const m = new RegExp(`^(.*?(?:^|\\s)(?:-${short}|--${long}))(?:([ =])(\\S*))?$`).exec(typed);
  if (!m) {
    return undefined;
  }
  const [, flag = "", sep, value = ""] = m;
  return { head: `${flag}${sep ?? " "}`, prefix: value };
}
