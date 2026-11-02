// A line like "```Pushback on `docs/x.md` ..." is meant as a code fence with a
// remark after it, but CommonMark forbids a backtick in a backtick fence's info
// string, so the line renders literally with its backticks. For text the user
// typed, drop the backticks from such an info string so the block renders as code.
const OPENING = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const CLOSING = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

export function repairFences(text: string): string {
  if (!text.includes("```")) {
    return text;
  }
  let open: { char: string; length: number } | undefined;
  return text
    .split("\n")
    .map((line) => {
      if (open !== undefined) {
        const close = CLOSING.exec(line);
        const run = close?.[1] as string | undefined;
        if (run && run[0] === open.char && run.length >= open.length) {
          open = undefined;
        }
        return line;
      }
      const m = OPENING.exec(line);
      if (!m) {
        return line;
      }
      const [, indent, ticks, info] = m as unknown as [string, string, string, string];
      // a tilde fence's info string may hold backticks, so it never needs repair
      if (ticks[0] === "~" || !info.includes("`")) {
        open = { char: ticks[0] as string, length: ticks.length };
        return line;
      }
      // a run as long as the opener on the same line closes an inline code span: leave it alone
      if (new RegExp(`\`{${ticks.length},}`).test(info)) {
        return line;
      }
      open = { char: "`", length: ticks.length };
      return `${indent}${ticks}${info.replaceAll("`", "")}`;
    })
    .join("\n");
}
