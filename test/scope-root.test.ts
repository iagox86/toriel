import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import { SCOPE_ENV, isInside, readScope } from "../pi/extensions/lib/scope-root.ts";
import type { Scope } from "../pi/extensions/lib/scope-root.ts";
import { scopeRootFor } from "../src/scope-root.ts";

function freshTmpdir(): string {
  // /tmp may itself be a symlink on some hosts; every W must be canonical.
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "toriel-scope-")));
}

function assertInvalid(scope: Scope, label: string): void {
  if (scope.kind !== "invalid") {
    throw new Error(`${label}: expected invalid, got ${JSON.stringify(scope)}`);
  }
  assert.equal(typeof scope.why, "string", `${label}: why must be a string`);
  assert.ok(scope.why.length > 0, `${label}: why must be non-empty`);
}

describe("readScope", () => {
  it("is off when TORIEL_SCOPE_ROOT is unset", () => {
    assert.deepEqual(readScope({}), { kind: "off" });
    assert.deepEqual(readScope({ [SCOPE_ENV]: undefined }), { kind: "off" });
  });

  it("treats an empty or whitespace-only value as invalid, not off", () => {
    assertInvalid(readScope({ [SCOPE_ENV]: "" }), "empty");
    assertInvalid(readScope({ [SCOPE_ENV]: "  " }), "whitespace");
  });

  it("rejects a relative value", () => {
    assertInvalid(readScope({ [SCOPE_ENV]: "relative/dir" }), "relative");
  });

  it("rejects the filesystem root", () => {
    assertInvalid(readScope({ [SCOPE_ENV]: "/" }), "root");
  });

  it("rejects a nonexistent absolute path", () => {
    assertInvalid(readScope({ [SCOPE_ENV]: "/definitely/not/here-toriel" }), "nonexistent");
  });

  it("rejects a regular file", () => {
    const dir = freshTmpdir();
    const file = path.join(dir, "file.txt");
    fs.writeFileSync(file, "x");
    assertInvalid(readScope({ [SCOPE_ENV]: file }), "file");
  });

  it("accepts a real canonical directory as the root", () => {
    const dir = freshTmpdir();
    assert.deepEqual(readScope({ [SCOPE_ENV]: dir }), { kind: "root", root: dir });
  });

  it("rejects a symlink to a real directory (not canonical)", () => {
    const dir = freshTmpdir();
    const link = path.join(dir, "link");
    fs.symlinkSync(dir, link);
    assertInvalid(readScope({ [SCOPE_ENV]: link }), "symlink");
  });

  it("rejects a value with a trailing slash (not canonical)", () => {
    const dir = freshTmpdir();
    assertInvalid(readScope({ [SCOPE_ENV]: `${dir}/` }), "trailing slash");
  });

  it("rejects a non-canonical value containing ..", () => {
    const dir = freshTmpdir();
    const value = `${dir}/../${path.basename(dir)}`;
    assertInvalid(readScope({ [SCOPE_ENV]: value }), "dotdot");
  });

  it("returns invalid, not a throw, when statSync throws", () => {
    const fsApi = {
      realpathSync: (p: string): string => p,
      statSync: (): { isDirectory: () => boolean } => {
        throw new Error("ENOENT");
      },
    };
    assertInvalid(readScope({ [SCOPE_ENV]: "/anything" }, fsApi), "statSync throw");
  });

  it("names the resolved path when realpathSync disagrees with the value", () => {
    const dir = freshTmpdir();
    const fsApi = {
      realpathSync: (p: string): string => `${p}-resolved`,
      statSync: (_p: string): { isDirectory: () => boolean } => ({ isDirectory: () => true }),
    };
    const scope = readScope({ [SCOPE_ENV]: dir }, fsApi);
    if (scope.kind !== "invalid") {
      throw new Error("expected invalid");
    }
    assert.match(scope.why, /resolved/);
  });
});

describe("isInside", () => {
  const W = "/w";

  it("includes W itself", () => {
    assert.equal(isInside(W, W), true);
  });

  it("includes direct and nested children", () => {
    assert.equal(isInside(W, `${W}/f.txt`), true);
    assert.equal(isInside(W, `${W}/a/b/c`), true);
  });

  it("excludes the sibling-prefix trap (/x/W-evil is not inside /x/W)", () => {
    assert.equal(isInside(W, `${W}-evil/x`), false);
    assert.equal(isInside("/x/W", "/x/W-evil/x"), false);
  });

  it("excludes the parent", () => {
    assert.equal(isInside(W, "/"), false);
  });

  it("excludes non-canonical .. text even when it starts with W/", () => {
    assert.equal(isInside(W, "/w/../x"), false);
  });

  it("excludes relative targets", () => {
    assert.equal(isInside(W, "relative/dir"), false);
    assert.equal(isInside(W, "w/x"), false);
  });
});

describe("scopeRootFor (daemon side)", () => {
  it("leaves a plain repo (a .git directory) unscoped even with a profile", () => {
    const dir = freshTmpdir();
    fs.mkdirSync(path.join(dir, ".git"));
    assert.equal(scopeRootFor(dir, true), undefined);
  });

  it("scopes a profile session at a linked worktree root to the realpath of the cwd", () => {
    const dir = freshTmpdir();
    fs.writeFileSync(path.join(dir, ".git"), "gitdir: /r/.git/worktrees/w1\n");
    assert.equal(scopeRootFor(dir, true), fs.realpathSync(dir));
  });

  it("leaves a worktree unscoped without a profile", () => {
    const dir = freshTmpdir();
    fs.writeFileSync(path.join(dir, ".git"), "gitdir: /r/.git/worktrees/w1\n");
    assert.equal(scopeRootFor(dir, false), undefined);
  });

  it("does not treat a submodule-style .git file as a worktree", () => {
    const dir = freshTmpdir();
    fs.writeFileSync(path.join(dir, ".git"), "gitdir: ../.git/modules/m\n");
    assert.equal(scopeRootFor(dir, true), undefined);
  });

  it("leaves a directory without .git unscoped", () => {
    const dir = freshTmpdir();
    assert.equal(scopeRootFor(dir, true), undefined);
  });

  it("returns the canonical target when the cwd is a symlink to the worktree", () => {
    const base = freshTmpdir();
    const worktree = fs.realpathSync(fs.mkdtempSync(path.join(base, "wt-")));
    fs.writeFileSync(path.join(worktree, ".git"), "gitdir: /r/.git/worktrees/w1\n");
    const link = path.join(base, "link");
    fs.symlinkSync(worktree, link);
    assert.equal(scopeRootFor(link, true), worktree);
  });

  it("returns undefined, not a throw, for a garbage .git file or an fs error while probing", () => {
    const dir = freshTmpdir();
    fs.writeFileSync(path.join(dir, ".git"), "not a gitdir line\n");
    assert.equal(scopeRootFor(dir, true), undefined);
    const throwingFs = {
      lstatSync: (): { isFile: () => boolean } => {
        throw new Error("EACCES");
      },
      realpathSync: (p: string): string => p,
      readFileSync: (): string => {
        throw new Error("EACCES");
      },
    };
    assert.equal(scopeRootFor(dir, true, throwingFs), undefined);
  });
});
