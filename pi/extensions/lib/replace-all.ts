// replaceAll for the edit tool (tool-efficiency study, ticket 63): pi's edit replaces one unique match per edit, so renaming a symbol
// used fourteen times took fourteen edits with growing context or a sed through bash. Exact matching only: a fuzzy match of many places
// would be a guess times N.

/** `text` with LF line breaks turned into CRLF when the file uses them and the model's text does not say otherwise. */
function toFileEndings(content: string, text: string): string {
  return content.includes("\r\n") && !text.includes("\r\n") ? text.replace(/\n/g, "\r\n") : text;
}

/** Every exact occurrence of `oldText` in `content` replaced by `newText` (line endings matched to the file); `count` is how many there were. */
export function replaceEvery(content: string, oldText: string, newText: string): { content: string; count: number } {
  if (oldText === "") {
    return { content, count: 0 };
  }
  const from = toFileEndings(content, oldText);
  const to = toFileEndings(content, newText);
  const parts = content.split(from);
  return { content: parts.join(to), count: parts.length - 1 };
}
