// Test harness: runs a real daemon in an isolated temp dir against the fake pi.
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { LineSplitter } from "../src/shared.ts";

const DAEMON = path.join(import.meta.dirname, "..", "src", "daemon.ts");
const FAKE_PI = path.join(import.meta.dirname, "fixtures", "fake-pi.mjs");

// A run that dies mid-test (timeout, ctrl-c, crash) never reaches stop(); without this the
// daemons it started, and their fake-pi children, outlive it.
const started = new Set<ChildProcess>();
process.on("exit", () => {
  for (const proc of started) {
    if (proc.exitCode === null && proc.pid) {
      try {
        process.kill(proc.pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
  }
});

export interface Harness {
  dir: string;
  sock: string;
  sessionsDir: string;
  stop(): Promise<void>;
  connect(): Promise<Client>;
}

/**
 * What a daemon hands its children, plus the `toriel --timing` switches (a daemon inherits those from the controller); a test run from
 * inside a toriel session inherits them and must not act on them (test daemons would write to the real timing.jsonl, ticket 225).
 * Spawned daemons get their env through `withoutSessionEnv`; `npm test` strips the three switches from the test process itself
 * (`env -u` in package.json), because unit tests import src modules whose `getTiming` reads the environment at import time.
 */
export const SESSION_ENV = ["TORIEL_SOCK", "TORIEL_CAN_SPAWN", "TORIEL_AGENT_TYPES", "TORIEL_PROFILE", "TORIEL_SESSION_ID", "TORIEL_CHILD", "TORIEL_TIMING", "TORIEL_TIMING_MS", "TORIEL_TIMING_FILE"] as const;

/** `env` without the variables a surrounding toriel session set. */
export function withoutSessionEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const k of SESSION_ENV) {
    delete clean[k];
  }
  return clean;
}

export async function startDaemon(extraEnv: Record<string, string> = {}): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-test-"));
  const sock = path.join(dir, "toriel.sock");
  const sessionsDir = path.join(dir, "sessions");
  const env = {
    ...withoutSessionEnv(process.env),
    // the daemon's RpcClient spawns plain `node` from PATH
    PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}`,
    TORIEL_SOCK: sock,
    TORIEL_LOG: path.join(dir, "daemon.log"),
    TORIEL_TRASH: path.join(dir, "trash"),
    TORIEL_SCHEDULES: path.join(dir, "schedules.json"),
    TORIEL_PERMISSIONS: path.join(dir, "permissions.json"),
    TORIEL_PUBLISHED: path.join(dir, "published.json"),
    // a test daemon never starts a chat bridge, whatever settings it finds (ticket 271)
    TORIEL_NO_CHAT: "1",
    // where the write/edit tools journal what they change (ticket 11): not the real state directory
    TORIEL_FILE_HISTORY_DIR: path.join(dir, "file-history"),
    TORIEL_PLAN_DIR: path.join(dir, "plan-mode"),
    // no bundled pi packages unless a test makes some (ticket 230), so the arguments a child gets do not depend on what npm installed here
    TORIEL_BUNDLED_ROOT: path.join(dir, "no-bundled-packages"),
    // settings come from XDG_CONFIG_HOME, so pin it too: a test daemon must not read the user's real settings file
    XDG_CONFIG_HOME: path.join(dir, "config"),
    // a test daemon must not take real logind sleep locks
    TORIEL_NO_INHIBIT: "1",
    TORIEL_PI_CLI: FAKE_PI,
    // no test daemon may run the title model (it would be fake-pi in print mode); the auto-name tests turn it on
    TORIEL_AUTO_NAME: "0",
    XDG_DATA_HOME: path.join(dir, "data"),
    FAKE_PI_DIR: sessionsDir,
    ...extraEnv,
  };
  const proc: ChildProcess = spawn(process.execPath, [DAEMON], { env, stdio: "ignore" });
  started.add(proc);
  proc.once("exit", () => started.delete(proc));
  const clients: Client[] = [];
  // a budget, not a delay: a daemon starts in well under a second idle, but a busy machine (a full parallel suite, other agents) can take many seconds
  const deadline = Date.now() + 30_000;
  while (!fs.existsSync(sock)) {
    if (Date.now() > deadline) {
      proc.kill("SIGKILL");
      throw new Error("daemon did not start");
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return {
    dir,
    sock,
    sessionsDir,
    async connect() {
      const c = await Client.connect(sock);
      clients.push(c);
      return c;
    },
    async stop() {
      for (const c of clients) {
        c.close();
      }
      proc.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        if (proc.exitCode !== null) {
          resolve();
          return;
        }
        proc.once("exit", () => resolve());
      });
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Wire messages are checked field-by-field in tests, not modelled.
// biome-ignore lint/suspicious/noExplicitAny: loosely-typed protocol messages
export type Msg = Record<string, any>;

export class Client {
  messages: Msg[] = [];
  private socket: net.Socket;
  private seq = 0;
  private waiters: Array<() => void> = [];

  private constructor(socket: net.Socket) {
    this.socket = socket;
    const splitter = new LineSplitter();
    socket.on("data", (chunk: Buffer) => {
      for (const line of splitter.push(chunk.toString("utf8"))) {
        this.messages.push(JSON.parse(line));
      }
      for (const w of this.waiters.splice(0)) {
        w();
      }
    });
  }

  /**
   * The socket file appears when the daemon binds it, a moment before it listens (longer on a busy machine), so a refused connect is
   * retried for a while (ticket 253). Any other error is a real one.
   */
  static async connect(sock: string, budgetMs = 10_000): Promise<Client> {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      try {
        return await new Promise<Client>((resolve, reject) => {
          const socket = net.connect(sock);
          socket.once("connect", () => resolve(new Client(socket)));
          socket.once("error", reject);
        });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if ((code !== "ECONNREFUSED" && code !== "ENOENT") || Date.now() > deadline) {
          throw err;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
    }
  }

  send(msg: Msg): void {
    this.socket.write(`${JSON.stringify(msg)}\n`);
  }

  /** Send a command and resolve with its response (rejects on ok:false). */
  async request(cmd: Msg): Promise<Msg> {
    const id = `t${++this.seq}`;
    this.send({ ...cmd, id });
    const res = await this.waitFor((m) => m.type === "response" && m.id === id);
    if (!res.ok) {
      throw new Error(res.error);
    }
    return res.data;
  }

  /** Resolve with the first message (already received or future) matching. */
  async waitFor(pred: (m: Msg) => boolean, timeoutMs = 20_000): Promise<Msg> {
    const deadline = Date.now() + timeoutMs;
    let from = 0;
    for (;;) {
      for (; from < this.messages.length; from++) {
        if (pred(this.messages[from])) {
          return this.messages[from];
        }
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`timed out waiting for message; saw ${JSON.stringify(this.messages.slice(-5))}`);
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, remaining);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  /** Latest session list this client has received. */
  sessions(): Msg[] {
    const last = [...this.messages].reverse().find((m) => m.type === "sessions");
    return last?.sessions ?? [];
  }

  close(): void {
    this.socket.destroy();
  }
}

/**
 * Wait (up to `ms`) until `cond` is true, polling every 10 ms; resolves either way, so the assertion that follows is what fails with
 * a message. Use it where a test reads the result of real IO (a file write, an HTTP round trip) instead of sleeping a fixed time,
 * which races a loaded machine (ticket 252).
 */
export async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
