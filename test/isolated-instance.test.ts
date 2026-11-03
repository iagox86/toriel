import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { applyIsolated } from "../src/preflight.ts";

const ROOT = path.join(import.meta.dirname, "..");

/** The paths config.ts settles on in a fresh process with exactly this environment. */
function paths(env: Record<string, string>): Record<string, string> & { error?: string } {
  const code = `import("./src/config.ts").then((c) => console.log(JSON.stringify({ sock: c.SOCK, data: c.DATA_DIR, pid: c.PID_FILE, trash: c.TRASH_DIR, log: c.LOG, history: c.HISTORY_FILE, profile: c.PROFILE ?? "" }))).catch((e) => console.log(JSON.stringify({ error: String(e.message) })));`;
  const r = spawnSync(process.execPath, ["-e", code], { cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: "/home/real", ...env } });
  return JSON.parse(r.stdout);
}

describe("TORIEL_PROFILE", () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-prof-"));

  it("keeps the socket, pidfile, data, history, trash and log under one private directory, and nothing in the real places", () => {
    const p = paths({ XDG_RUNTIME_DIR: runtime, XDG_DATA_HOME: "/home/real/share", XDG_STATE_HOME: "/home/real/state", TORIEL_PROFILE: "dev" });
    const dir = path.join(runtime, "toriel-dev");
    for (const where of [p.sock, p.data, p.pid, p.history, p.trash, p.log]) {
      assert.ok(where.startsWith(`${dir}/`), `${where} is under ${dir}`);
    }
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700, "private, because the socket takes unauthenticated commands");
  });

  it("does not touch any directory when no profile is set", () => {
    const p = paths({ XDG_RUNTIME_DIR: runtime, XDG_DATA_HOME: "/home/real/share", XDG_STATE_HOME: "/home/real/state" });
    assert.equal(p.sock, `${runtime}/toriel.sock`);
    assert.equal(p.log, "/home/real/state/toriel/daemon.log");
    assert.equal(p.profile, "");
  });

  it("lets an explicit socket or per-file variable win over the profile, as tests and scripts rely on", () => {
    const p = paths({ XDG_RUNTIME_DIR: runtime, TORIEL_PROFILE: "dev2", TORIEL_SOCK: "/x/s.sock", TORIEL_LOG: "/x/d.log" });
    assert.equal(p.sock, "/x/s.sock");
    assert.equal(p.log, "/x/d.log");
    assert.ok(p.data.startsWith(path.join(runtime, "toriel-dev2")));
  });

  it("refuses a name that could point elsewhere", () => {
    for (const bad of ["../x", "a/b", "..", "has space"]) {
      assert.match(paths({ XDG_RUNTIME_DIR: runtime, TORIEL_PROFILE: bad }).error ?? "", /not a usable name/, bad);
    }
  });

  it("needs XDG_RUNTIME_DIR, since the socket must live in a private directory", () => {
    assert.match(paths({ TORIEL_PROFILE: "dev" }).error ?? "", /XDG_RUNTIME_DIR is not set/);
  });
});

describe("--isolated", () => {
  const argv = (...a: string[]) => ["node", "toriel.ts", ...a];

  it("takes a name, and removes the flag and the name from the arguments", () => {
    const a = argv("--isolated", "dev");
    const env: NodeJS.ProcessEnv = {};
    applyIsolated(a, env, "/work/branch");
    assert.deepEqual(a, argv());
    assert.equal(env.TORIEL_PROFILE, "dev");
  });

  it("defaults the name to the checkout's folder, so the instance says which code it runs", () => {
    const a = argv("--isolated");
    const env: NodeJS.ProcessEnv = {};
    applyIsolated(a, env, "/work/my branch!");
    assert.equal(env.TORIEL_PROFILE, "my-branch-");
  });

  it("does not take a subcommand for a name", () => {
    for (const sub of ["doctor", "kill-server"]) {
      const a = argv("--isolated", sub);
      const env: NodeJS.ProcessEnv = {};
      applyIsolated(a, env, "/work/branch");
      assert.deepEqual(a, argv(sub));
      assert.equal(env.TORIEL_PROFILE, "branch");
    }
  });

  it("leaves everything alone without the flag", () => {
    const a = argv("doctor", "--fix");
    const env: NodeJS.ProcessEnv = {};
    applyIsolated(a, env, "/work/branch");
    assert.deepEqual(a, argv("doctor", "--fix"));
    assert.equal(env.TORIEL_PROFILE, undefined);
  });
});

describe("a real isolated daemon", () => {
  it("says it is isolated in its hello, and writes its log and pidfile inside the private directory only", async () => {
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-iso-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-home-"));
    const env = { ...process.env, XDG_RUNTIME_DIR: runtime, HOME: home, TORIEL_PROFILE: "t", TORIEL_NO_INHIBIT: "1", XDG_DATA_HOME: path.join(home, "share"), XDG_STATE_HOME: path.join(home, "state") };
    const proc = spawn(process.execPath, [path.join(ROOT, "src", "daemon.ts")], { env, stdio: "ignore" });
    const sock = path.join(runtime, "toriel-t", "toriel.sock");
    try {
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(sock) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      const { Client } = await import("./helpers.ts");
      const c = await Client.connect(sock);
      await c.request({ type: "list" });
      const hello = await c.waitFor((m) => m.type === "hello");
      assert.equal(hello.profile, "t");
      assert.equal(hello.sock, sock);
      assert.equal(hello.pid, proc.pid);
      c.close();
      assert.ok(fs.existsSync(path.join(runtime, "toriel-t", "state", "daemon.log")));
      assert.ok(fs.existsSync(path.join(runtime, "toriel-t", "data", "toriel", "daemon.pid")));
      assert.ok(!fs.existsSync(path.join(home, "state")), "the real state directory was not created");
      assert.ok(!fs.existsSync(path.join(home, "share")), "the real data directory was not created");
    } finally {
      proc.kill("SIGTERM");
      await new Promise((r) => proc.once("exit", r));
      fs.rmSync(runtime, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
