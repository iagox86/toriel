import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SEED_GRANTS } from "../src/seed-grants.ts";

// git/gh subcommands that change anything; a seeded grant must never cover them
const MUTATING = ["commit", "push", "checkout", "rebase", "merge", "add", "reset", "stash", "rm ", "fetch", "pull", "branch -D", "branch -f", "branch -m", "branch -c", "branch --set-upstream", "branch --edit-description", "remote add", "remote remove", "remote set-url", "remote prune", "remote rename"];

// exact entries that are not wildcard patterns
const EXACT = ["git remote", "git remote -v", "git branch -a", "git branch -r", "git branch -v", "git branch -vv", "git branch -av"];

describe("SEED_GRANTS", () => {
  it("is bash-only, every pattern ends in * or is exact, and none covers a mutating git subcommand", () => {
    for (const g of SEED_GRANTS) {
      assert.equal(g.surface, "bash");
      assert.ok(/\*$/.test(g.pattern) || EXACT.includes(g.pattern), `${g.pattern} must end in * or be exact`);
      const cmd = g.pattern.replace(/\*$/, "");
      assert.ok(!MUTATING.some((m) => cmd.includes(`git ${m}`)), `${g.pattern} looks mutating`);
    }
  });

  it("no wildcard pattern covers a mutating git invocation through its trailing wildcard", () => {
    for (const g of SEED_GRANTS) {
      if (!g.pattern.endsWith("*")) {
        continue;
      }
      const cmd = g.pattern.replace(/\*$/, "");
      assert.ok(!cmd.includes("git branch -D"), `${g.pattern} covers git branch -D`);
      assert.ok(!cmd.includes("git branch -f"), `${g.pattern} covers git branch -f`);
      assert.ok(!cmd.includes("git branch -m"), `${g.pattern} covers git branch -m`);
      assert.ok(!cmd.includes("git branch -u"), `${g.pattern} covers git branch -u`);
      assert.ok(!cmd.includes("git remote set-url"), `${g.pattern} covers git remote set-url`);
      assert.ok(!cmd.includes("git remote add"), `${g.pattern} covers git remote add`);
      assert.ok(!cmd.includes("git remote prune"), `${g.pattern} covers git remote prune`);
    }
  });

  it("covers the read-only git and gh commands the spec names", () => {
    const patterns = SEED_GRANTS.map((g) => g.pattern);
    for (const p of ["git status*", "git diff*", "git log*", "git show*", "git blame*", "git grep*", "git branch --list*", "git branch --show-current*", "git branch -a", "git branch -r", "git branch -v", "git branch -vv", "git branch -av", "git remote", "git remote -v", "git remote get-url*", "git remote show*", "gh pr view*", "gh pr list*", "gh pr checks*", "gh pr diff*", "gh issue view*", "gh issue list*", "gh repo view*"]) {
      assert.ok(patterns.includes(p), `missing ${p}`);
    }
  });

  it("does not seed git fetch or git pull", () => {
    const patterns = SEED_GRANTS.map((g) => g.pattern);
    for (const p of patterns) {
      assert.ok(!p.startsWith("git fetch") && !p.startsWith("git pull"), `${p} mutates a repo through a shared worktree`);
    }
  });
});
