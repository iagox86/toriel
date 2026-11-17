// File freshness (ticket 13, tool-efficiency study of ticket 63): the session remembers what it has read and written, and refuses to
// edit or overwrite a file it has not read or that changed since (by you, a command, another session). pi's own write tool replaces
// any file without looking, and its edit tool matches against whatever is on disk now, so an agent working from a stale view silently
// destroys newer work. Claude Code refuses both; this is the same rule. The store lives in the extension's memory: it is the one place
// that sees every tool call, and it matches the process lifetime (a resumed session has no store, and the model has to re-read anyway).
// Only observes and blocks: it never throws, and any doubt (a file it cannot stat, a path it cannot resolve) lets the call go on.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** Set to "off" in a child's environment (the fileFreshness setting is false) to turn the check off. */
export const FRESHNESS_ENV = "TORIEL_FRESHNESS";
/** Files up to this size also keep a content hash, so a touch or a formatter that rewrote the same bytes is not mistaken for a change. */
export const HASH_MAX_BYTES = 2 * 1024 * 1024;

export interface Seen {
  mtimeMs: number;
  size: number;
  /** Present for a file up to HASH_MAX_BYTES. */
  hash?: string;
}

export type FileTool = "read" | "write" | "edit";

/** The tools the check cares about, and whether they change the file. */
export function fileTool(name: unknown): FileTool | undefined {
  return name === "read" || name === "write" || name === "edit" ? name : undefined;
}

/** The absolute path a call names, or undefined when it names none (the `@` prefix some models add is dropped, `~` is the home directory). */
export function targetPath(input: unknown, cwd: string, home: string | undefined = process.env.HOME): string | undefined {
  const raw = (input as { path?: unknown } | undefined)?.path;
  if (typeof raw !== "string" || raw === "") {
    return undefined;
  }
  const p = raw.replace(/^@/, "");
  const expanded = p === "~" ? home : p.startsWith("~/") && home ? path.join(home, p.slice(2)) : p;
  return expanded === undefined ? undefined : path.resolve(cwd, expanded);
}

function digest(file: string): string | undefined {
  try {
    return crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return undefined;
  }
}

/** What a regular file looks like right now, or undefined when it does not exist, is not a regular file or cannot be stat'ed. */
export function snapshot(file: string): Seen | undefined {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) {
      return undefined;
    }
    return { mtimeMs: st.mtimeMs, size: st.size, hash: st.size <= HASH_MAX_BYTES ? digest(file) : undefined };
  } catch {
    return undefined;
  }
}

/** The key a file is stored under: its real path, so a symlink and its target are one file. */
function keyOf(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

export class FreshnessStore {
  private seen = new Map<string, Seen>();

  /** Note that the session has seen `file` as it is now (after a read, or after its own write or edit). */
  record(file: string): void {
    const now = snapshot(file);
    if (now !== undefined) {
      this.seen.set(keyOf(file), now);
    }
  }

  /** Whether the session has any record of `file`. */
  knows(file: string): boolean {
    return this.seen.has(keyOf(file));
  }

  /**
   * Why a write or edit of `file` must not go ahead (the text the model sees), or undefined when it may. `shown` is the path as the
   * model wrote it. A file that does not exist (a new one), is not a regular file or cannot be stat'ed is not this check's business.
   */
  verdict(tool: "write" | "edit", file: string, shown: string): string | undefined {
    const now = snapshot(file);
    if (now === undefined) {
      return undefined;
    }
    const key = keyOf(file);
    const before = this.seen.get(key);
    const verb = tool === "edit" ? "edited" : "overwritten";
    if (before === undefined) {
      return `${shown} has not been read in this session, so it cannot be ${verb} yet: read it first (the read tool), then try again.`;
    }
    if (now.mtimeMs === before.mtimeMs && now.size === before.size) {
      return undefined;
    }
    // changed time but the very same bytes (touch, a formatter that rewrote an unchanged file): not a change the model needs to see
    if (now.size === before.size && now.hash !== undefined && now.hash === before.hash) {
      this.seen.set(key, now);
      return undefined;
    }
    return `${shown} has changed since you read it (you, another session, or a command changed it), so it cannot be ${verb} from your earlier view: read it again, then try again.`;
  }
}
