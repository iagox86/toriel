import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

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
});
