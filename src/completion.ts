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
  const m = /^(.*?(?:^|\s)(?:-m|--model)[ =])(\S*)$/.exec(typed);
  if (!m) {
    return [];
  }
  const [, head = "", prefix = ""] = m;
  return models.filter((c) => c.toLowerCase().includes(prefix.toLowerCase())).map((c) => `${head}${c}`);
}
