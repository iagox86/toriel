// Small helpers shared by modules that otherwise each wrote their own copy.
import * as fs from "node:fs";
import * as path from "node:path";

/** The message of a caught value, whatever was thrown. */
export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Start `work` without waiting for it, and say so through `notify` if it fails. For a key press or command
 * that kicks off async work: a rejection nobody handles would otherwise reach the controller's catch-all
 * (a generic "something went wrong") or, for the daemon, end the process.
 */
export function fireAndReport(work: Promise<unknown>, what: string, notify: (text: string) => void): void {
  work.catch((err: unknown) => notify(`${what} failed: ${errText(err)}`));
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
 * Move `from` to `to`, also across filesystems (rename(2) refuses that with EXDEV: a tmpfs trash dir next to
 * session files in the home directory, or an isolated instance's runtime dir). The copy lands whole before the
 * original goes, so a failure never loses it. `rename` is a parameter only so a test can stand in for a second
 * filesystem.
 */
export function moveFile(from: string, to: string, rename: (a: string, b: string) => void = fs.renameSync): void {
  try {
    rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") {
      throw err;
    }
    const tmp = `${to}.tmp.${process.pid}`;
    fs.copyFileSync(from, tmp);
    fs.renameSync(tmp, to);
    fs.unlinkSync(from);
  }
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

/** Whether `name` is an executable in one of `dirs`. */
export function onPathDirs(name: string, dirs: readonly string[]): boolean {
  return dirs.some((dir) => {
    try {
      fs.accessSync(path.join(dir, name), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}
