import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_LIMITS, Scheduler, type FireInfo, type Limits, type Schedule, type SchedulerEvent, type SchedulerHost } from "../src/scheduler.ts";

const MIN = 60_000;
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 31, 14, 0, 0);
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** A host with a manual clock: advance() runs timers in order, as real time would. */
class FakeHost implements SchedulerHost {
  t = T0;
  timers: Array<{ at: number; fn: () => void; handle: number }> = [];
  private nextHandle = 1;
  busy = new Set<string>();
  delivered: Array<{ schedule: Schedule; info: FireInfo }> = [];
  events: SchedulerEvent[] = [];
  failWith: string | undefined;
  budgetReason: string | undefined;
  budget = (_session: string) => this.budgetReason;
  verdict: "go" | "wait" | "stop" = "go";
  checks = 0;

  now = () => this.t;
  setTimer = (fn: () => void, ms: number) => {
    const handle = this.nextHandle++;
    this.timers.push({ at: this.t + ms, fn, handle });
    return handle;
  };
  clearTimer = (handle: unknown) => {
    this.timers = this.timers.filter((x) => x.handle !== handle);
  };
  ready = (session: string) => !this.busy.has(session);
  check = async () => {
    this.checks += 1;
    return this.verdict;
  };
  deliver = async (schedule: Schedule, info: FireInfo) => {
    if (this.failWith) {
      throw new Error(this.failWith);
    }
    this.delivered.push({ schedule: { ...schedule }, info });
  };
  event = (e: SchedulerEvent) => void this.events.push(e);

  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      await settle();
      const next = this.timers.filter((x) => x.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!next) {
        break;
      }
      this.timers = this.timers.filter((x) => x !== next);
      this.t = Math.max(this.t, next.at);
      next.fn();
    }
    this.t = target;
    await settle();
  }

  ended(): Array<[number, string]> {
    return this.events.flatMap((e) => (e.type === "ended" ? [[e.schedule.id, e.reason] as [number, string]] : []));
  }
}

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-sched-"));
  file = path.join(dir, "schedules.json");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function make(limits: Limits = DEFAULT_LIMITS) {
  const host = new FakeHost();
  const sched = new Scheduler(host, file, limits);
  sched.start();
  return { host, sched };
}

const every = (ms: number) => ({ kind: "every", ms, anchor: T0 }) as const;

describe("firing", () => {
  it("fires a one-shot at its time, once, and then forgets it", async () => {
    const { host, sched } = make();
    sched.add({ session: "a", prompt: "ping", trigger: { kind: "once", at: T0 + 10 * MIN } });
    await host.advance(9 * MIN);
    assert.equal(host.delivered.length, 0);
    await host.advance(2 * MIN);
    assert.equal(host.delivered.length, 1);
    assert.equal(host.delivered[0]?.schedule.prompt, "ping");
    assert.deepEqual(host.ended(), [[1, "completed"]]);
    assert.deepEqual(sched.list(), []);
    await host.advance(HOUR);
    assert.equal(host.delivered.length, 1);
  });

  it("repeats a fixed interval on its grid", async () => {
    const { host, sched } = make();
    sched.add({ session: "a", prompt: "tick", trigger: every(30 * MIN) });
    await host.advance(2 * HOUR + MIN);
    assert.deepEqual(host.delivered.map((d) => d.info.run), [1, 2, 3, 4]);
    assert.equal(sched.get(1)?.nextFire, T0 + 150 * MIN);
  });

  it("fires on a cron schedule", async () => {
    const { host, sched } = make();
    sched.add({ session: "a", prompt: "hourly", trigger: { kind: "cron", expr: "0 * * * *" } });
    await host.advance(3 * HOUR + MIN);
    assert.equal(host.delivered.length, 3);
  });

  it("stops after max fires and says why", async () => {
    const { host, sched } = make();
    sched.add({ session: "a", prompt: "x", trigger: every(5 * MIN), max: 2 });
    await host.advance(HOUR);
    assert.equal(host.delivered.length, 2);
    assert.deepEqual(host.ended(), [[1, "max"]]);
  });

  it("counts a gap loop's delay from when the run finished, not from when it started", async () => {
    const { host, sched } = make();
    sched.add({ session: "a", prompt: "again", trigger: { kind: "loop", gapMs: 10 * MIN } });
    await host.advance(1000);
    assert.equal(host.delivered.length, 1, "the first pass is immediate");
    assert.equal(sched.get(1)?.nextFire, undefined, "no countdown while the run is in progress");
    await host.advance(30 * MIN);
    assert.equal(host.delivered.length, 1);
    sched.runFinished("a");
    assert.equal(sched.get(1)?.nextFire, host.t + 10 * MIN);
    await host.advance(10 * MIN + 1000);
    assert.equal(host.delivered.length, 2);
  });

  it("treats a self-paced loop as one immediate run (the model schedules the next itself)", async () => {
    const { host, sched } = make();
    sched.add({ session: "a", prompt: "go", trigger: { kind: "loop" } });
    await host.advance(1000);
    assert.equal(host.delivered.length, 1);
    assert.deepEqual(sched.list(), []);
  });
});

describe("never interrupting", () => {
  it("waits while the session is busy and fires once when it frees up, dropping the missed fires", async () => {
    const { host, sched } = make();
    sched.add({ session: "a", prompt: "tick", trigger: every(10 * MIN) });
    host.busy.add("a");
    await host.advance(HOUR);
    assert.equal(host.delivered.length, 0);
    host.busy.delete("a");
    sched.poke();
    await host.advance(1000);
    assert.equal(host.delivered.length, 1);
    assert.ok((host.delivered[0]?.info.lateBy ?? 0) >= 49 * MIN, "flagged as late");
    assert.equal(sched.get(1)?.nextFire, T0 + 70 * MIN, "back on the grid, nothing stacked up");
  });

  it("notices a freed session on its own poll, without a nudge", async () => {
    const { host, sched } = make();
    sched.add({ session: "a", prompt: "x", trigger: { kind: "once", at: T0 + MIN } });
    host.busy.add("a");
    await host.advance(5 * MIN);
    host.busy.delete("a");
    await host.advance(10_000);
    assert.equal(host.delivered.length, 1);
  });

  it("does not hold one session's schedules back for another's busy state", async () => {
    const { host, sched } = make();
    sched.add({ session: "a", prompt: "A", trigger: { kind: "once", at: T0 + MIN } });
    sched.add({ session: "b", prompt: "B", trigger: { kind: "once", at: T0 + MIN } });
    host.busy.add("a");
    await host.advance(2 * MIN);
    assert.deepEqual(host.delivered.map((d) => d.schedule.prompt), ["B"]);
  });
});

describe("expiry and limits", () => {
  it("expires recurring schedules after 7 days by default, with an event", async () => {
    const { host, sched } = make();
    const s = sched.add({ session: "a", prompt: "x", trigger: every(HOUR * 24) });
    assert.equal(s.expiresAt, T0 + 7 * 86_400_000);
    await host.advance(8 * 86_400_000);
    assert.deepEqual(host.ended(), [[1, "expired"]]);
    assert.equal(host.delivered.length, 6, "the 7th slot lands exactly on the expiry and does not run");
  });

  it("lets a schedule opt out of expiry or choose its own", () => {
    const { sched } = make();
    assert.equal(sched.add({ session: "a", prompt: "x", trigger: every(HOUR), expiresIn: null }).expiresAt, null);
    assert.equal(sched.add({ session: "a", prompt: "x", trigger: every(HOUR), expiresIn: 3 * HOUR }).expiresAt, T0 + 3 * HOUR);
  });

  it("does not expire a one-shot unless asked", () => {
    const { sched } = make();
    assert.equal(sched.add({ session: "a", prompt: "x", trigger: { kind: "once", at: T0 + 30 * 86_400_000 } }).expiresAt, null);
  });

  it("refuses intervals under the minimum and sessions over the cap", () => {
    const { sched } = make({ ...DEFAULT_LIMITS, perSession: 2, agentPerSession: 1 });
    assert.throws(() => sched.add({ session: "a", prompt: "x", trigger: every(10_000) }), /shortest repeat interval/);
    sched.add({ session: "a", prompt: "1", trigger: every(HOUR) });
    sched.add({ session: "a", prompt: "2", trigger: every(HOUR) });
    assert.throws(() => sched.add({ session: "a", prompt: "3", trigger: every(HOUR) }), /already has 2/);
    sched.add({ session: "a", prompt: "agent", trigger: every(HOUR), by: "agent" });
    assert.throws(() => sched.add({ session: "a", prompt: "agent2", trigger: every(HOUR), by: "agent" }), /already has 1 agent-made/);
    sched.add({ session: "b", prompt: "other session", trigger: every(HOUR) });
  });

  it("keeps names unique within a session", () => {
    const { sched } = make();
    sched.add({ session: "a", prompt: "x", trigger: every(HOUR), name: "build" });
    assert.throws(() => sched.add({ session: "a", prompt: "y", trigger: every(HOUR), name: "build" }), /already exists/);
    sched.add({ session: "b", prompt: "y", trigger: every(HOUR), name: "build" });
  });
});

describe("managing schedules", () => {
  it("cancel removes it and announces why", async () => {
    const { host, sched } = make();
    sched.add({ session: "a", prompt: "x", trigger: every(10 * MIN) });
    sched.cancel(1);
    await host.advance(HOUR);
    assert.equal(host.delivered.length, 0);
    assert.deepEqual(host.ended(), [[1, "cancelled"]]);
    assert.throws(() => sched.cancel(1), /no schedule #1/);
  });

  it("removing a session takes all of its schedules and none of anyone else's", () => {
    const { host, sched } = make();
    sched.add({ session: "a", prompt: "1", trigger: every(HOUR) });
    sched.add({ session: "a", prompt: "2", trigger: every(HOUR) });
    sched.add({ session: "b", prompt: "3", trigger: every(HOUR) });
    assert.equal(sched.removeSession("a").length, 2);
    assert.deepEqual(sched.list().map((s) => s.session), ["b"]);
    assert.deepEqual(host.ended().map(([, why]) => why), ["session-removed", "session-removed"]);
  });

  it("pause stops firing and resume picks up the next slot", async () => {
    const { host, sched } = make();
    sched.add({ session: "a", prompt: "x", trigger: every(10 * MIN) });
    sched.pause(1);
    await host.advance(HOUR);
    assert.equal(host.delivered.length, 0);
    sched.resume(1);
    assert.equal(sched.get(1)?.nextFire, T0 + 70 * MIN);
    await host.advance(11 * MIN);
    assert.equal(host.delivered.length, 1);
  });

  it("fireNow delivers without moving the schedule, and refuses a busy session", async () => {
    const { host, sched } = make();
    sched.add({ session: "a", prompt: "x", trigger: every(HOUR) });
    await sched.fireNow(1);
    assert.equal(host.delivered.length, 1);
    assert.equal(sched.get(1)?.nextFire, T0 + HOUR);
    assert.equal(sched.get(1)?.fired, 1);
    host.busy.add("a");
    await assert.rejects(sched.fireNow(1), /busy/);
  });

  it("reports the soonest next fire for a session's active schedules", () => {
    const { sched } = make();
    sched.add({ session: "a", prompt: "1", trigger: every(2 * HOUR) });
    sched.add({ session: "a", prompt: "2", trigger: every(HOUR) });
    sched.add({ session: "b", prompt: "3", trigger: every(10 * MIN) });
    assert.equal(sched.soonest("a"), T0 + HOUR);
    sched.pause(2);
    assert.equal(sched.soonest("a"), T0 + 2 * HOUR);
    assert.equal(sched.soonest("nobody"), undefined);
  });
});

describe("failures", () => {
  it("retries a failed delivery later and pauses the schedule after repeated failures", async () => {
    const { host, sched } = make();
    sched.add({ session: "a", prompt: "x", trigger: every(10 * MIN), expiresIn: null });
    host.failWith = "cannot start the session";
    await host.advance(10 * MIN + 1000);
    assert.equal(sched.get(1)?.failures, 1);
    await host.advance(10_000);
    assert.equal(sched.get(1)?.failures, 1, "it waits before retrying");
    await host.advance(30_000);
    assert.equal(sched.get(1)?.failures, 2, "then tries again");
    await host.advance(3 * 30_000 + 1000);
    assert.equal(sched.get(1)?.state, "paused");
    assert.match(sched.get(1)?.lastError ?? "", /cannot start/);
    const last = host.events.filter((e) => e.type === "failed").at(-1);
    assert.ok(last?.type === "failed" && last.paused);
  });

  it("clears the failure count after a delivery succeeds", async () => {
    const { host, sched } = make();
    sched.add({ session: "a", prompt: "x", trigger: every(10 * MIN), expiresIn: null });
    host.failWith = "boom";
    await host.advance(11 * MIN);
    host.failWith = undefined;
    await host.advance(31_000);
    assert.equal(sched.get(1)?.failures, undefined);
  });
});

describe("shell conditions", () => {
  it("waits, without a model call or a counted run, until the --until check passes, then fires once more and finishes", async () => {
    const { host, sched } = make();
    sched.add({ session: "a", prompt: "build is up", trigger: every(MIN * 2), until: "test -f build" });
    host.verdict = "wait";
    await host.advance(10 * MIN + 1000);
    assert.equal(host.delivered.length, 0);
    assert.ok(host.checks >= 5, "checked on every slot");
    assert.equal(sched.get(1)?.fired, 0);
    host.verdict = "go";
    await host.advance(2 * MIN);
    assert.equal(host.delivered.length, 1);
    assert.deepEqual(host.ended(), [[1, "completed"]]);
  });

  it("keeps running while the --while check passes and ends quietly when it fails", async () => {
    const { host, sched } = make();
    sched.add({ session: "a", prompt: "still going", trigger: every(5 * MIN), while: "pgrep job" });
    await host.advance(11 * MIN);
    assert.equal(host.delivered.length, 2);
    host.verdict = "stop";
    await host.advance(5 * MIN);
    assert.equal(host.delivered.length, 2, "the failed check sent nothing");
    assert.deepEqual(host.ended(), [[1, "condition"]]);
  });

  it("only gates repeating schedules and allows a shorter interval for them", () => {
    const { sched } = make();
    assert.throws(() => sched.add({ session: "a", prompt: "x", trigger: { kind: "once", at: T0 + MIN }, until: "true" }), /repeating schedule/);
    assert.throws(() => sched.add({ session: "a", prompt: "x", trigger: { kind: "loop" }, while: "true" }), /repeating schedule/);
    assert.throws(() => sched.add({ session: "a", prompt: "x", trigger: every(5 * MIN), until: "a", while: "b" }), /not both/);
    assert.throws(() => sched.add({ session: "a", prompt: "x", trigger: every(5000), until: "true" }), /shortest repeat interval is 10s/);
    sched.add({ session: "a", prompt: "x", trigger: every(10_000), until: "true" });
  });
});

describe("holding back runs", () => {
  it("leaves a due schedule waiting, saying why once, while the budget guard objects, then runs it late", async () => {
    const { host, sched } = make();
    sched.add({ session: "a", prompt: "x", trigger: every(10 * MIN) });
    host.budgetReason = "zai 5h usage is 97%";
    await host.advance(HOUR);
    assert.equal(host.delivered.length, 0);
    assert.equal(sched.heldReason(1), "zai 5h usage is 97%");
    assert.equal(host.events.filter((e) => e.type === "held").length, 1, "said once, not every poll");
    host.budgetReason = undefined;
    await host.advance(10_000);
    assert.equal(host.delivered.length, 1);
    assert.equal(sched.heldReason(1), undefined);
  });

  it("stops after the daily number of scheduled runs and resumes as old ones age out", async () => {
    const { host, sched } = make({ ...DEFAULT_LIMITS, dailyFires: 3 });
    sched.add({ session: "a", prompt: "x", trigger: every(MIN), expiresIn: null });
    await host.advance(10 * MIN);
    assert.equal(host.delivered.length, 3);
    assert.match(sched.heldReason(1) ?? "", /limit of 3 scheduled runs per 24 hours/);
    await host.advance(24 * HOUR + 5 * MIN);
    assert.ok(host.delivered.length > 3, "runs again once the oldest runs are a day old");
  });

  it("counts every session's runs together and keeps the count across a restart", async () => {
    const first = make({ ...DEFAULT_LIMITS, dailyFires: 2 });
    first.sched.add({ session: "a", prompt: "x", trigger: { kind: "once", at: T0 + MIN } });
    first.sched.add({ session: "b", prompt: "y", trigger: { kind: "once", at: T0 + MIN } });
    await first.host.advance(2 * MIN);
    assert.equal(first.host.delivered.length, 2);
    first.sched.stop();
    const host = new FakeHost();
    host.t = T0 + 3 * MIN;
    const sched = new Scheduler(host, file, { ...DEFAULT_LIMITS, dailyFires: 2 });
    sched.start();
    sched.add({ session: "c", prompt: "z", trigger: { kind: "once", at: T0 + 4 * MIN } });
    await host.advance(5 * MIN);
    assert.equal(host.delivered.length, 0, "the two earlier runs still count");
  });
});

describe("persistence and restarts", () => {
  it("reloads schedules, ids and counters from the file", async () => {
    const first = make();
    first.sched.add({ session: "a", prompt: "x", trigger: every(HOUR), name: "n" });
    await first.host.advance(HOUR + 1000);
    first.sched.stop();
    const second = make();
    assert.equal(second.sched.list().length, 1);
    assert.equal(second.sched.get(1)?.fired, 1);
    assert.equal(second.sched.add({ session: "a", prompt: "y", trigger: every(HOUR) }).id, 2, "ids are never reused");
  });

  it("fires once, flagged late, for what came due while the daemon was down", async () => {
    const first = make();
    first.sched.add({ session: "a", prompt: "x", trigger: every(HOUR), expiresIn: null });
    first.sched.stop();
    const host = new FakeHost();
    host.t = T0 + 5 * HOUR + 10 * MIN;
    const sched = new Scheduler(host, file);
    sched.start();
    await host.advance(1000);
    assert.equal(host.delivered.length, 1, "one catch-up fire, not five");
    assert.ok((host.delivered[0]?.info.lateBy ?? 0) > 4 * HOUR);
    assert.equal(sched.get(1)?.nextFire, T0 + 6 * HOUR);
  });

  it("skips missed fires when the schedule says catchup skip", async () => {
    const first = make();
    first.sched.add({ session: "a", prompt: "x", trigger: every(HOUR), catchup: "skip", expiresIn: null });
    first.sched.stop();
    const host = new FakeHost();
    host.t = T0 + 5 * HOUR + 10 * MIN;
    const sched = new Scheduler(host, file);
    sched.start();
    await host.advance(1000);
    assert.equal(host.delivered.length, 0);
    assert.equal(sched.get(1)?.nextFire, T0 + 6 * HOUR);
  });

  it("always fires a missed one-shot, even with catchup skip", async () => {
    const first = make();
    first.sched.add({ session: "a", prompt: "x", trigger: { kind: "once", at: T0 + HOUR }, catchup: "skip" });
    first.sched.stop();
    const host = new FakeHost();
    host.t = T0 + 3 * HOUR;
    new Scheduler(host, file).start();
    await host.advance(1000);
    assert.equal(host.delivered.length, 1);
  });

  it("restarts a gap loop whose run was cut off by the restart", async () => {
    const first = make();
    first.sched.add({ session: "a", prompt: "x", trigger: { kind: "loop", gapMs: 10 * MIN } });
    await first.host.advance(1000);
    first.sched.stop();
    const host = new FakeHost();
    host.t = T0 + 2 * MIN;
    const sched = new Scheduler(host, file);
    sched.start();
    await host.advance(1000);
    assert.equal(host.delivered.length, 1);
  });

  it("starts empty when the file is missing or corrupt", () => {
    fs.writeFileSync(file, "{not json");
    assert.deepEqual(make().sched.list(), []);
  });
});
