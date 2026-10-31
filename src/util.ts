// Small helpers shared by modules that otherwise each wrote their own copy.
import * as fs from "node:fs";
import * as path from "node:path";

/** The message of a caught value, whatever was thrown. */
export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Replace `file` in one step (temp file in the same directory, then rename), so a crash never leaves it half written. */
export function writeFileAtomic(file: string, text: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, text, mode === undefined ? "utf8" : { mode });
  fs.renameSync(tmp, file);
}

/** `writeFileAtomic` for a value, as two-space JSON with a trailing newline. */
export function writeJsonAtomic(file: string, data: unknown, mode?: number): void {
  writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`, mode);
}

/**
 * Keep a log file from growing forever: once it is over `maxBytes`, move it to
 * `<file>.1` (replacing the previous one). Writers reopen the path on every append,
 * so they simply start a fresh file. Returns whether it rotated.
 */
export function rotateLog(file: string, maxBytes = 5 * 1024 * 1024): boolean {
  try {
    if (fs.statSync(file).size <= maxBytes) {
      return false;
    }
    fs.renameSync(file, `${file}.1`);
    return true;
  } catch {
    return false; // no log yet, or nothing we can do about it
  }
}

/** The parsed JSON in `file`, or `fallback` when it is missing or unreadable. */
export function readJsonOr<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}
