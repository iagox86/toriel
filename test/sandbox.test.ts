// The per-command sandbox policy (pi/extensions/lib/sandbox.ts) and, when bwrap works here, the real
// thing: confinement, the node_modules symlink, git in a linked worktree, and the host-side escapes
// (planted hooks/config, rewritten git pointer files) that must stay closed.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, describe, it } from "node:test";
import { bwrapArgs, derivePolicy, gitPolicy, makeWrap, readSandbox, SANDBOX_ENV, SANDBOX_RW_ENV, SHARED_DIR_ENV, sandboxNote } from "../pi/extensions/lib/sandbox.ts";

// The sandbox hides /tmp, so test trees live in /var/tmp (a scope root under /tmp is refused, tested below).
const BASE = existsSync("/var/tmp") ? "/var/tmp" : tmpdir();
const made: string[] = [];
function mk(): string {
  const dir = realpathSync(mkdtempSync(join(BASE, "toriel-sandbox-test-")));
  made.push(dir);
  return dir;
}
after(() => {
  for (const d of made) {
    rmSync(d, { recursive: true, force: true });
  }
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });

/** A repo with one commit, plus a linked worktree whose node_modules points at the repo's (the toriel layout). */
function repoWithWorktree() {
  const base = mk();
  const repo = join(base, "repo");
  const wt = join(base, "repo-worktrees", "feat");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a"), "a");
  mkdirSync(join(repo, "node_modules"));
  git(repo, "add", "a");
  git(repo, "commit", "-qm", "init");
  mkdirSync(join(base, "repo-worktrees"));
  git(repo, "worktree", "add", "-q", "-b", "feat", wt);
  symlinkSync(join(repo, "node_modules"), join(wt, "node_modules"));
  return { base, repo, wt, common: join(repo, ".git"), gitdir: join(repo, ".git", "worktrees", "feat") };
}

const cfgFor = (root: string, extra: { shared?: string; staticRw?: string[] } = {}) => ({ kind: "bwrap" as const, root, shared: extra.shared, staticRw: extra.staticRw ?? [] });

describe("readSandbox", () => {
  it("is off when TORIEL_SANDBOX is absent", () => {
    assert.deepEqual(readSandbox({}), { kind: "off" });
    assert.deepEqual(readSandbox({ TORIEL_SCOPE_ROOT: "/x" }), { kind: "off" });
  });

  it("fails closed on a value it does not understand", () => {
    const r = readSandbox({ [SANDBOX_ENV]: "yes" });
    assert.equal(r.kind, "invalid");
    assert.match((r as { why: string }).why, /only "bwrap"/);
  });

  it("needs a usable scope root", () => {
    for (const env of [{ [SANDBOX_ENV]: "bwrap" }, { [SANDBOX_ENV]: "bwrap", TORIEL_SCOPE_ROOT: "relative" }, { [SANDBOX_ENV]: "bwrap", TORIEL_SCOPE_ROOT: "/definitely/not/here" }]) {
      const r = readSandbox(env);
      assert.equal(r.kind, "invalid");
      assert.match((r as { why: string }).why, /usable TORIEL_SCOPE_ROOT/);
    }
  });

  it("refuses a scope root under /tmp, which the sandbox hides", () => {
    const dir = realpathSync(mkdtempSync(join("/tmp", "toriel-sandbox-under-tmp-")));
    made.push(dir);
    const r = readSandbox({ [SANDBOX_ENV]: "bwrap", TORIEL_SCOPE_ROOT: dir });
    assert.equal(r.kind, "invalid");
    assert.match((r as { why: string }).why, /under \/tmp/);
  });

  it("reads the root, the shared directory and the static roots", () => {
    const root = mk();
    const r = readSandbox({ [SANDBOX_ENV]: "bwrap", TORIEL_SCOPE_ROOT: root, [SHARED_DIR_ENV]: "/s", [SANDBOX_RW_ENV]: ["/a", "rel", "/b"].join(delimiter) });
    assert.deepEqual(r, { kind: "bwrap", root, shared: "/s", staticRw: ["/a", "/b"] });
  });
});

describe("gitPolicy", () => {
  it("carves hooks and config out of an ordinary checkout", () => {
    const root = mk();
    mkdirSync(join(root, ".git"));
    assert.deepEqual(gitPolicy(root), { writable: [], readOnly: [join(root, ".git", "hooks"), join(root, ".git", "config")] });
  });

  it("opens only what git commit needs in a linked worktree and pins the pointer files", () => {
    const { wt, common, gitdir } = repoWithWorktree();
    const p = gitPolicy(wt);
    assert.deepEqual([...p.writable].sort(), [gitdir, join(common, "logs"), join(common, "objects"), join(common, "refs", "heads")].sort());
    for (const pinned of [join(wt, ".git"), join(gitdir, "commondir"), join(gitdir, "gitdir"), join(common, "hooks"), join(common, "config")]) {
      assert.ok(p.readOnly.includes(pinned), `${pinned} stays read-only`);
    }
    assert.ok(!p.writable.some((w) => w === common || w === join(common, "hooks")), "never the whole common dir");
  });

  it("gives nothing when there is no git, or the pointer is unusable", () => {
    const root = mk();
    assert.deepEqual(gitPolicy(root), { writable: [], readOnly: [] });
    writeFileSync(join(root, ".git"), "not a pointer\n");
    assert.deepEqual(gitPolicy(root), { writable: [], readOnly: [] });
    writeFileSync(join(root, ".git"), "gitdir: /no/such/dir\n");
    assert.deepEqual(gitPolicy(root), { writable: [], readOnly: [] });
  });
});

describe("derivePolicy", () => {
  it("adds the resolved node_modules target when the symlink leaves the root", () => {
    const { wt, repo } = repoWithWorktree();
    assert.ok(derivePolicy(cfgFor(wt)).writable.includes(join(repo, "node_modules")));
  });

  it("includes the shared directory, static roots and approved paths only when they exist", () => {
    const root = mk();
    const shared = mk();
    const cache = mk();
    const approved = mk();
    const p = derivePolicy(cfgFor(root, { shared, staticRw: [cache, "/no/such/cache"] }), [approved, "/no/such/approved"]);
    assert.deepEqual(p.writable, [root, shared, cache, approved]);
  });
});

describe("bwrapArgs and makeWrap", () => {
  it("binds writable areas before the read-only carve-outs, with a private /tmp", () => {
    const args = bwrapArgs({ writable: ["/w", "/x"], readOnly: ["/w/.git"] }, "/w");
    assert.deepEqual(args, ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--die-with-parent", "--bind", "/w", "/w", "--bind", "/x", "/x", "--ro-bind-try", "/w/.git", "/w/.git", "--chdir", "/w"]);
  });

  it("is undefined when off, and refuses every command when invalid", () => {
    assert.equal(makeWrap({ kind: "off" }), undefined);
    const wrap = makeWrap({ kind: "invalid", why: "because" });
    assert.throws(() => wrap?.("echo hi", "/"), /sandbox: because; the command was not run/);
  });

  it("wraps the command as bwrap ... bash -c <command>, recomputing the policy each time", () => {
    const root = mk();
    const extra: string[] = [];
    const wrap = makeWrap(cfgFor(root), () => extra);
    assert.ok(wrap);
    const first = wrap("echo hi", root);
    assert.equal(first.file, "bwrap");
    assert.deepEqual(first.args.slice(-3), ["bash", "-c", "echo hi"]);
    const approved = mk();
    extra.push(approved);
    assert.ok(wrap("echo hi", root).args.join(" ").includes(`--bind ${approved} ${approved}`), "an approval applies to the next command");
    assert.ok(!first.args.join(" ").includes(approved));
  });
});

describe("sandboxNote", () => {
  it("is empty unless the sandbox is on, and names the root and the shared directory", () => {
    assert.equal(sandboxNote({ kind: "off" }), "");
    assert.equal(sandboxNote({ kind: "invalid", why: "x" }), "");
    const note = sandboxNote({ kind: "bwrap", root: "/w", shared: "/s", staticRw: [] });
    assert.match(note, /read-only except \/w/);
    assert.match(note, /\/s/);
  });
});

const bwrapUsable = (() => {
  const r = spawnSync("bwrap", ["--ro-bind", "/", "/", "true"], { stdio: "ignore" });
  return r.status === 0;
})();

describe("real bwrap", { skip: bwrapUsable ? false : "bwrap is not usable here" }, () => {
  const run = (cfg: ReturnType<typeof cfgFor>, command: string, cwd: string, extra: string[] = []) => {
    const w = makeWrap(cfg, () => extra);
    assert.ok(w);
    const s = w(command, cwd);
    const r = spawnSync(s.file, s.args, { encoding: "utf8" });
    return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
  };

  it("lets a command write inside the root and nowhere else", () => {
    const root = mk();
    const outside = mk();
    assert.ok(run(cfgFor(root), `echo x > ${root}/ok`, root).ok);
    assert.equal(readFileSync(join(root, "ok"), "utf8"), "x\n");
    const denied = run(cfgFor(root), `echo x > ${outside}/no`, root);
    assert.ok(!denied.ok);
    assert.match(denied.out, /Read-only file system/);
    assert.ok(!existsSync(join(outside, "no")));
  });

  it("writes through the worktree's node_modules symlink to the shared checkout", () => {
    const { wt, repo } = repoWithWorktree();
    assert.ok(run(cfgFor(wt), `echo x > ${wt}/node_modules/pkg`, wt).ok);
    assert.ok(existsSync(join(repo, "node_modules", "pkg")));
  });

  it("commits in a linked worktree", () => {
    const { wt } = repoWithWorktree();
    const r = run(cfgFor(wt), `echo y > f && git -c user.name=t -c user.email=t@t add f && git -c user.name=t -c user.email=t@t commit -qm c && git log --oneline | wc -l`, wt);
    assert.ok(r.ok, r.out);
    assert.equal(git(wt, "log", "--oneline").toString().trim().split("\n").length, 2);
  });

  it("cannot plant a hook or a config setting in the shared git dir", () => {
    const { wt, common } = repoWithWorktree();
    assert.ok(!run(cfgFor(wt), `echo '#!/bin/sh' > ${common}/hooks/post-commit`, wt).ok);
    assert.ok(!run(cfgFor(wt), `git config -f ${common}/config core.fsmonitor 'touch /x'`, wt).ok);
    assert.ok(!existsSync(join(common, "hooks", "post-commit")));
    assert.ok(!readFileSync(join(common, "config"), "utf8").includes("fsmonitor"));
  });

  it("cannot rewrite the git pointer files that would aim the host's git at an agent-owned directory", () => {
    const { wt, gitdir } = repoWithWorktree();
    for (const target of [join(wt, ".git"), join(gitdir, "commondir"), join(gitdir, "gitdir")]) {
      const before = readFileSync(target, "utf8");
      assert.ok(!run(cfgFor(wt), `echo evil > ${target}`, wt).ok, target);
      assert.equal(readFileSync(target, "utf8"), before, `${target} is unchanged`);
    }
  });

  it("keeps hooks and config of an ordinary checkout read-only, while commits still work", () => {
    const base = mk();
    const root = join(base, "repo");
    mkdirSync(root);
    git(root, "init", "-q", "-b", "main");
    const before = readFileSync(join(root, ".git", "config"), "utf8");
    assert.ok(!run(cfgFor(root), `echo '#!/bin/sh' > ${root}/.git/hooks/pre-commit`, root).ok);
    assert.ok(!run(cfgFor(root), `git config core.fsmonitor 'touch /x'`, root).ok);
    assert.equal(readFileSync(join(root, ".git", "config"), "utf8"), before);
    assert.ok(run(cfgFor(root), `echo a > a && git -c user.name=t -c user.email=t@t add a && git -c user.name=t -c user.email=t@t commit -qm c`, root).ok);
  });

  it("gives the shared directory and a private /tmp", () => {
    const root = mk();
    const shared = mk();
    assert.ok(run(cfgFor(root, { shared }), `echo hi > ${shared}/note && echo t > /tmp/toriel-sandbox-private-probe`, root).ok);
    assert.ok(existsSync(join(shared, "note")));
    assert.ok(!existsSync("/tmp/toriel-sandbox-private-probe"), "a /tmp write never reaches the real /tmp");
  });

  it("applies an approved path on the next command", () => {
    const root = mk();
    const approved = mk();
    assert.ok(!run(cfgFor(root), `echo x > ${approved}/a`, root).ok);
    assert.ok(run(cfgFor(root), `echo x > ${approved}/a`, root, [approved]).ok);
  });
});
