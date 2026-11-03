// pi takes a resumed session's working directory from the "cwd" field of the session file's first line, not
// from where it was started. Moving a session to another directory therefore means rewriting that line.
import * as fs from "node:fs";
import { writeFileAtomic } from "./util.ts";

/**
 * `text` with the first line's "cwd" set to `dir` (everything after that line is untouched), and the directory
 * it had. Throws when the first line is not a session header.
 */
export function withHeaderCwd(text: string, dir: string): { text: string; previous?: string } {
  const end = text.indexOf("\n");
  let header: { type?: string; cwd?: string };
  try {
    header = JSON.parse(end === -1 ? text : text.slice(0, end)) as { type?: string; cwd?: string };
  } catch {
    throw new Error("the session file does not start with a session header");
  }
  if (header?.type !== "session") {
    throw new Error("the session file does not start with a session header");
  }
  return { text: `${JSON.stringify({ ...header, cwd: dir })}${end === -1 ? "" : text.slice(end)}`, previous: header.cwd };
}

/** Point the session file at `dir`, replacing the file in one step (a crash leaves the old one whole). Returns the directory it had. */
export function setSessionFileCwd(file: string, dir: string): string | undefined {
  const { text, previous } = withHeaderCwd(fs.readFileSync(file, "utf8"), dir);
  writeFileAtomic(file, text, fs.statSync(file).mode & 0o777);
  return previous;
}
