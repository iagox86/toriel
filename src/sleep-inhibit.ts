// Keeps the machine from suspending while toriel has work: a session with a
// turn running, or a scheduled run coming up soon. It holds a logind inhibitor
// lock (systemd-inhibit) in a small child process for as long as that is true
// and lets go otherwise. The child watches the daemon's pid, so a daemon that
// dies without cleaning up does not leave the machine awake forever.
import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import type { Schedule } from "./scheduler.ts";

/** A scheduled run closer than this keeps the machine awake; a later one does not (a long wait should not hold a laptop open). */
export const AWAKE_BEFORE_FIRE_MS = 30 * 60_000;

/** Should the machine stay awake: any session working, or an active schedule due within `AWAKE_BEFORE_FIRE_MS`. */
export function needsAwake(sessions: ReadonlyArray<{ streaming: boolean; compacting: boolean }>, schedules: readonly Schedule[], now: number): boolean {
  if (sessions.some((s) => s.streaming || s.compacting)) {
    return true;
  }
  return schedules.some((s) => s.state === "active" && s.nextFire !== undefined && s.nextFire - now < AWAKE_BEFORE_FIRE_MS);
}

type Child = Pick<ChildProcess, "kill" | "once">;
export type SpawnFn = (command: string, args: string[]) => Child;

export interface InhibitorOptions {
  spawn?: SpawnFn;
  log: (message: string) => void;
  /** Pid the lock child watches; when it is gone the child exits and the lock is released. */
  ownerPid?: number;
  platform?: NodeJS.Platform;
  now?: () => number;
}

/** A child that dies sooner than this after starting is treated as "this does not work here", not retried. */
const TOO_QUICK_MS = 3_000;

export class SleepInhibitor {
  private child: Child | undefined;
  private startedAt = 0;
  private disabled: boolean;
  private readonly spawn: SpawnFn;
  private readonly log: (message: string) => void;
  private readonly ownerPid: number;
  private readonly now: () => number;

  constructor(opts: InhibitorOptions) {
    this.spawn = opts.spawn ?? ((command, args) => nodeSpawn(command, args, { stdio: "ignore" }));
    this.log = opts.log;
    this.ownerPid = opts.ownerPid ?? process.pid;
    this.now = opts.now ?? Date.now;
    // logind is Linux's; elsewhere there is nothing to ask
    this.disabled = (opts.platform ?? process.platform) !== "linux";
  }

  get held(): boolean {
    return this.child !== undefined;
  }

  /** Hold the lock while `awake`, release it otherwise. Cheap to call often. */
  update(awake: boolean): void {
    if (this.disabled) {
      return;
    }
    if (awake && !this.child) {
      this.acquire();
    } else if (!awake && this.child) {
      this.release("nothing is running or due soon");
    }
  }

  /** Let go of the lock for good (daemon shutdown). */
  stop(): void {
    this.disabled = true;
    this.release("shutting down");
  }

  private acquire(): void {
    const watch = `while kill -0 ${this.ownerPid} 2>/dev/null; do sleep 5; done`;
    let child: Child;
    try {
      child = this.spawn("systemd-inhibit", ["--what=idle:sleep", "--who=toriel", "--why=an agent is working or a scheduled run is due soon", "--mode=block", "sh", "-c", watch]);
    } catch (err) {
      this.giveUp(err instanceof Error ? err.message : String(err));
      return;
    }
    this.child = child;
    this.startedAt = this.now();
    child.once("error", (err) => {
      if (this.child === child) {
        this.child = undefined;
      }
      this.giveUp(err.message);
    });
    child.once("exit", () => {
      if (this.child !== child) {
        return;
      }
      this.child = undefined;
      if (this.now() - this.startedAt < TOO_QUICK_MS) {
        this.giveUp("systemd-inhibit exited right away");
      }
    });
    this.log("sleep inhibited (a session is working or a scheduled run is due soon)");
  }

  private release(why: string): void {
    const child = this.child;
    if (!child) {
      return;
    }
    this.child = undefined;
    child.kill();
    this.log(`sleep allowed again (${why})`);
  }

  private giveUp(reason: string): void {
    if (!this.disabled) {
      this.disabled = true;
      this.log(`cannot inhibit sleep (${reason}); not trying again. Set "preventSleep": false in settings.json to silence this.`);
    }
  }
}
