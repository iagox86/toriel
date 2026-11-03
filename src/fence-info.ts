// What to do with the text after the backticks of an opening code fence. toriel
// hides the fence lines themselves (a pasted block should read as code, not as
// markup), which is right when the text is a language name and wrong when the
// person wrote something to be read ("```this is the first line").
//
// A single word is taken for a language (known to the highlighter, or one of the
// names that mean "plain text" and so are not worth a line) and hidden; any other
// word, or several words, are shown.

/** Names that stand for "no highlighting" or for languages the highlighter does not ship. */
const PLAIN = new Set(["text", "txt", "plain", "plaintext", "console", "output", "log", "terminal", "mermaid"]);

/**
 * The text to show for a fence line's info string, or undefined to hide the line.
 * `isLanguage` says whether the highlighter knows a name (aliases included).
 */
export function visibleFenceInfo(info: string, isLanguage: (name: string) => boolean): string | undefined {
  const text = info.trim();
  if (text === "") {
    return undefined;
  }
  if (!/\s/.test(text) && (PLAIN.has(text.toLowerCase()) || isLanguage(text))) {
    return undefined;
  }
  return text;
}
