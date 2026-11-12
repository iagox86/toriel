// The daemon's side of "on change" schedules (board 98): keeps one FileWatcher watch per ACTIVE
// watch schedule and tells the Scheduler when a watched file changed. The Scheduler owns everything
// else (when it may fire, caps, the daily limit, retries, expiry); this only turns file events into
// `Scheduler.triggered(id)`.
//
// `sync` is cheap and idempotent: call it whenever the set of schedules may have changed (the
// scheduler's events) and once at start. A watch that cannot be set up (its directory is missing, a
// system limit) is not silently dropped: the reason is kept (`problem`, shown in the listing) and
// the watch is retried every RETRY_MS, because the directory may come back.
import { type FileWatcher, type WatchSpec, watchedDir } from "./file-watch.ts";
import { log } from "./log.ts";
import type { Schedule } from "./scheduler.ts";
import { errText } from "./util.ts";

export const RETRY_MS = 30_000;
/** Most watches at once: every one is an inotify instance's worth of kernel memory and a user limit is shared with everything else. */
export const MAX_WATCHES = 50;

interface SchedulerLike {
  list(): Schedule[];
  triggered(id: number): void;
}

interface WatcherLike {
  arm: FileWatcher["arm"];
  disarm: FileWatcher["disarm"];
  has: FileWatcher["has"];
  ids: FileWatcher["ids"];
  check: FileWatcher["check"];
  closeAll: FileWatcher["closeAll"];
  readonly size: number;
}

export interface WatchTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const systemTimers: WatchTimers = {
  set: (fn, ms) => {
    const t = setInterval(fn, ms);
    t.unref();
    return t;
  },
  clear: (h) => clearInterval(h as NodeJS.Timeout),
};

/** The watch a schedule asks for, or undefined when it is not an active watch. */
export function specOf(s: Schedule): WatchSpec | undefined {
  return s.trigger.kind === "watch" && s.state === "active" ? { path: s.trigger.path, dir: s.trigger.dir, events: s.trigger.events, cooldownMs: s.trigger.cooldownMs } : undefined;
}

/** The held-reason text for a watch that cannot arm, worded the same in /schedules and the status strip. */
export function watchHeldReason(problem: string | undefined): string | undefined {
  return problem === undefined ? undefined : `cannot watch (${problem})`;
}

export class WatchManager {
  private readonly problems = new Map<number, string>();
  private timer: unknown;

  private readonly scheduler: SchedulerLike;
  private readonly watcher: WatcherLike;
  private readonly timers: WatchTimers;
  private readonly say: (line: string) => void;

  constructor(scheduler: SchedulerLike, watcher: WatcherLike, timers: WatchTimers = systemTimers, say: (line: string) => void = log) {
    this.scheduler = scheduler;
    this.watcher = watcher;
    this.timers = timers;
    this.say = say;
  }

  /** Why a watch schedule is not watching right now, or undefined when it is (or is not a watch). */
  problem(id: number): string | undefined {
    return this.problems.get(id);
  }

  /** Bring the set of live watches in line with the schedules. */
  sync(): void {
    const wanted = new Map<number, Schedule>();
    for (const s of this.scheduler.list()) {
      if (specOf(s) !== undefined) {
        wanted.set(s.id, s);
      }
    }
    for (const id of [...this.problems.keys()]) {
      if (!wanted.has(id)) {
        this.problems.delete(id);
      }
    }
    // schedules that ended, paused or were cancelled stop watching at once (inotify watches are not free)
    for (const id of this.watcher.ids()) {
      if (!wanted.has(id)) {
        this.watcher.disarm(id);
      }
    }
    for (const [id, s] of wanted) {
      if (this.watcher.has(id)) {
        continue;
      }
      const spec = specOf(s) as WatchSpec;
      if (this.watcher.size >= MAX_WATCHES) {
        this.fail(id, `too many file watches (${MAX_WATCHES}); cancel some (/schedules)`);
        continue;
      }
      try {
        this.watcher.arm(
          id,
          spec,
          () => this.scheduler.triggered(id),
          (message) => {
            this.fail(id, message);
            this.maintain();
          },
        );
        if (this.problems.delete(id)) {
          this.say(`file watch #${id} is watching ${spec.path} again`);
        }
      } catch (err) {
        this.fail(id, errText(err));
      }
    }
    this.keepTimer(wanted.size > 0);
  }

  stop(): void {
    this.keepTimer(false);
    this.watcher.closeAll();
  }

  private fail(id: number, message: string): void {
    if (this.problems.get(id) !== message) {
      this.say(`file watch #${id} is not watching: ${message} (retrying every ${RETRY_MS / 1000}s)`);
    }
    this.problems.set(id, message);
  }

  /** Periodic: check live watches are still on their directory, and retry the ones that could not start. */
  private maintain(): void {
    for (const s of this.scheduler.list()) {
      if (specOf(s) === undefined || !this.watcher.has(s.id)) {
        continue;
      }
      if (!this.watcher.check(s.id, (message) => this.fail(s.id, message))) {
        const spec = specOf(s) as WatchSpec;
        this.watcher.disarm(s.id);
        this.fail(s.id, `${watchedDir(spec)} is gone`);
      }
    }
    this.sync();
  }

  private keepTimer(wantRunning: boolean): void {
    if (wantRunning && this.timer === undefined) {
      this.timer = this.timers.set(() => this.maintain(), RETRY_MS);
    } else if (!wantRunning && this.timer !== undefined) {
      this.timers.clear(this.timer);
      this.timer = undefined;
    }
  }
}
