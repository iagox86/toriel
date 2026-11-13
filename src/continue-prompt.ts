// /continue: the prompt that resumes a session after an accidental esc-abort.
// Its own module so the wording has a unit test without pulling in the TUI.

const BASE = "That interruption was accidental, please continue where you left off.";

/** The prompt /continue sends; `extra` (the text typed after the command) is added as further instruction. */
export function continuePrompt(extra: string): string {
  const more = extra.trim();
  return more === "" ? BASE : `${BASE} ${more}`;
}
