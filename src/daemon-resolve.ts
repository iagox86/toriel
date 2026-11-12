// Finding a session from what someone typed: the daemon's own sessions first,
// then the session files on disk (slower), so a never-opened session works too.
import * as fs from "node:fs";
import { join } from "node:path";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import type { Cmd, DaemonContext, Responder } from "./daemon-context.ts";
import type { DaemonSession } from "./daemon-session.ts";
import { isUuid, resolveSession } from "./session-id.ts";

export interface FoundSession {
  /** Daemon number; -1 when only the file is known. */
  id: number;
  uuid?: string;
  name?: string;
  file?: string;
  cwd?: string;
  /** The daemon's record, when it holds one. */
  session?: DaemonSession;
}

/**
 * The project directory holding a session file, for a query that is a full UUID: pi names files
 * `<timestamp>_<uuid>.jsonl`, so listing directory names finds it without parsing any session.
 * Undefined (scan everything) for anything else, or when no file carries that id.
 */
export function dirOfSession(query: string, sessionsDir: string = join(getAgentDir(), "sessions")): string | undefined {
  if (!isUuid(query)) {
    return undefined;
  }
  const suffix = `_${query.toLowerCase()}.jsonl`;
  let found: string | undefined;
  try {
    for (const entry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        continue;
      }
      const dir = join(sessionsDir, entry.name);
      try {
        if (fs.readdirSync(dir).some((f) => f.toLowerCase().endsWith(suffix))) {
          if (found !== undefined) {
            return undefined; // a copied file: let the full scan see both and report the ambiguity
          }
          found = dir;
        }
      } catch {
        // an unreadable directory is skipped, as pi's own listing skips it
      }
    }
  } catch {
    // no sessions directory: the full listing will say so
  }
  return found;
}

/** Throws a user-readable error when nothing, or more than one session, matches. */
export async function findSession(ctx: DaemonContext, query: string): Promise<FoundSession> {
  const known: FoundSession[] = ctx.registry.all().map((s) => ({ id: s.id, uuid: s.sessionId, name: s.sessionName, file: s.sessionFile, cwd: s.cwd, session: s }));
  const asAddressable = (list: FoundSession[]) => list.map((f) => ({ ...f, sessionId: f.uuid, sessionName: f.name }));
  let r = resolveSession(query, asAddressable(known));
  if (r.kind === "none") {
    const infos = await SessionManager.listAll(dirOfSession(query.trim()));
    const onDisk: FoundSession[] = infos.map((i) => ({ id: -1, uuid: i.id, name: i.name, file: i.path, cwd: i.cwd }));
    r = resolveSession(query, asAddressable(onDisk));
  }
  if (r.kind === "none") {
    throw new Error(`no session matches "${query}"`);
  }
  if (r.kind === "ambiguous") {
    const shown = r.matches.slice(0, 5).map((m) => `${m.sessionName ?? "(unnamed)"} ${m.sessionId ?? "?"}`).join("; ");
    throw new Error(`"${query}" matches ${r.matches.length} sessions (${shown}) - use the session id`);
  }
  const { sessionId: _a, sessionName: _b, ...found } = r.session;
  return found;
}

export async function handleResolve(ctx: DaemonContext, cmd: Cmd<"resolve">, res: Responder): Promise<void> {
  const f = await findSession(ctx, cmd.query);
  res(true, undefined, { uuid: f.uuid, name: f.name, file: f.file, id: f.id >= 0 ? f.id : undefined });
}
