import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { sharedGitDir, validateSubagentCwd } from "../src/subagent-cwd.ts";

/** A temp tree with a main checkout, a subdir of it, a linked worktree of it,
 * and a sibling repo. Returns the worktree's main checkout path. */
function fixture(): { root: string; main: string; subdir: string; worktree: string; sibling: string; worktreeOf: (main: string) => string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-cwd-"));
  const main = path.join(root, "main");
  fs.mkdirSync(path.join(main, ".git"), { recursive: true });
  fs.mkdirSync(path.join(main, "docs"), { recursive: true });
  const subdir = path.join(main, "docs");
  const sibling = path.join(root, "sibling");
  fs.mkdirSync(path.join(sibling, ".git"), { recursive: true });
  const worktreeOf = (mainDir: string) => {
    const wt = path.join(mainDir, "..", `wt-${path.basename(mainDir)}`);
    fs.mkdirSync(wt, { recursive: true });
    fs.mkdirSync(path.join(mainDir, ".git", "worktrees", "wt"), { recursive: true });
    fs.writeFileSync(path.join(mainDir, ".git", "worktrees", "wt", "commondir"), `${mainDir}/.git\n`);
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(mainDir, ".git", "worktrees", "wt")}\n`);
    return wt;
  };
  const worktree = worktreeOf(main);
  return { root, main, subdir, worktree, sibling, worktreeOf };
}

describe("sharedGitDir", () => {
  it("returns the realpath of .git for a main checkout", () => {
    const f = fixture();
    assert.equal(sharedGitDir(f.main), fs.realpathSync(path.join(f.main, ".git")));
    assert.equal(sharedGitDir(f.sibling), fs.realpathSync(path.join(f.sibling, ".git")));
  });

  it("follows a linked worktree's .git file and commondir to the shared .git", () => {
    const f = fixture();
    assert.equal(sharedGitDir(f.worktree), fs.realpathSync(path.join(f.main, ".git")));
  });

  it("resolves a relative gitdir path against the worktree's cwd", () => {
    const f = fixture();
    const wt = path.join(f.root, "rel-wt");
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, ".git"), "gitdir: ../main/.git/worktrees/wt\n");
    assert.equal(sharedGitDir(wt), fs.realpathSync(path.join(f.main, ".git")));
  });

  it("resolves a relative commondir (git's real layout writes ../..)", () => {
    const f = fixture();
    const wt = path.join(f.root, "rel-common");
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, ".git"), "gitdir: ../main/.git/worktrees/wt\n");
    fs.writeFileSync(path.join(f.main, ".git", "worktrees", "wt", "commondir"), "../..\n");
    assert.equal(sharedGitDir(wt), fs.realpathSync(path.join(f.main, ".git")));
  });

  it("returns undefined for a non-repo directory", () => {
    const f = fixture();
    assert.equal(sharedGitDir(f.subdir), undefined);
  });
});

describe("validateSubagentCwd", () => {
  it("accepts the parent's own cwd and subdirectories of it", () => {
    const f = fixture();
    assert.ok(validateSubagentCwd(f.main, f.main).ok);
    assert.ok(validateSubagentCwd(f.subdir, f.main).ok);
  });

  it("accepts a linked worktree of the parent's repo", () => {
    const f = fixture();
    assert.ok(validateSubagentCwd(f.worktree, f.main).ok);
  });

  it("accepts a worktree whose parent session is itself a worktree", () => {
    const f = fixture();
    assert.ok(validateSubagentCwd(f.worktree, f.worktree).ok);
  });

  it("rejects a worktree of a DIFFERENT repo (same parent dir, different .git)", () => {
    const f = fixture();
    const other = f.worktreeOf(f.sibling);
    assert.ok(!validateSubagentCwd(other, f.main).ok);
  });

  it("rejects a relative path, a file, a sibling repo, and a directory outside the parent", () => {
    const f = fixture();
    assert.ok(!validateSubagentCwd("docs", f.main).ok);
    assert.ok(!validateSubagentCwd(f.sibling, f.main).ok);
    assert.ok(!validateSubagentCwd(f.root, f.main).ok);
    const file = path.join(f.root, "file");
    fs.writeFileSync(file, "x");
    assert.ok(!validateSubagentCwd(file, f.main).ok);
  });
});
