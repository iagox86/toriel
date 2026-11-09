import * as fs from "node:fs";
import * as path from "node:path";

export const SCOPE_ENV = "TORIEL_SCOPE_ROOT";

export type Scope =
  | { kind: "off" }
  | { kind: "root"; root: string }
  | { kind: "invalid"; why: string };

type FsApi = {
  realpathSync: (p: string) => string;
  statSync: (p: string) => { isDirectory: () => boolean };
};

/**
 * Resolve TORIEL_SCOPE_ROOT from a child's env into a Scope.
 *
 * Absent (undefined) is the only "off". Every present value that fails
 * validation is "invalid" (fail-closed), never trimmed or repaired.
 * Never throws: an fs error while probing yields "invalid".
 */
export function readScope(env: Record<string, string | undefined>, fsApi: FsApi = { realpathSync: fs.realpathSync, statSync: fs.statSync }): Scope {
  try {
    const value = env[SCOPE_ENV];
    if (value === undefined) {
      return { kind: "off" };
    }
    if (!path.isAbsolute(value)) {
      return { kind: "invalid", why: "not an absolute path" };
    }
    if (value === path.parse(value).root) {
      return { kind: "invalid", why: "is the filesystem root, which would allow everything" };
    }
    if (!fsApi.statSync(value).isDirectory()) {
      return { kind: "invalid", why: "is not a directory" };
    }
    const real = fsApi.realpathSync(value);
    if (real !== value) {
      return { kind: "invalid", why: `is not canonical (resolves to ${real})` };
    }
    return { kind: "root", root: value };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { kind: "invalid", why: `does not exist or cannot be stat'd (${detail})` };
  }
}

/**
 * Lexical containment for canonical paths.
 *
 * true iff target === root or target starts with root + separator (the
 * separator defeats the sibling-prefix trap: /x/W-evil is not inside /x/W).
 * Non-absolute targets, and targets containing a ".." segment (non-canonical
 * text that is not provably inside), are outside. Callers pass the gate's
 * canonical boundaryValue; we do not resolve here, because a not-yet-existing
 * target has nothing to resolve to and re-resolving would lose the gate's
 * canonicalisation.
 */
export function isInside(root: string, target: string): boolean {
  if (!path.isAbsolute(target)) {
    return false;
  }
  if (target.split(path.sep).includes("..")) {
    return false;
  }
  if (target === root) {
    return true;
  }
  return target.startsWith(root + path.sep);
}
