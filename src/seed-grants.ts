// Read-only git/gh grants seeded into every subagent at spawn, so a worker can
// read repo state (status, diff, log, gh pr/issue/repo views) without
// prompting. Deliberately read-only: nothing here mutates a repo - the parent
// (manager) commits.
export const SEED_GRANTS: Array<{ surface: "bash"; pattern: string }> = [
  { surface: "bash", pattern: "git status*" },
  { surface: "bash", pattern: "git diff*" },
  { surface: "bash", pattern: "git log*" },
  { surface: "bash", pattern: "git show*" },
  { surface: "bash", pattern: "git blame*" },
  { surface: "bash", pattern: "git grep*" },
  { surface: "bash", pattern: "git branch*" },
  { surface: "bash", pattern: "git remote*" },
  { surface: "bash", pattern: "git fetch*" },
  { surface: "bash", pattern: "git pull*" },
  { surface: "bash", pattern: "gh pr view*" },
  { surface: "bash", pattern: "gh pr list*" },
  { surface: "bash", pattern: "gh pr checks*" },
  { surface: "bash", pattern: "gh pr diff*" },
  { surface: "bash", pattern: "gh issue view*" },
  { surface: "bash", pattern: "gh issue list*" },
  { surface: "bash", pattern: "gh repo view*" },
];
