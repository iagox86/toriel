// Read-only git/gh grants seeded into every subagent at spawn, so a worker can
// read repo state (status, diff, log, gh pr/issue/repo views) without
// prompting. Deliberately read-only: nothing here mutates a repo - the parent
// (manager) commits.
//
// Deliberately not seeded: git fetch and git pull (pull merges into the
// worker's branch and fetch can delete refs and run upload-pack; a linked
// worktree shares refs and objects with the main checkout, so refreshing the
// branch is the manager's job). git branch and git remote are narrowed to
// their read subcommands - the bare forms would also cover `git branch -D`,
// `git remote set-url`, and friends. Residual caveats: `git grep -O<pager>`
// and `git diff/log --output=<file>` can write or run a command, but under a
// mistakes-only threat model those are unlikely; this list is not read-only
// by construction, it is read-only by review.
export const SEED_GRANTS: Array<{ surface: "bash"; pattern: string }> = [
  { surface: "bash", pattern: "git status*" },
  { surface: "bash", pattern: "git diff*" },
  { surface: "bash", pattern: "git log*" },
  { surface: "bash", pattern: "git show*" },
  { surface: "bash", pattern: "git blame*" },
  { surface: "bash", pattern: "git grep*" },
  { surface: "bash", pattern: "git branch --list*" },
  { surface: "bash", pattern: "git branch --show-current*" },
  { surface: "bash", pattern: "git branch -a" },
  { surface: "bash", pattern: "git branch -r" },
  // -v is not a mode flag in git (git branch -v -D x is legal), so it is exact
  { surface: "bash", pattern: "git branch -v" },
  { surface: "bash", pattern: "git branch -vv" },
  { surface: "bash", pattern: "git branch -av" },
  { surface: "bash", pattern: "git remote" },
  { surface: "bash", pattern: "git remote -v" },
  { surface: "bash", pattern: "git remote get-url*" },
  { surface: "bash", pattern: "git remote show*" },
  { surface: "bash", pattern: "gh pr view*" },
  { surface: "bash", pattern: "gh pr list*" },
  { surface: "bash", pattern: "gh pr checks*" },
  { surface: "bash", pattern: "gh pr diff*" },
  { surface: "bash", pattern: "gh issue view*" },
  { surface: "bash", pattern: "gh issue list*" },
  { surface: "bash", pattern: "gh repo view*" },
];
