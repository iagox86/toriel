// Daemon state that is keyed by a session and would otherwise only ever grow:
// session-agents.json (a profile snapshot per profiled session, system prompt
// included) and handled-files.json (paths of session files toriel ran a child
// on). Both are read and parsed on every child start, so entries of sessions
// that are gone cost time as well as space. This drops the ones whose session
// file exists neither in place nor in the trash (a trashed session can be
// restored, and keeps its profile).
import * as fs from "node:fs";
import { HANDLED_FILE, SESSION_AGENTS_FILE } from "./config.ts";
import { readJsonOr, writeJsonAtomic } from "./util.ts";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** The session UUID in a session file's name (`<timestamp>_<uuid>.jsonl`, possibly with a trash prefix), or undefined. */
export function uuidOfFileName(file: string): string | undefined {
  const base = file.slice(file.lastIndexOf("/") + 1);
  const all = base.match(UUID);
  return all ? all[all.length - 1] : undefined;
}

export interface PruneInput {
  /** Every session file in place (from pi's own listing). */
  files: readonly { path: string; id?: string }[];
  /** Files sitting in the trash dir. */
  trashed: readonly string[];
}

export interface PruneResult {
  agents: number;
  handled: number;
}

/**
 * Drop stale entries from both files. Does nothing when `input.files` is empty: an empty
 * listing is more likely a misconfigured sessions directory than a machine with no sessions,
 * and dropping every profile then would be unrecoverable.
 */
export function pruneSessionState(input: PruneInput, agentsFile = SESSION_AGENTS_FILE, handledFile = HANDLED_FILE): PruneResult {
  const result: PruneResult = { agents: 0, handled: 0 };
  if (input.files.length === 0) {
    return result;
  }
  const alive = new Set<string>();
  for (const f of input.files) {
    if (f.id) {
      alive.add(f.id);
    }
    const fromName = uuidOfFileName(f.path);
    if (fromName) {
      alive.add(fromName);
    }
  }
  for (const f of input.trashed) {
    const id = uuidOfFileName(f);
    if (id) {
      alive.add(id);
    }
  }

  const agents = readJsonOr<Record<string, unknown>>(agentsFile, {});
  const keep: Record<string, unknown> = {};
  for (const [id, profile] of Object.entries(agents)) {
    if (alive.has(id)) {
      keep[id] = profile;
    } else {
      result.agents++;
    }
  }
  if (result.agents > 0) {
    writeJsonAtomic(agentsFile, keep);
  }

  // a path that is gone only costs a parse; one that the "open in another pi" check cares about has been written to recently, so it exists
  const handledList = readJsonOr<unknown>(handledFile, []);
  if (Array.isArray(handledList)) {
    const paths = handledList.filter((x): x is string => typeof x === "string");
    const kept = paths.filter((p) => fs.existsSync(p));
    result.handled = handledList.length - kept.length;
    if (result.handled > 0) {
      writeJsonAtomic(handledFile, kept);
    }
  }
  return result;
}
