import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SEED_GRANTS } from "../src/seed-grants.ts";

// git/gh subcommands that change anything; a seeded grant must never cover them
const MUTATING = ["commit", "push", "checkout", "rebase", "merge", "add", "reset", "stash", "rm "];

describe("SEED_GRANTS", () => {
  it("is bash-only, every pattern ends in a wildcard, and none covers a mutating git subcommand", () => {
    for (const g of SEED_GRANTS) {
      assert.equal(g.surface, "bash");
      assert.match(g.pattern, /\*$/, `${g.pattern} must end in *`);
      const cmd = g.pattern.slice(0, -1);
      assert.ok(!MUTATING.some((m) => cmd.includes(`git ${m}`)), `${g.pattern} looks mutating`);
    }
  });

  it("covers the read-only git and gh commands the spec names", () => {
    const patterns = SEED_GRANTS.map((g) => g.pattern);
    for (const p of ["git status*", "git diff*", "git log*", "git show*", "git blame*", "git grep*", "git branch*", "git remote*", "git fetch*", "git pull*", "gh pr view*", "gh pr list*", "gh pr checks*", "gh pr diff*", "gh issue view*", "gh issue list*", "gh repo view*"]) {
      assert.ok(patterns.includes(p), `missing ${p}`);
    }
  });
});
