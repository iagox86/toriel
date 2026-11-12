// Turning what someone typed after /watch into the path the daemon watches (board 98). Pure apart
// from two stat calls, which are injected.
import * as fs from "node:fs";
import * as path from "node:path";

export interface WatchTarget {
  /** Absolute, normalized, no trailing slash. */
  path: string;
  /** true: a directory (anything directly inside it counts); false: one file, watched through its parent. */
  dir: boolean;
}

interface FsApi {
  isDirectory(p: string): boolean;
}

const defaultFs: FsApi = {
  isDirectory: (p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
};

/**
 * `raw` is as typed: absolute, `~`/`~/x`, or relative to the session's directory `cwd`. An existing
 * directory is watched as a directory; a trailing slash insists on one; anything else is a file,
 * which need not exist yet (the usual case: waiting for it to appear) but whose directory must.
 * Throws a message meant to be shown.
 */
export function resolveWatchTarget(raw: string, cwd: string | undefined, home: string | undefined, fsApi: FsApi = defaultFs): WatchTarget {
  const text = raw.trim();
  if (text === "") {
    throw new Error("watch what? Give a file or directory path, e.g. /watch notes/review.md summarize what changed");
  }
  const wantsDir = /[\\/]$/.test(text);
  let expanded = text;
  if (text === "~" || text.startsWith("~/")) {
    if (!home) {
      throw new Error("cannot expand ~: no home directory is known; use an absolute path");
    }
    expanded = path.join(home, text.slice(1));
  }
  if (!path.isAbsolute(expanded) && cwd === undefined) {
    throw new Error(`${text} is relative and this session has no known directory; use an absolute path`);
  }
  const resolved = path.resolve(cwd ?? "/", expanded);
  if (resolved === path.parse(resolved).root) {
    throw new Error("refusing to watch the filesystem root");
  }
  if (fsApi.isDirectory(resolved)) {
    return { path: resolved, dir: true };
  }
  if (wantsDir) {
    throw new Error(`${resolved} is not an existing directory`);
  }
  const parent = path.dirname(resolved);
  if (!fsApi.isDirectory(parent)) {
    throw new Error(`${parent} does not exist, so ${path.basename(resolved)} cannot appear in it; create the directory first`);
  }
  return { path: resolved, dir: false };
}
