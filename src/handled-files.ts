// Session files toriel has run a child on, persisted across daemon restarts. A
// restarted daemon forgets its registry, and the file of a session it was
// running a minute ago has a fresh mtime; without this record the "may be open
// in another pi" check (daemon-handlers-lifecycle.ts) would ask about toriel's own
// sessions. Keyed by absolute path; only ever grows (a few hundred bytes a session).
import { HANDLED_FILE } from "./config.ts";
import { readJsonOr, writeJsonAtomic } from "./util.ts";

function load(file: string): Set<string> {
  const list = readJsonOr<unknown>(file, []);
  return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []);
}

export function wasHandled(sessionFile: string, file = HANDLED_FILE): boolean {
  return load(file).has(sessionFile);
}

/** Remember that toriel ran a child on `sessionFile`; a write failure is logged by the caller, not fatal. */
export function recordHandled(sessionFile: string, file = HANDLED_FILE): void {
  const set = load(file);
  if (set.has(sessionFile)) {
    return;
  }
  set.add(sessionFile);
  writeJsonAtomic(file, [...set]);
}
