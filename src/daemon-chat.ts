// Keeps the chat bridge process (src/bridge/main.ts) running for the daemon (ticket 271): started when `chatto` is configured,
// restarted with a growing delay when it dies, stopped with the daemon. The bridge talks to the daemon over its socket like any
// controller; what it says on stderr lands in the daemon log.
import { type ChildProcess, spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { PROFILE, SOCK } from "./config.ts";
import type { DaemonContext } from "./daemon-context.ts";
import { log } from "./log.ts";
import { loadSettings } from "./settings.ts";

const MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "bridge", "main.ts");
const FIRST_DELAY_MS = 2000;
const MAX_DELAY_MS = 60_000;
/** A run this long counts as a good one: the next failure starts the delay over. */
const HEALTHY_MS = 30_000;

/** Why no bridge starts here, or undefined when one should. A test daemon never starts one; an isolated instance only when asked. */
export function chatDisabledReason(env: NodeJS.ProcessEnv, profile: string | undefined, configured: boolean): string | undefined {
  if (env.TORIEL_NO_CHAT === "1") {
    return "TORIEL_NO_CHAT is set";
  }
  if (!configured) {
    return "no chatto settings";
  }
  if (profile && env.TORIEL_CHAT !== "1") {
    return `isolated instance "${profile}" (TORIEL_CHAT=1 starts the bridge in one anyway)`;
  }
  return undefined;
}

/**
 * Why a bridge died, from the last lines it wrote to stderr: the last line that reads like an error message and is not a stack frame
 * (node prints the trace after the message), else the last line that is not a frame.
 */
export function crashReason(lines: readonly string[]): string | undefined {
  const real = lines.map((l) => l.trim()).filter((l) => l && !/^at\s/.test(l) && !/^\^+$/.test(l) && !/^Node\.js v/.test(l));
  return [...real].reverse().find((l) => /\b\w*Error\b|error:|refused|cannot|failed/i.test(l)) ?? real.at(-1);
}

const KEPT_ENV = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z_]+|TZ|TMPDIR|TERM|NODE_[A-Z_]+|SSL_CERT_(FILE|DIR)|(HTTPS?|ALL|NO)_PROXY|XDG_[A-Z_]+|TORIEL_[A-Z_]+)$/i;

/**
 * The environment the bridge gets: what node and the settings file need, the variable the token is read from (`tokenEnv`), and the
 * socket to the daemon; not the rest of the daemon's, which may hold keys the bridge has no use for.
 */
export function bridgeEnv(env: NodeJS.ProcessEnv, tokenEnv?: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && (KEPT_ENV.test(k) || k === tokenEnv)) {
      out[k] = v;
    }
  }
  return out;
}

export class ChatSupervisor {
  private child?: ChildProcess;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private delay = FIRST_DELAY_MS;
  private readonly ctx: DaemonContext;

  constructor(ctx: DaemonContext) {
    this.ctx = ctx;
  }

  start(): void {
    const { settings } = loadSettings();
    const why = chatDisabledReason(process.env, PROFILE, settings.chatto !== undefined);
    if (why) {
      if (settings.chatto) {
        log(`chat bridge not started: ${why}`);
      }
      return;
    }
    try {
      this.ctx.published.server = new URL(settings.chatto?.url ?? "").host;
    } catch {
      // validChatto has checked the URL; an odd one only costs the host in /publish's report
    }
    this.launch(settings.chatto?.tokenEnv);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    const child = this.child;
    child?.kill("SIGTERM");
    // it clears its channels for up to ten seconds; one that is still there after fifteen is hung
    const hard = setTimeout(() => child?.kill("SIGKILL"), 15_000);
    hard.unref();
    child?.once("exit", () => clearTimeout(hard));
  }

  private launch(tokenEnv?: string): void {
    const startedAt = Date.now();
    // the bridge's environment: the daemon's own plus the socket to talk to; tokenEnv, when used, is read from it
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", MAIN], { env: { ...bridgeEnv(process.env, tokenEnv), TORIEL_SOCK: SOCK }, stdio: ["ignore", "ignore", "pipe"] });
    this.child = child;
    let tail = "";
    const recent: string[] = [];
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      tail += chunk;
      for (let i = tail.indexOf("\n"); i !== -1; i = tail.indexOf("\n")) {
        log(`chat bridge: ${tail.slice(0, i)}`);
        recent.push(tail.slice(0, i));
        if (recent.length > 30) {
          recent.shift();
        }
        tail = tail.slice(i + 1);
      }
    });
    child.once("error", (err) => log(`chat bridge could not start: ${err.message}`));
    child.once("exit", (code, signal) => {
      this.child = undefined;
      if (tail.trim()) {
        log(`chat bridge: ${tail}`); // a last line with no newline
        recent.push(tail);
      }
      // why it went away, for the status line of the sessions it was showing (the last thing it said, which is its reason when it died of one)
      const why = !this.stopped && (code !== 0 || signal) ? (crashReason(recent) ?? `exited (${signal ?? code})`) : undefined;
      if (this.ctx.published.bridgeUp || this.ctx.published.problem !== why) {
        this.ctx.published.bridgeUp = false;
        this.ctx.published.problem = why;
        this.ctx.published.channels = {}; // the channels are closed when it goes
        this.ctx.hub.broadcastSessions();
      }
      if (this.stopped) {
        return;
      }
      if (code === 2) {
        log("chat bridge needs setup (see above); not restarting until the daemon does");
        return;
      }
      if (Date.now() - startedAt > HEALTHY_MS) {
        this.delay = FIRST_DELAY_MS;
      }
      log(`chat bridge exited (${signal ?? code}); restarting in ${Math.round(this.delay / 1000)}s`);
      this.timer = setTimeout(() => this.launch(tokenEnv), this.delay);
      this.timer.unref();
      this.delay = Math.min(this.delay * 2, MAX_DELAY_MS);
    });
  }
}
