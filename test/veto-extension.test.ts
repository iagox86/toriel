import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import veto from "../pi/extensions/toriel-veto.ts";
import { readScope, resolveTarget, vetoVerdict, writeEscape } from "../pi/extensions/lib/scope-root.ts";
import type { Scope } from "../pi/extensions/lib/scope-root.ts";

type Handler = (event: { toolName?: unknown; input?: unknown }, ctx?: { cwd?: string }) => { block: true; reason: string } | undefined;

let base: string;
let root: string;
let outside: string;

beforeEach(() => {
  // under the home directory's cache would be nicer, but any dir outside /tmp's scratch exemption needs the root itself outside /tmp
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "toriel-veto-")));
  root = path.join(base, "root");
  outside = path.join(base, "elsewhere");
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
});
afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

const deny = (r: string): Scope => ({ kind: "root", root: r, mode: "deny" });

describe("vetoVerdict (ticket 219)", () => {
  it("blocks a write or edit outside the root, however the permission rules would have answered", () => {
    for (const tool of ["write", "edit"]) {
      const reason = vetoVerdict(deny(root), tool, { path: path.join(outside, "x.txt") }, root);
      assert.match(reason ?? "", /outside this session's write scope/);
    }
  });

  it("lets a write inside the root, new or existing, absolute or relative, go on", () => {
    fs.writeFileSync(path.join(root, "a.txt"), "x");
    assert.equal(vetoVerdict(deny(root), "write", { path: path.join(root, "a.txt") }, root), undefined);
    assert.equal(vetoVerdict(deny(root), "write", { path: "a.txt" }, root), undefined);
    assert.equal(vetoVerdict(deny(root), "edit", { path: "new/dir/b.txt" }, root), undefined);
  });

  it("resolves .. and relative escapes", () => {
    assert.match(vetoVerdict(deny(root), "write", { path: "../elsewhere/x" }, root) ?? "", /outside/);
    assert.match(vetoVerdict(deny(root), "write", { path: "sub/../../elsewhere/x" }, root) ?? "", /outside/);
  });

  it("follows a symlink inside the root that points outside (an existing link and a new file through it)", () => {
    fs.symlinkSync(outside, path.join(root, "link"));
    assert.match(vetoVerdict(deny(root), "write", { path: "link/x.txt" }, root) ?? "", /outside/);
    fs.writeFileSync(path.join(outside, "f"), "x");
    assert.match(vetoVerdict(deny(root), "edit", { path: "link/f" }, root) ?? "", /outside/);
  });

  it("applies .. to the REAL parent when it follows a symlink (the kernel does, path.resolve does not)", () => {
    // root/link/../x.txt lands at base/x.txt on the real filesystem, not root/x.txt: the .. is applied after the
    // link resolves, so the veto must resolve that way too or the escape looks inside and slips by
    fs.symlinkSync(outside, path.join(root, "link"));
    assert.equal(resolveTarget("link/../x.txt", root), path.join(base, "x.txt"));
    assert.match(vetoVerdict(deny(root), "write", { path: "link/../x.txt" }, root) ?? "", /outside/);
    // same through a symlinked subdirectory, and through a chain
    fs.mkdirSync(path.join(outside, "sub"));
    fs.symlinkSync(path.join(outside, "sub"), path.join(root, "l2"));
    fs.symlinkSync("l2", path.join(root, "l1"));
    assert.match(vetoVerdict(deny(root), "write", { path: "l2/../y" }, root) ?? "", /outside/);
    assert.match(vetoVerdict(deny(root), "write", { path: "l1/../z" }, root) ?? "", /outside/);
    // a .. that only pops not-yet-created components stays inside
    assert.equal(vetoVerdict(deny(root), "write", { path: "new/dir/../kept.txt" }, root), undefined);
  });

  it("expands ~ to the home directory", () => {
    assert.match(vetoVerdict(deny(root), "write", { path: "~/.bashrc" }, root) ?? "", /outside/);
  });

  it("blocks a write with no usable path", () => {
    assert.match(vetoVerdict(deny(root), "write", {}, root) ?? "", /cannot resolve a target/);
    assert.match(vetoVerdict(deny(root), "edit", { path: "" }, root) ?? "", /cannot resolve a target/);
    assert.match(vetoVerdict(deny(root), "write", null, root) ?? "", /cannot resolve a target/);
  });

  it("exempts scratch (/tmp) unless the scope root itself lives there", () => {
    assert.equal(vetoVerdict(deny("/srv/proj"), "write", { path: "/tmp/scratch.txt" }, "/srv/proj"), undefined);
    assert.match(vetoVerdict(deny(root), "write", { path: path.join(os.tmpdir(), "other-x") }, root) ?? "", /outside/);
  });

  it("blocks an interpreter payload naming a path outside the root, and lets one inside go on (the report's python case)", () => {
    const bad = `python3 -c "open('${outside}/x','w').write('y')"`;
    assert.match(vetoVerdict(deny(root), "bash", { command: bad }, root) ?? "", /hands code to an interpreter/);
    const good = `python3 -c "open('${root}/x','w').write('y')"`;
    assert.equal(vetoVerdict(deny(root), "bash", { command: good }, root), undefined);
    assert.equal(vetoVerdict(deny(root), "bash", { command: "npm test" }, root), undefined);
  });

  it("does nothing to reads, other tools, ask mode or an off scope", () => {
    assert.equal(vetoVerdict(deny(root), "read", { path: "/etc/passwd" }, root), undefined);
    assert.equal(vetoVerdict(deny(root), "grep", { path: "/etc" }, root), undefined);
    assert.equal(vetoVerdict({ kind: "root", root, mode: "ask" }, "write", { path: "/etc/x" }, root), undefined);
    assert.equal(vetoVerdict({ kind: "off" }, "write", { path: "/etc/x" }, root), undefined);
  });

  it("blocks every write when the scope is invalid in deny mode, and nothing in ask mode", () => {
    assert.match(vetoVerdict({ kind: "invalid", why: "not an absolute path", mode: "deny" }, "write", { path: "a" }, root) ?? "", /unusable/);
    assert.equal(vetoVerdict({ kind: "invalid", why: "x", mode: "deny" }, "bash", { command: "ls" }, root), undefined);
    assert.equal(vetoVerdict({ kind: "invalid", why: "x", mode: "ask" }, "write", { path: "a" }, root), undefined);
  });

  it("never throws on hostile input, and blocks a write rather than letting it by", () => {
    const hostile = {
      get path(): string {
        throw new Error("boom");
      },
    };
    assert.match(vetoVerdict(deny(root), "write", hostile, root) ?? "", /internal error/);
    assert.equal(vetoVerdict(deny(root), "bash", hostile, root), undefined);
  });
});

describe("the project configuration directory (ticket 223)", () => {
  const ask = (r: string): Scope => ({ kind: "root", root: r, mode: "ask" });
  const config = path.join(".pi", "extensions", "pi-permission-system", "config.json");

  it("blocks a write or edit into <root>/.pi in deny mode and in ask mode, however the rules answer", () => {
    for (const scope of [deny(root), ask(root)]) {
      for (const tool of ["write", "edit"]) {
        assert.match(vetoVerdict(scope, tool, { path: path.join(root, config) }, root) ?? "", /inside \.pi, pi's project configuration/);
        assert.match(vetoVerdict(scope, tool, { path: config }, root) ?? "", /inside \.pi/, "a relative path resolves against the cwd");
        assert.match(vetoVerdict(scope, tool, { path: ".pi/agents/x.md" }, root) ?? "", /inside \.pi/);
      }
    }
  });

  it("blocks the directory itself and a path that only gets there through .. or a symlink", () => {
    fs.mkdirSync(path.join(root, ".pi"));
    fs.symlinkSync(path.join(root, ".pi"), path.join(root, "alias"));
    assert.match(vetoVerdict(ask(root), "write", { path: ".pi" }, root) ?? "", /inside \.pi/);
    assert.match(vetoVerdict(ask(root), "write", { path: "sub/../.pi/x" }, root) ?? "", /inside \.pi/);
    assert.match(vetoVerdict(ask(root), "write", { path: "alias/config.json" }, root) ?? "", /inside \.pi/);
  });

  it("leaves lookalike names, other dot directories and reads alone", () => {
    assert.equal(vetoVerdict(ask(root), "write", { path: ".pi-notes/x" }, root), undefined);
    assert.equal(vetoVerdict(ask(root), "write", { path: ".pix" }, root), undefined);
    assert.equal(vetoVerdict(ask(root), "write", { path: "docs/.pi/x" }, root), undefined, "only the root's own .pi is the project layer");
    assert.equal(vetoVerdict(ask(root), "read", { path: ".pi/settings.json" }, root), undefined);
    assert.equal(vetoVerdict(ask(root), "bash", { command: "cat .pi/settings.json" }, root), undefined);
    assert.equal(vetoVerdict({ kind: "off" }, "write", { path: path.join(root, config) }, root), undefined, "an unscoped session is not fenced");
  });

  it("still leaves an ordinary write inside the root, and an outside one in ask mode, to the usual paths", () => {
    assert.equal(vetoVerdict(ask(root), "write", { path: "src/a.ts" }, root), undefined);
    assert.equal(vetoVerdict(ask(root), "write", { path: path.join(outside, "x") }, root), undefined);
  });

  it("blocks a write it cannot resolve rather than letting it by, in ask mode too", () => {
    const hostile = {
      get path(): string {
        throw new Error("boom");
      },
    };
    assert.match(vetoVerdict(ask(root), "write", hostile, root) ?? "", /internal error/);
  });
});

describe("resolveTarget and writeEscape", () => {
  it("resolves through the nearest existing ancestor", () => {
    assert.equal(resolveTarget("a/b/c.txt", root), path.join(root, "a/b/c.txt"));
    fs.symlinkSync(outside, path.join(root, "l"));
    assert.equal(resolveTarget("l/new/x", root), path.join(outside, "new/x"));
  });

  it("treats the root itself as inside and a sibling that shares its prefix as outside", () => {
    assert.equal(writeEscape(root, root, root), undefined);
    const sibling = `${root}-evil`;
    assert.equal(writeEscape(root, path.join(sibling, "x"), root), path.join(sibling, "x"));
  });
});

describe("the extension", () => {
  const register = (env: Record<string, string | undefined>): Handler | undefined => {
    const saved = { ...process.env };
    for (const k of ["TORIEL_CHILD", "TORIEL_SCOPE_ROOT", "TORIEL_SCOPE_MODE"]) {
      delete process.env[k];
    }
    Object.assign(process.env, env);
    try {
      let handler: Handler | undefined;
      veto({
        on: (_e, h) => {
          handler = h;
        },
      });
      return handler;
    } finally {
      for (const k of Object.keys(process.env)) {
        if (!(k in saved)) {
          delete process.env[k];
        }
      }
      Object.assign(process.env, saved);
    }
  };

  it("registers nothing outside a toriel child, or without a scope", () => {
    assert.equal(register({ TORIEL_SCOPE_ROOT: root }), undefined);
    assert.equal(register({ TORIEL_CHILD: "1" }), undefined);
  });

  it("blocks through pi's {block, reason} shape, using the context cwd for relative paths", () => {
    const handler = register({ TORIEL_CHILD: "1", TORIEL_SCOPE_ROOT: root });
    assert.ok(handler);
    const blocked = handler({ toolName: "write", input: { path: "../elsewhere/x" } }, { cwd: root });
    assert.equal(blocked?.block, true);
    assert.match(blocked?.reason ?? "", /write scope/);
    assert.equal(handler({ toolName: "write", input: { path: "ok.txt" } }, { cwd: root }), undefined);
    assert.equal(handler({ toolName: 7, input: 7 }, { cwd: root }), undefined);
  });

  it("an unusable root blocks writes, fail closed", () => {
    const handler = register({ TORIEL_CHILD: "1", TORIEL_SCOPE_ROOT: "relative/path" });
    assert.match(handler?.({ toolName: "edit", input: { path: "x" } })?.reason ?? "", /unusable/);
  });

  it("agrees with readScope on what the scope is", () => {
    assert.deepEqual(readScope({ TORIEL_SCOPE_ROOT: root }), deny(root));
  });
});
