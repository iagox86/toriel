import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { SCOPE_ENV, SCOPE_MODE_ENV, readScope } from "../pi/extensions/lib/scope-root.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-grantsext-"));
const sock = path.join(dir, "d.sock");
process.env.TORIEL_CHILD = "1";
process.env.TORIEL_SOCK = sock;
process.env.TORIEL_SESSION_ID = "0b1c2d3e-aaaa-4bbb-8ccc-111111111111";
const ext = await import("../pi/extensions/toriel-grants.ts");

const SERVICES = Symbol.for("@gotgenes/pi-permission-system:session-services");
const bashAsk = { command: "sudo -V", sessionApproval: { grants: [{ surface: "bash", pattern: "sudo -V" }] }, payload: { request: { value: "sudo -V" } } };

/** A daemon stand-in answering each command with `reply(cmd)`; no reply = silence. */
function fakeDaemon(reply: (cmd: Record<string, unknown>) => { ok: boolean; data?: unknown } | undefined): Promise<{ seen: Array<Record<string, unknown>>; close(): void }> {
  const seen: Array<Record<string, unknown>> = [];
  const server = net.createServer((s) => {
    s.on("data", (chunk) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        const cmd = JSON.parse(line) as Record<string, unknown>;
        seen.push(cmd);
        const r = reply(cmd);
        if (r) {
          s.write(`${JSON.stringify({ type: "response", id: cmd.id, ...r })}\n`);
        }
      }
    });
    s.on("error", () => {});
  });
  fs.rmSync(sock, { force: true });
  return new Promise((resolve) => server.listen(sock, () => resolve({ seen, close: () => server.close() })));
}

describe("describeAsk", () => {
  it("takes pi's suggested grants and the value they are about", () => {
    assert.deepEqual(ext.describeAsk(bashAsk), { grants: [{ surface: "bash", pattern: "sudo -V" }], value: "sudo -V" });
  });

  it("falls back to the command, path or target, and drops malformed grants", () => {
    assert.equal(ext.describeAsk({ command: "ls" }).value, "ls");
    assert.equal(ext.describeAsk({ path: "/x" }).value, "/x");
    assert.equal(ext.describeAsk({ target: "t" }).value, "t");
    assert.deepEqual(ext.describeAsk({ sessionApproval: { grants: [{ surface: "bash" }, { surface: 1, pattern: "x" }, { surface: "mcp", pattern: "exa:*" }] } }).grants, [{ surface: "mcp", pattern: "exa:*" }]);
  });
});

describe("authorize", () => {
  it("allows when the daemon says a grant covers the ask, sending its own session id", async () => {
    const d = await fakeDaemon(() => ({ ok: true, data: { allow: true, grants: [1] } }));
    try {
      const v = await ext.authorize(sock, process.env.TORIEL_SESSION_ID, bashAsk);
      assert.deepEqual(v, { kind: "allow" });
      assert.deepEqual([d.seen[0]?.type, d.seen[0]?.uuid, d.seen[0]?.value], ["permission_check", process.env.TORIEL_SESSION_ID, "sudo -V"]);
      assert.deepEqual(d.seen[0]?.grants, [{ surface: "bash", pattern: "sudo -V" }]);
    } finally {
      d.close();
    }
  });

  it("defers when no grant covers it", async () => {
    const d = await fakeDaemon(() => ({ ok: true, data: { allow: false } }));
    try {
      assert.deepEqual(await ext.authorize(sock, "u", bashAsk), { kind: "defer" });
    } finally {
      d.close();
    }
  });

  it("defers when the daemon refuses, is silent past the timeout, or is not there, and never throws", async () => {
    const refusing = await fakeDaemon(() => ({ ok: false }));
    try {
      assert.deepEqual(await ext.authorize(sock, "u", bashAsk), { kind: "defer" });
    } finally {
      refusing.close();
    }
    const silent = await fakeDaemon(() => undefined);
    try {
      const t0 = Date.now();
      assert.deepEqual(await ext.authorize(sock, "u", bashAsk), { kind: "defer" });
      assert.ok(Date.now() - t0 < ext.CHECK_TIMEOUT_MS + 1500, "gave up near the timeout");
    } finally {
      silent.close();
    }
    fs.rmSync(sock, { force: true });
    assert.deepEqual(await ext.authorize(sock, "u", bashAsk), { kind: "defer" });
    assert.deepEqual(await ext.authorize(sock, "u", bashAsk, () => Promise.reject(new Error("boom"))), { kind: "defer" });
    assert.deepEqual(await ext.authorize(sock, "u", null as never), { kind: "defer" });
  });

  it("does not ask the daemon without a session id or a suggested grant", async () => {
    const d = await fakeDaemon(() => ({ ok: true, data: { allow: true } }));
    try {
      assert.deepEqual(await ext.authorize(sock, undefined, bashAsk), { kind: "defer" });
      assert.deepEqual(await ext.authorize(sock, "u", { command: "ls" }), { kind: "defer" });
      assert.equal(d.seen.length, 0);
    } finally {
      d.close();
    }
  });
});

describe("scope link", () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "toriel-scope-")));
  fs.mkdirSync(path.join(base, "W"));
  const W = fs.realpathSync(path.join(base, "W"));
  const root = { kind: "root" as const, root: W, mode: "deny" as const };
  const askRoot = { kind: "root" as const, root: W, mode: "ask" as const };
  const off = { kind: "off" as const };

  function writeAsk(surface: string, boundaryValue: unknown, extra: Record<string, unknown> = {}) {
    return { surface, accessIntent: { surface, matchValues: [boundaryValue ?? "no-boundary"], boundaryValue }, sessionApproval: { grants: [{ surface, pattern: `${surface}:*` }] }, payload: { request: { value: `${surface} ${boundaryValue ?? ""}` } }, ...extra };
  }

  it("denies a write whose canonical target escapes W, naming the path and the root, without asking the daemon", async () => {
    const outside = path.join(base, "outside.txt");
    const v = ext.scopeVerdict(root, writeAsk("path_write", outside));
    assert.equal(v.kind, "deny");
    if (v.kind === "deny") {
      assert.match(v.reason, new RegExp(outside), "reason names the offending canonical path");
      assert.match(v.reason, new RegExp(W), "reason names the scope root");
    }
    const d = await fakeDaemon(() => ({ ok: true, data: { allow: true } }));
    try {
      assert.equal((await ext.authorize(sock, "u", writeAsk("path_write", outside), () => { throw new Error("must not be called"); }, root)).kind, "deny");
      assert.equal(d.seen.filter((c) => c.type === "permission_check").length, 0, "a scope deny never reaches the daemon");
    } finally {
      d.close();
    }
  });

  it("denies a symlink-out write even though the lexical path is inside W", () => {
    const main = path.join(base, "main");
    fs.mkdirSync(main);
    const realMain = fs.realpathSync(main);
    const boundary = path.join(realMain, "f.txt");
    const ask = writeAsk("external_directory_write", boundary, { accessIntent: { surface: "external_directory_write", matchValues: [path.join(W, "link-out", "f.txt"), boundary], boundaryValue: boundary } });
    const v = ext.scopeVerdict(root, ask);
    assert.equal(v.kind, "deny", "matchValues carries a lexical path inside W; only the canonical boundary decides");
    if (v.kind === "deny") {
      assert.match(v.reason, /f\.txt/);
      assert.match(v.reason, new RegExp(W));
    }
  });

  it("defers writes inside W and denies the sibling-prefix trap", () => {
    assert.deepEqual(ext.scopeVerdict(root, writeAsk("path_write", W)), { kind: "defer" }, "W itself is inside W");
    assert.deepEqual(ext.scopeVerdict(root, writeAsk("path_write", path.join(W, "sub", "x"))), { kind: "defer" }, "a child of W defers");
    const sibling = path.join(base, "W-evil", "x");
    const v = ext.scopeVerdict(root, writeAsk("path_write", sibling));
    assert.equal(v.kind, "deny", `${sibling} is not inside ${W}`);
    if (v.kind === "deny") {
      assert.match(v.reason, /W-evil/);
      assert.match(v.reason, new RegExp(W));
    }
  });

  it("stays total: hostile details and a throwing send resolve to a verdict, never a rejection", async () => {
    const throwing = { get accessIntent() { throw new Error("boom"); } };
    assert.doesNotThrow(() => assert.equal(ext.scopeVerdict(root, throwing as never).kind, "deny"), "covered check under a root scope fails closed");
    assert.doesNotThrow(() => assert.equal(ext.scopeVerdict(askRoot, throwing as never).kind, "defer"), "in ask mode it fails to prompting");
    assert.doesNotThrow(() => assert.equal(ext.scopeVerdict(off, throwing as never).kind, "defer"), "off never touches details");
    assert.deepEqual(await ext.authorize(sock, "u", null as never, () => { throw new Error("boom"); }, off), { kind: "defer" });
    assert.equal((await ext.authorize(sock, "u", throwing as never, () => { throw new Error("boom"); }, root)).kind, "deny");
  });

  it("denies every covered write while the env is present but invalid (naming the env), and defers uncovered surfaces", async () => {
    const file = path.join(base, "a-file");
    fs.writeFileSync(file, "x");
    const link = path.join(base, "link-to-W");
    fs.symlinkSync(W, link);
    const bad = ["", "  ", "relative", path.join(base, "missing"), file, "/", link, `${W}/`].map((v) => readScope({ [SCOPE_ENV]: v }));
    for (const s of bad) {
      assert.equal(s.kind, "invalid", "readScope rejects this value");
      assert.equal(s.kind === "invalid" && s.mode, "deny", "a scope without TORIEL_SCOPE_MODE defaults to deny");
      const w = writeAsk("path_write", path.join(W, "x"));
      const dv = ext.scopeVerdict(s, w);
      assert.equal(dv.kind, "deny", "a covered write under an invalid scope denies, never defers");
      if (dv.kind === "deny") {
        assert.match(dv.reason, /TORIEL_SCOPE_ROOT/);
      }
      for (const surf of ["path_read", "bash", "mcp"]) {
        assert.deepEqual(ext.scopeVerdict(s, writeAsk(surf, path.join(W, "x"))), { kind: "defer" }, `uncovered surface ${surf} defers even when invalid`);
      }
    }
    const first = readScope({ TORIEL_SCOPE_ROOT: "" });
    const d = await fakeDaemon(() => ({ ok: true, data: { allow: true } }));
    try {
      assert.equal((await ext.authorize(sock, "u", writeAsk("path_write", path.join(W, "x")), () => { throw new Error("must not be called"); }, first)).kind, "deny");
      assert.equal(d.seen.length, 0, "a scope deny never reaches the daemon");
    } finally {
      d.close();
    }
  });

  it("defers everything when the scope is absent (off, or readScope of an empty env)", () => {
    const outside = path.join(base, "outside6.txt");
    assert.deepEqual(ext.scopeVerdict(off, writeAsk("path_write", outside)), { kind: "defer" });
    assert.deepEqual(readScope({}), { kind: "off" });
    assert.deepEqual(ext.scopeVerdict(readScope({}), writeAsk("external_directory_write", outside)), { kind: "defer" });
  });

  it("denies the folded write families outside W and defers the read families", () => {
    // write/edit fold into path_read+path_write asks (pi-permission-system src/policy/permission-resolver.ts:96-118)
    const outside = path.join(base, "folded.txt");
    assert.equal(ext.scopeVerdict(root, writeAsk("path_write", outside, { surface: "write" })).kind, "deny", "details.surface is the tool's display surface; accessIntent.decides");
    assert.equal(ext.scopeVerdict(root, writeAsk("path_write", outside)).kind, "deny", "bare-path origin ask");
    assert.deepEqual(ext.scopeVerdict(root, writeAsk("path_read", outside)), { kind: "defer" }, "reads are not jailed (T7)");
    assert.deepEqual(ext.scopeVerdict(root, writeAsk("external_directory_read", outside)), { kind: "defer" });
  });

  it("denies a covered write with a missing or non-string canonical target", () => {
    for (const b of [null, "", 42]) {
      const v = ext.scopeVerdict(root, writeAsk("external_directory", b));
      assert.equal(v.kind, "deny", `boundary ${String(b)}`);
      if (v.kind === "deny") {
        assert.match(v.reason, /cannot resolve a canonical target/);
        assert.match(v.reason, new RegExp(W));
      }
    }
  });

  it("runs before the grants round-trip: deny wins over a daemon allow, inside-W still honors the daemon", async () => {
    const outside = path.join(base, "outside9.txt");
    const d = await fakeDaemon(() => ({ ok: true, data: { allow: true } }));
    try {
      assert.equal((await ext.authorize(sock, "u", writeAsk("external_directory_write", outside), () => { throw new Error("must not be called"); }, root)).kind, "deny");
      assert.equal(d.seen.filter((c) => c.type === "permission_check").length, 0, "the daemon allow is never consulted");
    } finally {
      d.close();
    }
    const d2 = await fakeDaemon(() => ({ ok: true, data: { allow: true } }));
    try {
      assert.deepEqual(await ext.authorize(sock, "u", writeAsk("path_write", path.join(W, "in.txt")), undefined, root), { kind: "allow" });
      assert.equal(d2.seen.filter((c) => c.type === "permission_check").length, 1, "inside-W writes still go through the grants path");
    } finally {
      d2.close();
    }
  });

  it("defers an outside write in ask mode, letting the grants round-trip (only when grants exist) decide", async () => {
    const outside = path.join(base, "outside-ask.txt");
    assert.deepEqual(ext.scopeVerdict(askRoot, writeAsk("path_write", outside)), { kind: "defer" }, "the ask-mode guard never denies");
    assert.deepEqual(ext.scopeVerdict(askRoot, writeAsk("path_write", path.join(W, "inside.txt"))), { kind: "defer" }, "an inside write defers too: ask mode never answers, the normal flow decides");
    assert.deepEqual(ext.scopeVerdict(askRoot, writeAsk("path_read", outside)), { kind: "defer" }, "non-covered surfaces defer (reads are not jailed)");
    const d = await fakeDaemon(() => ({ ok: true, data: { allow: true } }));
    try {
      assert.deepEqual(await ext.authorize(sock, "u", writeAsk("path_write", outside), undefined, askRoot), { kind: "allow" }, "a deferred scope lets the daemon's grant answer");
      assert.equal(d.seen.filter((c) => c.type === "permission_check").length, 1, "the grants round-trip ran");
      const noGrants = { surface: "path_write", accessIntent: { surface: "path_write", matchValues: [outside], boundaryValue: outside } };
      assert.deepEqual(await ext.authorize(sock, "u", noGrants, undefined, askRoot), { kind: "defer" }, "no suggested grants, no round-trip");
      assert.equal(d.seen.filter((c) => c.type === "permission_check").length, 1, "only the granted ask reached the daemon");
      assert.deepEqual(await ext.authorize(sock, "u", writeAsk("path_write", outside), () => Promise.reject(new Error("daemon down")), askRoot), { kind: "defer" }, "a daemon failure defers to the dialog");
    } finally {
      d.close();
    }
  });

  it("defers a covered write with a missing canonical target in ask mode (unknowable, so prompt)", () => {
    for (const b of [null, "", 42]) {
      assert.deepEqual(ext.scopeVerdict(askRoot, writeAsk("external_directory", b)), { kind: "defer" }, `boundary ${String(b)}`);
    }
  });

  it("defers every covered write while the env is invalid in ask mode, and denies in deny mode", () => {
    const outside = path.join(base, "invalid-mode.txt");
    for (const v of ["", "relative", path.join(base, "missing")]) {
      const asking = readScope({ [SCOPE_ENV]: v, [SCOPE_MODE_ENV]: "ask" });
      assert.deepEqual(ext.scopeVerdict(asking, writeAsk("path_write", outside)), { kind: "defer" }, `ask mode defers an unusable root (${v})`);
      const denying = readScope({ [SCOPE_ENV]: v });
      assert.equal(ext.scopeVerdict(denying, writeAsk("path_write", outside)).kind, "deny", `deny mode fails closed (${v})`);
    }
  });
});

describe("registration", () => {
  function fakePi() {
    const handlers = new Map<string, (data: unknown) => void>();
    const shutdown: Array<() => void> = [];
    return {
      handlers,
      shutdown,
      pi: { events: { on: (c: string, h: (d: unknown) => void) => void handlers.set(c, h) }, on: (_e: string, h: () => void) => void shutdown.push(h) },
    };
  }
  function publish(sessionId: string, registered: Array<{ name: string; authorize: (d: unknown) => Promise<unknown>; disposed: boolean }>, failing = false) {
    const slots = globalThis as Record<symbol, unknown>;
    if (!slots[SERVICES]) {
      slots[SERVICES] = new Map();
    }
    const map = slots[SERVICES] as Map<string, unknown>;
    map.set(sessionId, {
      registerAuthorizer: (name: string, authorize: (d: unknown) => Promise<unknown>) => {
        if (failing) {
          throw new Error("duplicate");
        }
        const entry = { name, authorize, disposed: false };
        registered.push(entry);
        return () => {
          entry.disposed = true;
        };
      },
    });
  }

  it("registers the link once even when permissions:ready repeats, and unregisters on shutdown", () => {
    const registered: Array<{ name: string; authorize: (d: unknown) => Promise<unknown>; disposed: boolean }> = [];
    publish("s1", registered);
    const f = fakePi();
    ext.default(f.pi as never);
    f.handlers.get("permissions:ready")?.({ sessionId: "s1" });
    f.handlers.get("permissions:ready")?.({ sessionId: "s1" });
    assert.deepEqual(registered.map((r) => r.name), ["toriel-grants"]);
    f.shutdown[0]?.();
    assert.equal(registered[0]?.disposed, true);
    f.handlers.get("permissions:ready")?.({ sessionId: "s1" });
    assert.equal(registered.length, 2, "registers again after a reload");
  });

  it("does nothing without a session id, without a published service, or when registering throws", () => {
    const f = fakePi();
    ext.default(f.pi as never);
    assert.doesNotThrow(() => f.handlers.get("permissions:ready")?.({ sessionId: null }));
    assert.doesNotThrow(() => f.handlers.get("permissions:ready")?.({ sessionId: "unknown" }));
    publish("s2", [], true);
    assert.doesNotThrow(() => f.handlers.get("permissions:ready")?.({ sessionId: "s2" }));
  });

  it("registers nothing outside a toriel child", () => {
    const saved = process.env.TORIEL_CHILD;
    delete process.env.TORIEL_CHILD;
    try {
      const f = fakePi();
      ext.default(f.pi as never);
      assert.equal(f.handlers.size, 0);
    } finally {
      process.env.TORIEL_CHILD = saved;
    }
  });

  it("keeps a registered closure total: hostile details resolve to a verdict, not a rejection", async () => {
    const scopeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "toriel-scopereg-")));
    const registered: Array<{ name: string; authorize: (d: unknown) => Promise<unknown>; disposed: boolean }> = [];
    publish("s3", registered);
    const f = fakePi();
    process.env.TORIEL_SCOPE_ROOT = scopeDir;
    try {
      ext.default(f.pi as never);
      f.handlers.get("permissions:ready")?.({ sessionId: "s3" });
    } finally {
      delete process.env.TORIEL_SCOPE_ROOT;
    }
    assert.equal(registered.length, 1);
    const v = (await registered[0].authorize({ get accessIntent() { throw new Error("boom"); } } as never)) as { kind: string; reason?: string };
    assert.equal(v.kind, "deny", "scope root from the env fails closed on a throwing getter");
    assert.match(v.reason ?? "", /denying/);
  });
});
