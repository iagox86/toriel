// The schedule store and its clock (docs/design.md item 10). It knows nothing
// about sessions beyond a UUID string: the daemon passes in a `SchedulerHost`
// that says whether a session can take a prompt right now and delivers one.
// Everything time-related goes through the host, so tests drive it with a fake
// clock. Rules: a fire never interrupts (it waits until the host says ready),
// at most one fire per schedule is waiting (missed ones are dropped, not
// stacked), and a schedule never vanishes silently (every end is an event).
import { readJsonOr, writeJsonAtomic } from "./util.ts";
import { nextFire, type Trigger } from "./when.ts";

export interface Schedule {
  id: number;
  /** UUID of the session it fires into. */
  session: string;
  name?: string;
  prompt: string;
  trigger: Trigger;
  /** Stop after this many fires. */
  max?: number;
  fired: number;
  createdAt: number;
  /** Epoch ms after which it ends; null = never. */
  expiresAt: number | null;
  /** After daemon downtime: fire once, flagged late ("once"), or just move on ("skip"). */
  catchup: "once" | "skip";
  by: "user" | "agent";
  /** Shell checks the daemon runs before each fire, no model involved: `until` met = one final fire then done; `while` failing = done, quietly. */
  until?: string;
  while?: string;
  state: "active" | "paused";
  /** Undefined while a gap loop's run is in progress. */
  nextFire?: number;
  lastFire?: number;
  /** Consecutive delivery failures; the schedule pauses itself after MAX_FAILURES. */
  failures?: number;
  lastError?: string;
}

/** "condition": its --while check stopped holding. */
export type EndReason = "completed" | "expired" | "max" | "cancelled" | "session-removed" | "condition";

export type SchedulerEvent =
  | { type: "fired"; schedule: Schedule; run: number; lateBy: number }
  | { type: "ended"; schedule: Schedule; reason: EndReason }
  | { type: "failed"; schedule: Schedule; error: string; paused: boolean }
  /** A due schedule is being held back (daily limit, usage budget); said once per hold. */
  | { type: "held"; schedule: Schedule; reason: string }
  | { type: "changed" };

export interface FireInfo {
  /** 1-based count including this fire. */
  run: number;
  /** How long after its due time it fires; the daemon labels anything long as late. */
  lateBy: number;
}

export interface SchedulerHost {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Can this session take a prompt now? False while it streams, compacts or shows a dialog; an inactive session is ready (delivery respawns it). */
  ready(session: string): boolean;
  /** Why a session's schedules should not fire now (its provider's usage is nearly spent), or undefined. */
  budget?(session: string): string | undefined;
  /** Run the schedule's `until` / `while` check: "go" fires, "wait" tries again next slot, "stop" ends it. */
  check(schedule: Schedule): Promise<"go" | "wait" | "stop">;
  /** Put the prompt in the session; rejects when it cannot. */
  deliver(schedule: Schedule, info: FireInfo): Promise<void>;
  event(e: SchedulerEvent): void;
}

export interface NewSchedule {
  session: string;
  prompt: string;
  trigger: Trigger;
  name?: string;
  max?: number;
  /** ms from now; null = never expire; omitted = the default (7 days for anything recurring). */
  expiresIn?: number | null;
  catchup?: "once" | "skip";
  by?: "user" | "agent";
  until?: string;
  while?: string;
}

export interface Limits {
  perSession: number;
  agentPerSession: number;
  /** Shortest repeat interval. */
  minIntervalMs: number;
  /** Shortest repeat interval when a shell check gates each run (checks cost nothing). */
  minCheckIntervalMs: number;
  /** Most scheduled runs (all sessions together) in any 24 hours; the rest wait. */
  dailyFires: number;
  defaultExpiryMs: number;
}

export const DEFAULT_LIMITS: Limits = { perSession: 20, agentPerSession: 10, minIntervalMs: 60_000, minCheckIntervalMs: 10_000, dailyFires: 200, defaultExpiryMs: 7 * 86_400_000 };

const MAX_FAILURES = 5;
const RETRY_MS = 30_000;
/** A session that is not ready is checked again this often even without a nudge. */
const WAIT_POLL_MS = 5_000;
/** setTimeout cannot take more than ~24 days; wake earlier and look again. */
const LONGEST_SLEEP_MS = 3_600_000;

interface StoreFile {
  version: 1;
  nextId: number;
  schedules: Schedule[];
  /** When recent scheduled runs happened (the last 24h), for the daily limit. */
  fires?: number[];
}

export class Scheduler {
  private schedules = new Map<number, Schedule>();
  private nextId = 1;
  private timer: unknown;
  private ticking = false;
  private again = false;
  private readonly retryAt = new Map<number, number>();
  private fireLog: number[] = [];
  private readonly held = new Map<number, string>();

  private readonly host: SchedulerHost;
  private readonly file: string;
  private readonly limits: Limits;

  constructor(host: SchedulerHost, file: string, limits: Limits = DEFAULT_LIMITS) {
    this.host = host;
    this.file = file;
    this.limits = limits;
  }

  /** Load the file and settle anything that came due while the daemon was down. */
  start(): void {
    const data = readJsonOr<StoreFile>(this.file, { version: 1, nextId: 1, schedules: [] });
    this.nextId = data.nextId;
    this.fireLog = data.fires ?? [];
    this.schedules = new Map(data.schedules.map((s) => [s.id, s]));
    const t = this.host.now();
    for (const s of this.schedules.values()) {
      if (s.state === "active" && s.nextFire !== undefined && s.nextFire <= t && s.catchup === "skip" && s.trigger.kind !== "once") {
        s.nextFire = nextFire(s.trigger, t);
      }
      if (s.trigger.kind === "loop" && s.nextFire === undefined && s.state === "active") {
        s.nextFire = t; // the run it was waiting on died with the daemon
      }
    }
    this.save();
    void this.tick();
  }

  stop(): void {
    if (this.timer !== undefined) {
      this.host.clearTimer(this.timer);
      this.timer = undefined;
    }
  }

  list(session?: string): Schedule[] {
    return [...this.schedules.values()].filter((s) => session === undefined || s.session === session).sort((a, b) => a.id - b.id);
  }

  /** Why a schedule is being held back right now, if it is. */
  heldReason(id: number): string | undefined {
    return this.held.get(id);
  }

  get(id: number): Schedule | undefined {
    return this.schedules.get(id);
  }

  /** The soonest next fire among a session's active schedules (the switcher marker). */
  soonest(session: string): number | undefined {
    const times = this.list(session).flatMap((s) => (s.state === "active" && s.nextFire !== undefined ? [s.nextFire] : []));
    return times.length > 0 ? Math.min(...times) : undefined;
  }

  add(spec: NewSchedule): Schedule {
    const by = spec.by ?? "user";
    const mine = this.list(spec.session);
    const cap = by === "agent" ? this.limits.agentPerSession : this.limits.perSession;
    if (mine.filter((s) => s.by === by).length >= cap) {
      throw new Error(`this session already has ${cap} ${by === "agent" ? "agent-made " : ""}schedules; cancel some first (/schedules)`);
    }
    const interval = spec.trigger.kind === "every" ? spec.trigger.ms : spec.trigger.kind === "loop" ? spec.trigger.gapMs : undefined;
    const gated = spec.until !== undefined || spec.while !== undefined;
    if (gated && (spec.trigger.kind === "once" || (spec.trigger.kind === "loop" && spec.trigger.gapMs === undefined))) {
      throw new Error("--until / --while need a repeating schedule with an interval (/every, /cron, or /loop with a gap)");
    }
    if (spec.until !== undefined && spec.while !== undefined) {
      throw new Error("use --until or --while, not both");
    }
    const floor = gated ? this.limits.minCheckIntervalMs : this.limits.minIntervalMs;
    if (interval !== undefined && interval < floor) {
      throw new Error(`the shortest repeat interval is ${floor / 1000}s${gated ? "" : " (each run costs a model call; with --until or --while it is 10s)"}`);
    }
    if (spec.name && mine.some((s) => s.name === spec.name)) {
      throw new Error(`a schedule named "${spec.name}" already exists in this session`);
    }
    const t = this.host.now();
    // a loop runs its first pass at once; everything else waits for its first slot
    const first = spec.trigger.kind === "loop" ? t : nextFire(spec.trigger, t);
    if (first === undefined) {
      throw new Error("that schedule would never fire");
    }
    const recurring = spec.trigger.kind !== "once";
    const expiresIn = spec.expiresIn === undefined ? (recurring ? this.limits.defaultExpiryMs : null) : spec.expiresIn;
    const s: Schedule = {
      id: this.nextId++,
      session: spec.session,
      name: spec.name,
      prompt: spec.prompt,
      trigger: spec.trigger,
      max: spec.max,
      fired: 0,
      createdAt: t,
      expiresAt: expiresIn === null ? null : t + expiresIn,
      catchup: spec.catchup ?? "once",
      by,
      until: spec.until,
      while: spec.while,
      state: "active",
      nextFire: first,
    };
    this.schedules.set(s.id, s);
    this.changed();
    return s;
  }

  /** Cancel by id; returns the removed schedule. */
  cancel(id: number): Schedule {
    const s = this.require(id);
    this.end(s, "cancelled");
    return s;
  }

  /** The session was deleted or killed: its schedules go with it. */
  removeSession(session: string): Schedule[] {
    const gone = this.list(session);
    for (const s of gone) {
      this.end(s, "session-removed");
    }
    return gone;
  }

  pause(id: number): Schedule {
    const s = this.require(id);
    s.state = "paused";
    this.changed();
    return s;
  }

  resume(id: number): Schedule {
    const s = this.require(id);
    const t = this.host.now();
    s.state = "active";
    s.failures = undefined;
    s.lastError = undefined;
    // a one-shot whose time passed while paused fires now; everything else picks up its next slot
    s.nextFire = s.trigger.kind === "once" ? Math.max(s.trigger.at, t) : (nextFire(s.trigger, t) ?? t);
    this.changed();
    return s;
  }

  /** Run it now without disturbing its schedule (the `/fire` command). */
  async fireNow(id: number): Promise<void> {
    const s = this.require(id);
    if (!this.host.ready(s.session)) {
      throw new Error("the session is busy right now; try again when it is idle");
    }
    await this.host.deliver(s, { run: s.fired + 1, lateBy: 0 });
    s.fired += 1;
    s.lastFire = this.host.now();
    this.save();
  }

  /** The host's cue that a session may now be ready (it went idle, a dialog closed): look for due schedules. */
  poke(): void {
    void this.tick();
  }

  /** A session finished a run: a gap loop's countdown starts now. */
  runFinished(session: string): void {
    const t = this.host.now();
    let any = false;
    for (const s of this.schedules.values()) {
      if (s.session === session && s.trigger.kind === "loop" && s.trigger.gapMs !== undefined && s.nextFire === undefined && s.state === "active") {
        s.nextFire = t + s.trigger.gapMs;
        any = true;
      }
    }
    if (any) {
      this.changed();
    }
  }

  private require(id: number): Schedule {
    const s = this.schedules.get(id);
    if (!s) {
      throw new Error(`no schedule #${id}`);
    }
    return s;
  }

  private end(s: Schedule, reason: EndReason): void {
    this.schedules.delete(s.id);
    this.retryAt.delete(s.id);
    this.held.delete(s.id);
    this.save();
    this.host.event({ type: "ended", schedule: s, reason });
    this.host.event({ type: "changed" });
    this.arm();
  }

  private changed(): void {
    this.save();
    this.host.event({ type: "changed" });
    this.arm();
    void this.tick();
  }

  private save(): void {
    const data: StoreFile = { version: 1, nextId: this.nextId, schedules: this.list(), fires: this.fireLog };
    writeJsonAtomic(this.file, data);
  }

  /** Sleep until the earliest thing that needs attention. */
  private arm(): void {
    if (this.timer !== undefined) {
      this.host.clearTimer(this.timer);
      this.timer = undefined;
    }
    const t = this.host.now();
    let wake: number | undefined;
    const consider = (at: number | undefined) => {
      if (at !== undefined && (wake === undefined || at < wake)) {
        wake = at;
      }
    };
    for (const s of this.schedules.values()) {
      consider(s.expiresAt ?? undefined);
      if (s.state === "active" && s.nextFire !== undefined) {
        // due but waiting on the session: poll, do not spin
        consider(s.nextFire <= t ? Math.max(t + WAIT_POLL_MS, this.retryAt.get(s.id) ?? 0) : Math.max(s.nextFire, this.retryAt.get(s.id) ?? 0));
      }
    }
    if (wake === undefined) {
      return;
    }
    const delay = Math.min(Math.max(0, wake - t), LONGEST_SLEEP_MS);
    this.timer = this.host.setTimer(() => {
      this.timer = undefined;
      void this.tick();
    }, delay);
  }

  private async tick(): Promise<void> {
    if (this.ticking) {
      this.again = true;
      return;
    }
    this.ticking = true;
    try {
      do {
        this.again = false;
        await this.runDue();
      } while (this.again);
    } finally {
      this.ticking = false;
      this.arm();
    }
  }

  private async runDue(): Promise<void> {
    const t = this.host.now();
    for (const s of this.list()) {
      if (s.expiresAt !== null && t >= s.expiresAt) {
        this.end(s, "expired");
        continue;
      }
      if (s.state !== "active" || s.nextFire === undefined || s.nextFire > t || (this.retryAt.get(s.id) ?? 0) > t) {
        continue;
      }
      if (!this.host.ready(s.session)) {
        continue;
      }
      const hold = this.holdReason(s, t);
      if (hold !== undefined) {
        if (this.held.get(s.id) !== hold) {
          this.held.set(s.id, hold);
          this.host.event({ type: "held", schedule: s, reason: hold });
          this.host.event({ type: "changed" });
        }
        continue;
      }
      if (this.held.delete(s.id)) {
        this.host.event({ type: "changed" });
      }
      await this.fire(s, t);
    }
  }

  /** Daily limit or usage budget: a reason to leave a due schedule waiting, else undefined. */
  private holdReason(s: Schedule, t: number): string | undefined {
    this.fireLog = this.fireLog.filter((at) => t - at < 86_400_000);
    if (this.fireLog.length >= this.limits.dailyFires) {
      return `the limit of ${this.limits.dailyFires} scheduled runs per 24 hours is reached (the next slot opens when the oldest run is a day old)`;
    }
    return this.host.budget?.(s.session);
  }

  private async fire(s: Schedule, t: number): Promise<void> {
    const due = s.nextFire ?? t;
    const run = s.fired + 1;
    if (s.until !== undefined || s.while !== undefined) {
      const verdict = await this.host.check(s);
      if (!this.schedules.has(s.id)) {
        return;
      }
      if (verdict === "stop") {
        this.end(s, "condition");
        return;
      }
      if (verdict === "wait") {
        // not yet: no model call, no run counted; look again at the next slot
        s.nextFire = nextFire(s.trigger, t);
        this.save();
        return;
      }
    }
    try {
      await this.host.deliver(s, { run, lateBy: Math.max(0, t - due) });
    } catch (err) {
      this.failed(s, err instanceof Error ? err.message : String(err), t);
      return;
    }
    if (!this.schedules.has(s.id)) {
      return; // cancelled while the prompt was being delivered
    }
    s.fired = run;
    s.lastFire = t;
    this.fireLog.push(t);
    s.failures = undefined;
    s.lastError = undefined;
    this.retryAt.delete(s.id);
    this.host.event({ type: "fired", schedule: s, run, lateBy: Math.max(0, t - due) });
    if (s.trigger.kind === "once" || (s.trigger.kind === "loop" && s.trigger.gapMs === undefined) || s.until !== undefined) {
      this.end(s, "completed");
    } else if (s.max !== undefined && run >= s.max) {
      this.end(s, "max");
    } else {
      // a gap loop waits for the run to finish (runFinished); the rest take their next slot, skipping any that were missed
      s.nextFire = s.trigger.kind === "loop" ? undefined : nextFire(s.trigger, t);
      if (s.nextFire === undefined && s.trigger.kind !== "loop") {
        this.end(s, "completed");
      } else {
        this.changed();
      }
    }
  }

  private failed(s: Schedule, error: string, t: number): void {
    s.failures = (s.failures ?? 0) + 1;
    s.lastError = error;
    const paused = s.failures >= MAX_FAILURES;
    if (paused) {
      s.state = "paused";
    } else {
      this.retryAt.set(s.id, t + RETRY_MS);
    }
    this.save();
    this.host.event({ type: "failed", schedule: s, error, paused });
    this.host.event({ type: "changed" });
  }
}
