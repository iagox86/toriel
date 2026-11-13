// What a parent is told about how a subagent's process ended: the exit code or
// signal, a short scrubbed stderr tail, and the one-line reason in the verb.

const TAIL_CHARS = 200;

/** Drop what looks like a credential from text that is about to reach another model's context. */
export function scrubSecrets(text: string): string {
  return text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 ***")
    // user:password@ in a URL
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1***@")
    // well-known provider token shapes, which error messages echo back
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "AKIA***")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "gh***")
    .replace(/\bAIza[A-Za-z0-9_-]{30,}/g, "AIza***")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "xox***")
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, "jwt***")
    .replace(/\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH)[A-Za-z0-9_]*)\s*[=:]\s*\S+/gi, "$1=***")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-***");
}

/** The last `TAIL_CHARS` of stderr on one line, scrubbed; "" when there is nothing useful. */
export function stderrTail(stderr: string | undefined): string {
  const flat = scrubSecrets((stderr ?? "").replace(/\s+/g, " ").trim());
  return flat.length > TAIL_CHARS ? `...${flat.slice(-TAIL_CHARS)}` : flat;
}

/** The note for a child process that exited on its own: "its process exited (code 1): <stderr tail>". */
export function exitNote(code: number | null | undefined, signal: string | null | undefined, stderr?: string): string {
  const how = signal ? `signal ${signal}` : code !== null && code !== undefined ? `code ${code}` : "no exit code";
  const tail = stderrTail(stderr);
  return `its process exited (${how})${tail ? `: ${tail}` : ""}`;
}

/** The short reason for the first line: the note up to its first detail, at most 80 characters. */
export function briefReason(note: string | undefined): string {
  const first = ((note ?? "").split("\n")[0]?.split(": ")[0]?.trim() ?? "").replace(/^was /, "");
  return first.length > 80 ? `${first.slice(0, 77)}...` : first;
}

/** "finished", "failed (why)" or "was cut short (why)" for the line that opens a delivered result. */
export function verbLine(state: string, note: string | undefined): string {
  if (state === "done") {
    return "finished";
  }
  const why = briefReason(note);
  const base = state === "failed" ? "failed" : "was cut short";
  return why ? `${base} (${why})` : base;
}
