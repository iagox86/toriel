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
    this.launch();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.child?.kill("SIGTERM");
  }

  private launch(): void {
    const startedAt = Date.now();
    // the bridge's environment: the daemon's own plus the socket to talk to; tokenEnv, when used, is read from it
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", MAIN], { env: { ...process.env, TORIEL_SOCK: SOCK }, stdio: ["ignore", "ignore", "pipe"] });
    this.child = child;
    let tail = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      tail += chunk;
      for (let i = tail.indexOf("\n"); i !== -1; i = tail.indexOf("\n")) {
        log(`chat bridge: ${tail.slice(0, i)}`);
        tail = tail.slice(i + 1);
      }
    });
    child.once("error", (err) => log(`chat bridge could not start: ${err.message}`));
    child.once("exit", (code, signal) => {
      this.child = undefined;
      if (this.ctx.published.bridgeUp) {
        this.ctx.published.bridgeUp = false;
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
      this.timer = setTimeout(() => this.launch(), this.delay);
      this.timer.unref();
      this.delay = Math.min(this.delay * 2, MAX_DELAY_MS);
    });
  }
}
