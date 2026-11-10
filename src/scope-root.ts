import * as fs from "node:fs";
import * as path from "node:path";

type FsApi = {
  lstatSync: (p: string) => { isFile: () => boolean };
  realpathSync: (p: string) => string;
  readFileSync: (p: string, encoding: string) => string;
};

const defaultFsApi: FsApi = { lstatSync: fs.lstatSync, realpathSync: fs.realpathSync, readFileSync: (p) => fs.readFileSync(p, "utf8") };

/**
 * The write-scope assignment for a session's child, or undefined (unscoped).
 * The root is always the realpath of the launch cwd; the mode says what the scope
 * link does with a covered write outside it - deny it outright (T1's contract for
 * linked worktrees) or defer to the dialog/grants path (every other launch dir).
 */
export type ScopeAssignment = { root: string; mode: "deny" } | { root: string; mode: "ask" };

/**
 * The linked-worktree probe: `cwd/.git` is a regular file whose first line is
 * `gitdir: <p>` under `.git/worktrees/<name>`; a submodule's `.git` file points
 * into `.git/modules/...` and does not match. Any other case, including any fs
 * error while probing, is false. Never throws.
 */
export function isLinkedWorktreeRoot(cwd: string, fsApi: FsApi = defaultFsApi): boolean {
  try {
    const dotGit = path.join(cwd, ".git");
    if (!fsApi.lstatSync(dotGit).isFile()) {
      return false;
    }
    const firstLine = fsApi.readFileSync(dotGit, "utf8").split("\n")[0];
    return /^gitdir: .*[\\/]worktrees[\\/][^\\/]+[\\/]*$/.test(firstLine);
  } catch {
    return false;
  }
}

/**
 * The scope for a profiled session (decision 2 of SPEC-172-T8): every profile
 * spawn is scoped to its launch directory - deny mode iff that directory is the
 * root of a linked git worktree (T1's incident), ask mode otherwise. Unprofiled
 * sessions, and any fs error resolving the root, are unscoped. Never throws.
 * A `scope: none` profile is unscoped: the caller passes hasProfile false for it.
 */
export function scopeForSession(cwd: string, hasProfile: boolean, fsApi: FsApi = defaultFsApi): ScopeAssignment | undefined {
  if (!hasProfile) {
    return undefined;
  }
  try {
    return { root: fsApi.realpathSync(cwd), mode: isLinkedWorktreeRoot(cwd, fsApi) ? "deny" : "ask" };
  } catch {
    return undefined;
  }
}

/**
 * T1's contract, kept for compatibility: the write scope iff the session is a
 * profile session at a linked-worktree root (a scope whose mode is deny).
 */
export function scopeRootFor(cwd: string, hasProfile: boolean, fsApi: FsApi = defaultFsApi): string | undefined {
  const scope = scopeForSession(cwd, hasProfile, fsApi);
  return scope?.mode === "deny" ? scope.root : undefined;
}
