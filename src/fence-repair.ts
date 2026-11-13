// A line like "```Pushback on `docs/x.md` ..." is meant as a code fence with a
// remark after it, but CommonMark forbids a backtick in a backtick fence's info
// string, so the line renders literally with its backticks. For text the user
// typed, drop the backticks from such an info string so the block renders as code.
//
// A fence that ends a line of prose ("like this: ```") is no CommonMark fence, but pi-tui opens a block at it
// anyway and leaves the prose line as it was, so only the closing fence is hidden and the rest of the message
// renders as code (ticket 134). Move such a fence onto its own line.
const OPENING = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const INLINE_OPENING = /^(.*\S.*?)[ \t]*(`{3,})[ \t]*$/;
const CLOSING = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

export function repairFences(text: string): string {
  if (!text.includes("```")) {
    return text;
  }
  let open: { char: string; length: number } | undefined;
  const repair = (line: string): string => {
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
      const inline = INLINE_OPENING.exec(line);
      // the run must be the only one on the line: "use ```x``` here" and "a ```b``` ```" are inline code spans
      if (inline && !inline[1]?.includes("```")) {
        open = { char: "`", length: (inline[2] as string).length };
        return `${inline[1]}\n${inline[2]}`;
      }
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
  };
  return text
    .split("\n")
    .map((raw) => {
      // CRLF text: the patterns end in `$`, which in JS only matches at the end of the string, so a trailing \r would
      // make every line fail them. Repair the line without its \r and put it back.
      const cr = raw.endsWith("\r") ? "\r" : "";
      return `${repair(cr ? raw.slice(0, -1) : raw)}${cr}`;
    })
    .join("\n");
}
