// Reading pi's session files. One place for what several modules used to do each for themselves
// (board 183); this part only needs the first line, so it never reads the rest of a file that can be megabytes.
import * as fs from "node:fs";

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
