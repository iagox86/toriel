// Reading pi's session files. One place for what several modules used to do each for themselves
// (board 183). `readHeader` needs only the first line, so it never reads the rest of a file that can be megabytes;
// `readEntries` is for code that interprets a session (migrated to pi's current format); `readLines` is for code that
// keeps or rewrites the file's own text, or reports positions in it.
import * as fs from "node:fs";
import { migrateSessionEntries, parseSessionEntries } from "@earendil-works/pi-coding-agent";

/** More than any real header line (id, timestamp, cwd, parent); a file whose first line is longer is treated as unreadable. */
const HEADER_MAX_BYTES = 64 * 1024;

/** The first line of a session file, parsed: pi's `{type: "session", id, cwd, ...}` header. Undefined when the file is missing, empty or its first line is not a JSON object. */
export function readHeader(file: string): Record<string, unknown> | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(HEADER_MAX_BYTES);
    const n = fs.readSync(fd, buf, 0, HEADER_MAX_BYTES, 0);
    const end = buf.subarray(0, n).indexOf(0x0a);
    // a header with no newline yet (or none within the cap) is only usable when the whole file fits
    if (end === -1 && n === HEADER_MAX_BYTES) {
      return undefined;
    }
    const parsed: unknown = JSON.parse(buf.toString("utf8", 0, end === -1 ? n : end));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

/** The session UUID from a session file's header line, if readable. */
export function sessionIdOfFile(file: string): string | undefined {
  const id = readHeader(file)?.id;
  return typeof id === "string" ? id : undefined;
}

/** A session file entry as the readers hand it out: `type` says which kind, the rest depends on it. Callers narrow it to the fields they use. */
export interface SessionEntryLike {
  type?: string;
  id?: string;
  [key: string]: unknown;
}

/**
 * Every entry of a session file, brought to the current file format first (pi's own migration: ids for a
 * version-1 file, `custom` for the old `hookMessage` role), so a reader sees one shape whatever wrote the file.
 * Lines that do not parse (a torn trailing line while pi is writing) are skipped. For reading only: use
 * `readLines` where the file's bytes are kept or rewritten.
 *
 * Deliberately not pi's `loadEntriesFromFile`: that one appends a newline to a file whose last line is
 * unterminated, and this reads files pi may be writing right now.
 */
export function readEntries<T extends SessionEntryLike = SessionEntryLike>(file: string): T[] {
  const entries = parseSessionEntries(fs.readFileSync(file, "utf8")) as unknown as T[];
  try {
    migrateSessionEntries(entries as never);
  } catch {
    // an entry too odd to migrate is shown as it is rather than hiding the whole file
  }
  return entries;
}

/**
 * The entries of the conversation as it stands: the chain from the newest entry back to the root through `parentId`
 * (pi's own rule: a session is a tree, the leaf is the last entry written, and branches left behind by tree
 * navigation are not part of what the model sees). The header is not included. For a linear file, which is every file
 * toriel itself writes, this is all the entries in file order.
 *
 * A tree that does not hold together (an entry without an id or a `parentId`, a `parentId` naming nothing, a cycle) is not guessed at:
 * every entry in file order comes back instead, so a damaged file shows too much rather than too little.
 */
export function activePath<T extends SessionEntryLike>(entries: readonly T[]): T[] {
  const body = entries.filter((e): e is T => typeof e === "object" && e !== null && e.type !== "session");
  const byId = new Map<string, T>();
  for (const e of body) {
    if (typeof e.id !== "string") {
      return body;
    }
    byId.set(e.id, e);
  }
  const path: T[] = [];
  const seen = new Set<string>();
  for (let at: T | undefined = body[body.length - 1]; at; ) {
    if (seen.has(at.id as string)) {
      return body; // a cycle
    }
    seen.add(at.id as string);
    path.push(at);
    const parent: unknown = at.parentId;
    if (parent === null) {
      break; // the root: pi writes null there
    }
    at = typeof parent === "string" ? byId.get(parent) : undefined;
    if (at === undefined) {
      return body; // no parentId at all, or one that names nothing in the file
    }
  }
  return path.reverse();
}

/** `readEntries`, narrowed to the conversation as it stands (see `activePath`). */
export function readActiveEntries<T extends SessionEntryLike = SessionEntryLike>(file: string): T[] {
  return activePath(readEntries<T>(file));
}

/** One physical line of a session file with its parse, for code that must keep the file's own text. */
export interface SessionLine<T extends SessionEntryLike = SessionEntryLike> {
  raw: string;
  /** Undefined for a blank line or one that does not parse (torn). */
  entry?: T;
}

/**
 * The physical lines of a session file in order, blank ones included (so a position is a line number), each with
 * its entry as written: no migration, because these callers write lines back or report positions in the file.
 */
export function readLines<T extends SessionEntryLike = SessionEntryLike>(file: string): Array<SessionLine<T>> {
  return parseLines<T>(fs.readFileSync(file, "utf8"));
}

/** `readLines` on text already read. */
export function parseLines<T extends SessionEntryLike = SessionEntryLike>(text: string): Array<SessionLine<T>> {
  return text.split("\n").map((raw) => {
    if (!raw) {
      return { raw };
    }
    try {
      return { raw, entry: JSON.parse(raw) as T };
    } catch {
      return { raw };
    }
  });
}
