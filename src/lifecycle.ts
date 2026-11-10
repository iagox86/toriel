// Daemon process lifecycle as seen from a controller: detect, auto-start,
// wait for, and stop the daemon.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { PID_FILE, SOCK } from "./config.ts";
import { runningDaemon } from "./daemon-lock.ts";
import { encodeLine, LineSplitter, type DaemonMessage } from "./shared.ts";
import type { Hello } from "./version-check.ts";

const DAEMON_FILE = path.join(import.meta.dirname, "daemon.ts");

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** True when something is listening on the socket. */
export function socketAlive(timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(SOCK);
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    s.setTimeout(timeoutMs, () => done(false));
  });
}

/**
 * Ask the daemon on the socket which code it runs: announce like a controller (`list`) and read until its hello
 * arrives. `hello` is undefined for a daemon that answers with the session list without one (it predates the
 * version check); `up` is false when nothing answers in time.
 */
export function probeDaemon(timeoutMs = 1500): Promise<{ up: boolean; hello?: Hello }> {
  return new Promise((resolve) => {
    const socket = net.connect(SOCK);
    const splitter = new LineSplitter();
    const done = (result: { up: boolean; hello?: Hello }) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done({ up: false }));
    socket.once("error", () => done({ up: false }));
    socket.once("connect", () => socket.write(encodeLine({ type: "list" })));
    socket.on("data", (chunk: Buffer) => {
      for (const line of splitter.push(chunk.toString("utf8"))) {
        try {
          const msg = JSON.parse(line) as DaemonMessage;
          if (msg.type === "hello") {
            done({ up: true, hello: msg });
            return;
          }
          if (msg.type === "sessions") {
            done({ up: true });
            return;
          }
        } catch {
          // not ours: keep reading until the timeout
        }
      }
    });
  });
}

/** Start the daemon detached, using this process's node (same node binary). */
function spawnDaemon(): void {
  const child = spawn(process.execPath, [DAEMON_FILE], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}

async function waitForDaemon(timeoutMs: number, alreadyRunning?: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await socketAlive()) {
      return;
    }
    await sleep(250);
  }
  if (alreadyRunning !== undefined) {
    // a second daemon would refuse to start (one per state directory), so say what is wrong
    throw new Error(`toriel daemon ${alreadyRunning} is running but not listening on ${SOCK} (started with another TORIEL_SOCK?); stop it with toriel kill-server`);
  }
  throw new Error(`daemon did not come up within ${Math.round(timeoutMs / 1000)}s (check ${SOCK} and the daemon log)`);
}

/**
 * Make sure a daemon is listening. Re-checks briefly first (another
 * controller may be mid-start), then starts one in the background.
 */
export async function ensureDaemon(): Promise<void> {
  if (await socketAlive()) {
    return;
  }
  await sleep(400);
  if (!(await socketAlive())) {
    // one already running but not answering is either mid-start or on another socket: wait, do not start a second
    const running = runningDaemon(PID_FILE);
    if (running === undefined) {
      spawnDaemon();
    }
    await waitForDaemon(running === undefined ? 20_000 : 5_000, running);
  }
}

/** controller.ts kill-server: SIGTERM the daemon (orderly child shutdown). */
export async function killServer(): Promise<void> {
  let pid: number | undefined;
  try {
    pid = Number.parseInt(fs.readFileSync(PID_FILE, "utf8").trim(), 10);
  } catch {
    // no pidfile below
  }
  if (!pid || Number.isNaN(pid)) {
    process.stderr.write(`no toriel daemon pidfile at ${PID_FILE} - daemon not running\n`);
    process.exit(1);
  }
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    if (!cmdline.includes("daemon.ts")) {
      process.stderr.write(`pid ${pid} is not the toriel daemon (stale pidfile); refusing\n`);
      process.exit(1);
    }
  } catch {
    process.stderr.write(`daemon process ${pid} is gone (stale pidfile); cleaning up\n`);
    fs.rmSync(PID_FILE, { force: true });
    process.exit(1);
  }
  const before = await probeDaemon(800);
  process.kill(pid, "SIGTERM");
  let stopped = false;
  for (let i = 0; i < 40 && !stopped; i++) {
    try {
      process.kill(pid, 0);
      await sleep(250);
    } catch {
      stopped = true;
    }
  }
  if (stopped) {
    process.stdout.write(`toriel daemon (${pid}${before.hello ? `, ${before.hello.build.label} from ${before.hello.build.dir}` : ""}) stopped\n`);
  } else {
    process.kill(pid, "SIGKILL");
    process.stdout.write(`toriel daemon (${pid}) did not exit in 10s; sent SIGKILL\n`);
  }
  await warnIfRespawned(pid);
}

/**
 * A controller that is still open starts a new daemon as soon as the old one is gone, from ITS checkout. Look for
 * that for a moment, so "stopped" is not the last word when something else has already replaced it.
 */
async function warnIfRespawned(oldPid: number): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await sleep(300);
    const now = await probeDaemon(500);
    if (now.up && now.hello?.pid !== oldPid) {
      const what = now.hello ? `pid ${now.hello.pid}, ${now.hello.build.label} from ${now.hello.build.dir}` : "an older daemon";
      process.stderr.write(`a new daemon is already running (${what}): most likely a toriel controller that is still open somewhere started it, from its own checkout. Close that one first, then kill-server again.\n`);
      return;
    }
  }
}
