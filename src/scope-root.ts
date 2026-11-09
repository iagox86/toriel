import * as fs from "node:fs";
import * as path from "node:path";

type FsApi = {
  lstatSync: (p: string) => { isFile: () => boolean };
  realpathSync: (p: string) => string;
  readFileSync: (p: string, encoding: string) => string;
};

/**
 * The write scope for a session's child, or undefined (unscoped): the realpath of `cwd` iff
 * `cwd` is the root of a linked git worktree AND the session has a profile (decision 6 of
 * SPEC-163-T1). A linked worktree's `.git` is a regular file whose first line is
 * `gitdir: <p>` under `.git/worktrees/<name>`; a submodule's `.git` file points into
 * `.git/modules/...` and does not match. Any other case, including any fs error while
 * probing, is unscoped. Never throws.
 */
export function scopeRootFor(cwd: string, hasProfile: boolean, fsApi: FsApi = { lstatSync: fs.lstatSync, realpathSync: fs.realpathSync, readFileSync: (p) => fs.readFileSync(p, "utf8") }): string | undefined {
  if (!hasProfile) {
    return undefined;
  }
  try {
    const dotGit = path.join(cwd, ".git");
    if (!fsApi.lstatSync(dotGit).isFile()) {
      return undefined;
    }
    const firstLine = fsApi.readFileSync(dotGit, "utf8").split("\n")[0];
    if (!/^gitdir: .*[\\/]worktrees[\\/][^\\/]+[\\/]*$/.test(firstLine)) {
      return undefined;
    }
    return fsApi.realpathSync(cwd);
  } catch {
    return undefined;
  }
}
