import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { type Harness, type Msg, startDaemon } from "./helpers.ts";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const isSettled = (m: Msg) => m.type === "event" && m.event?.type === "agent_settled";

describe("daemon: single instance", () => {
  /** Run a second daemon against the same state directory, optionally on its own socket. */
  function second(h: Harness, sock: string): Promise<{ code: number | null; stderr: string }> {
    return new Promise((resolve) => {
      const proc = spawn(process.execPath, [path.join(import.meta.dirname, "..", "src", "daemon.ts")], {
        env: { ...process.env, TORIEL_SOCK: sock, TORIEL_LOG: path.join(h.dir, "second.log"), XDG_DATA_HOME: path.join(h.dir, "data") },
      });
      let stderr = "";
      proc.stderr.on("data", (d) => {
        stderr += d;
      });
      proc.once("exit", (code) => resolve({ code, stderr }));
    });
  }

  it("refuses to start beside a running daemon, even on a different socket, and leaves it serving", async () => {
    harness = await startDaemon();
    const r = await second(harness, path.join(harness.dir, "other.sock"));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /a toriel daemon is already running \(pid \d+/);
    assert.ok(!fs.existsSync(path.join(harness.dir, "other.sock")));
    const c = await harness.connect();
    await c.request({ type: "list" });
    await c.waitFor((m) => m.type === "sessions");
  });

  it("does not take over the socket of a running daemon", async () => {
    harness = await startDaemon();
    const before = fs.statSync(harness.sock).ino;
    const r = await second(harness, harness.sock);
    assert.equal(r.code, 1);
    assert.equal(fs.statSync(harness.sock).ino, before, "the socket file was not replaced");
  });
});

describe("daemon: sessions", () => {
  it("sends the session list to a newly connected controller", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    await c.request({ type: "list" });
    await c.waitFor((m) => m.type === "sessions");
    assert.deepEqual(c.sessions(), []);
  });

  it("replies to spawn before the child has finished starting", async () => {
    harness = await startDaemon({ FAKE_PI_STARTUP_MS: "1500" });
    const c = await harness.connect();
    const t0 = Date.now();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    assert.ok(Date.now() - t0 < 1000, "spawn reply should not wait for the child");
    assert.equal(c.sessions().find((s) => s.id === sessionId)?.active, false);

    await c.waitFor((m) => m.type === "history" && m.session === sessionId);
    assert.equal(c.sessions().find((s) => s.id === sessionId)?.active, true);
  });

  it("marks a session dead within a second of its pi process being killed, with no poll", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history" && m.session === sessionId);
    const f = c.sessions().find((x) => x.id === sessionId)?.sessionFile as string;
    const { pid } = JSON.parse(fs.readFileSync(`${f}.env.json`, "utf8")) as { pid: number };
    process.kill(pid, "SIGKILL");
    await c.waitFor((m) => m.type === "sessions" && m.sessions.some((s: Msg) => s.id === sessionId && s.dead === true), 1000);
  });

  it("delivers a prompt sent while the child is still starting", async () => {
    harness = await startDaemon({ FAKE_PI_STARTUP_MS: "800" });
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.request({ type: "prompt", session: sessionId, message: "hello" });
    const reply = await c.waitFor(
      (m) => m.type === "event" && m.event?.type === "message_end" && m.event.message?.role === "assistant",
    );
    assert.equal(reply.event.message.content[0].text, "echo: hello");
  });

  it("keeps a multi-byte character whole when a command's bytes arrive in two writes", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    const bytes = Buffer.from(`${JSON.stringify({ type: "prompt", session: sessionId, message: "smile 🙂 done", id: "split" })}\n`);
    const cut = bytes.indexOf(Buffer.from("🙂")) + 2; // inside the 4-byte emoji
    const raw = net.connect(harness.sock);
    await new Promise<void>((resolve) => raw.once("connect", resolve));
    raw.write(bytes.subarray(0, cut));
    await new Promise((resolve) => setTimeout(resolve, 50));
    raw.write(bytes.subarray(cut));
    const reply = await c.waitFor(
      (m) => m.type === "event" && m.event?.type === "message_end" && m.event.message?.role === "assistant",
    );
    raw.destroy();
    assert.equal(reply.event.message.content[0].text, "echo: smile 🙂 done");
  });

  it("streams events to every connected controller", async () => {
    harness = await startDaemon();
    const driver = await harness.connect();
    const watcher = await harness.connect();
    await watcher.request({ type: "list" });
    const { sessionId } = await driver.request({ type: "spawn", cwd: harness.dir });
    await driver.waitFor((m) => m.type === "history");
    await driver.request({ type: "prompt", session: sessionId, message: "hi" });
    await watcher.waitFor(isSettled);
    assert.ok(watcher.messages.some((m) => m.type === "event" && m.event?.type === "message_end"));
  });

  it("rolls token and cost usage up per session", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await c.request({ type: "prompt", session: sessionId, message: "hi" });
    await c.waitFor(isSettled);
    await c.waitFor((m) => m.type === "sessions" && m.sessions.some((s: Msg) => s.id === sessionId && s.tokens > 0));
    const meta = c.sessions().find((s) => s.id === sessionId);
    assert.equal(meta?.tokens, 10);
  });

  it("renames a live session", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await c.request({ type: "rename", session: sessionId, name: "renamed" });
    await c.waitFor((m) => m.type === "sessions" && m.sessions.some((s: Msg) => s.id === sessionId && s.sessionName === "renamed"));
  });
});

describe("daemon: input attach", () => {
  it("refuses a second controller until it takes over", async () => {
    harness = await startDaemon();
    const first = await harness.connect();
    const second = await harness.connect();
    const { sessionId } = await first.request({ type: "spawn", cwd: harness.dir });
    await first.waitFor((m) => m.type === "history");
    await second.request({ type: "list" });

    await assert.rejects(second.request({ type: "attach", session: sessionId }), /attached to another controller/);
    await second.request({ type: "attach", session: sessionId, force: true });
    await first.waitFor(
      (m) => m.type === "sessions" && m.sessions.some((s: Msg) => s.id === sessionId && s.attachedElsewhere),
    );
  });
});

describe("daemon: sessions open in an external pi", () => {
  const register = (h: Harness, file: string, pid: number, live = true) =>
    h.connect().then((presence) =>
      presence.request({ type: "external_register", pid, sessionFile: file, cwd: h.dir, live }),
    );

  it("reports an externally live session tagged, in the first list a controller receives", async () => {
    harness = await startDaemon();
    const file = path.join(harness.dir, "pi-session.jsonl");
    fs.writeFileSync(file, "{}\n");
    await register(harness, file, process.pid);

    const c = await harness.connect();
    c.send({ type: "list" });
    const first = await c.waitFor((m) => m.type === "sessions");
    const entry = first.sessions.find((s: Msg) => s.sessionFile === file);
    assert.equal(entry?.externallyLive, true);
  });

  it("reports a live session before its file exists so the controller can hide it", async () => {
    harness = await startDaemon();
    const file = path.join(harness.dir, "not-yet-written.jsonl");
    await register(harness, file, process.pid);

    const c = await harness.connect();
    c.send({ type: "list" });
    const first = await c.waitFor((m) => m.type === "sessions");
    assert.equal(first.sessions.find((s: Msg) => s.sessionFile === file)?.externallyLive, true);
  });

  it("removes the tag when the extension deregisters", async () => {
    harness = await startDaemon();
    const file = path.join(harness.dir, "pi-session.jsonl");
    fs.writeFileSync(file, "{}\n");
    await register(harness, file, process.pid);
    const c = await harness.connect();
    c.send({ type: "list" });
    await c.waitFor((m) => m.type === "sessions" && m.sessions.some((s: Msg) => s.sessionFile === file));

    await register(harness, file, process.pid, false);
    await c.waitFor((m) => m.type === "sessions" && !m.sessions.some((s: Msg) => s.sessionFile === file));
  });

  it("removes the tag when the pi process exits without deregistering", async () => {
    harness = await startDaemon();
    const file = path.join(harness.dir, "pi-session.jsonl");
    fs.writeFileSync(file, "{}\n");
    const pi = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    assert.ok(pi.pid);
    await register(harness, file, pi.pid);
    const c = await harness.connect();
    c.send({ type: "list" });
    await c.waitFor((m) => m.type === "sessions" && m.sessions.some((s: Msg) => s.sessionFile === file));

    pi.kill("SIGKILL");
    await c.waitFor((m) => m.type === "sessions" && !m.sessions.some((s: Msg) => s.sessionFile === file), 10_000);
  });

  it("refuses to prompt a session that is live in another pi", async () => {
    harness = await startDaemon();
    const file = path.join(harness.dir, "pi-session.jsonl");
    fs.writeFileSync(file, "{}\n");
    await register(harness, file, process.pid);
    const c = await harness.connect();
    await assert.rejects(
      c.request({ type: "prompt", sessionFile: file, cwd: harness.dir, message: "hi" }),
      /live in another pi/,
    );
  });
});

describe("daemon: resuming a file that is gone", () => {
  it("starts a fresh session instead of passing pi both --session and --session-id", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const gone = path.join(harness.dir, "gone.jsonl");
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir, sessionFile: gone, ready: true });
    const file = c.sessions().find((x) => x.id === sessionId)?.sessionFile as string;
    const argv = JSON.parse(fs.readFileSync(`${file}.argv.json`, "utf8")) as string[];
    assert.equal(argv.includes("--session"), false);
    assert.equal(argv.includes("--session-id"), true);
  });
});
