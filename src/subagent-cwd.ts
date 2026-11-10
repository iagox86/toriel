// Where a subagent may be spawned. Delegating never widens what a session may
// do: a child's cwd must be inside the parent's cwd (after symlinks) or a
// worktree of the same repository, because a child's scope root is its cwd and
// a child in $HOME or a sibling repo gets silent writes there. The repository
// identity is the realpath of the shared git directory (a main checkout's
// .git, or a linked worktree's gitdir resolved through its commondir file), so
// symlinked paths, relative gitdirs and worktrees of a bare repo all compare
// correctly.
import * as fs from "node:fs";
import * as path from "node:path";
import { isLinkedWorktreeRoot } from "./scope-root.ts";

type FsApi = {
  statSync: (p: string) => { isDirectory: () => boolean };
  lstatSync: (p: string) => { isFile: () => boolean };
  realpathSync: (p: string) => string;
  readFileSync: (p: string, encoding: string) => string;
};

const defaultFsApi: FsApi = {
  statSync: fs.statSync,
  lstatSync: fs.lstatSync,
  realpathSync: fs.realpathSync,
  readFileSync: (p) => fs.readFileSync(p, "utf8"),
};

/** The realpath of the shared git directory for a repo checkout, or undefined
 * when the directory is not a repo checkout. A main checkout's .git is a
 * directory; a linked worktree's .git file points at <main>/.git/worktrees/<name>
 * (relative allowed), and that gitdir's commondir file points at the shared
 * .git. Both forms are compared as realpaths so symlinked paths and worktrees
 * of a bare repo (the shared dir is the bare directory) match between the
 * parent and the child. The match only works at a checkout's root: cwd/.git is
 * the only probe, so a subdirectory of a worktree is not recognized as a
 * worktree (conservative: it must be inside the parent's cwd instead). */
export function sharedGitDir(cwd: string, fsApi: FsApi = defaultFsApi): string | undefined {
  const git = path.join(cwd, ".git");
  let st: { isDirectory: () => boolean };
  try {
    st = fsApi.statSync(git);
  } catch {
    return undefined;
  }
  if (st.isDirectory()) {
    try {
      return fsApi.realpathSync(git);
    } catch {
      return undefined;
    }
  }
  if (!isLinkedWorktreeRoot(cwd, fsApi)) {
    return undefined;
  }
  try {
    const raw = fsApi.readFileSync(git, "utf8").split("\n")[0].replace(/^gitdir: /, "").trim();
    const gitdir = path.resolve(cwd, raw);
    const commonFile = path.join(gitdir, "commondir");
    const common = fsApi.readFileSync(commonFile, "utf8").split("\n")[0].trim();
    return fsApi.realpathSync(path.resolve(gitdir, common));
  } catch {
    return undefined;
  }
}

export type CwdCheck = { ok: true } | { ok: false; error: string };

/** Absolute, an existing directory, and inside the parent's cwd or a worktree of the same repository. */
export function validateSubagentCwd(cwd: string, parentCwd: string, fsApi: FsApi = defaultFsApi): CwdCheck {
  if (!path.isAbsolute(cwd)) {
    return { ok: false, error: `subagent cwd must be an absolute path (got ${cwd}); a relative path resolves against the daemon's cwd, not the parent's` };
  }
  let st: { isDirectory: () => boolean };
  try {
    st = fsApi.statSync(cwd);
  } catch {
    return { ok: false, error: `working directory no longer exists: ${cwd}` };
  }
  if (!st.isDirectory()) {
    return { ok: false, error: `subagent cwd is not a directory: ${cwd}` };
  }
  let parentReal: string;
  try {
    parentReal = fsApi.realpathSync(parentCwd);
  } catch {
    return { ok: false, error: `parent working directory no longer exists: ${parentCwd}` };
  }
  const real = fsApi.realpathSync(cwd);
  if (real === parentReal || real.startsWith(parentReal + path.sep)) {
    return { ok: true };
  }
  const childGit = sharedGitDir(cwd, fsApi);
  const parentGit = sharedGitDir(parentCwd, fsApi);
  if (childGit !== undefined && parentGit !== undefined && childGit === parentGit) {
    return { ok: true };
  }
  return { ok: false, error: `subagent cwd must be inside the parent's directory (${parentCwd}) or a worktree of the same repository; refusing ${cwd} (delegating never widens what a session may do)` };
}
