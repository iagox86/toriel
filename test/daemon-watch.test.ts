// The glue between file watches and the scheduler (src/daemon-watch.ts): one live watch per active
// watch schedule, retried when it cannot start, reported rather than silently dropped.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_WATCHES, RETRY_MS, specOf, WatchManager, type WatchTimers } from "../src/daemon-watch.ts";
import type { WatchSpec } from "../src/file-watch.ts";
import type { Schedule } from "../src/scheduler.ts";

const sched = (id: number, over: Partial<Schedule> = {}): Schedule => ({
  id,
  session: "a",
  prompt: "p",
  trigger: { kind: "watch", path: `/d/f${id}`, dir: false, events: "write", cooldownMs: 2000 },
  fired: 0,
  createdAt: 0,
  expiresAt: null,
  catchup: "once",
  by: "user",
  state: "active",
  ...over,
});

function setup() {
  const schedules: Schedule[] = [];
  const triggered: number[] = [];
  const armed = new Map<number, { spec: WatchSpec; onChange: () => void; onError: (m: string) => void }>();
  const checks = new Map<number, boolean>();
  let armFails: string | undefined;
  const says: string[] = [];
  let tick: (() => void) | undefined;
  const watcher = {
    arm: (id: number, spec: WatchSpec, onChange: () => void, onError: (m: string) => void = () => {}) => {
      if (armFails !== undefined) {
        throw new Error(armFails);
      }
      armed.set(id, { spec, onChange, onError });
    },
    disarm: (id: number) => void armed.delete(id),
    has: (id: number) => armed.has(id),
    ids: () => [...armed.keys()],
    check: (id: number) => checks.get(id) ?? true,
    closeAll: () => armed.clear(),
    get size() {
      return armed.size;
    },
  };
  const timers: WatchTimers = {
    set: (fn) => {
      tick = fn;
      return "timer";
    },
    clear: () => {
      tick = undefined;
    },
  };
  const m = new WatchManager({ list: () => schedules, triggered: (id) => void triggered.push(id) }, watcher, timers, (l) => says.push(l));
  return {
    m,
    schedules,
    triggered,
    armed,
    checks,
    says,
    failArm: (why: string | undefined) => {
      armFails = why;
    },
    tick: () => tick?.(),
    hasTimer: () => tick !== undefined,
  };
}

describe("the watch manager", () => {
  it("watches each active watch schedule, and nothing else", () => {
    const t = setup();
    t.schedules.push(sched(1), sched(2, { state: "paused" }), sched(3, { trigger: { kind: "every", ms: 60_000, anchor: 0 } }));
    t.m.sync();
    assert.deepEqual([...t.armed.keys()], [1]);
    assert.deepEqual(t.armed.get(1)?.spec, { path: "/d/f1", dir: false, events: "write", cooldownMs: 2000 });
  });

  it("turns a file change into Scheduler.triggered for that schedule", () => {
    const t = setup();
    t.schedules.push(sched(7));
    t.m.sync();
    t.armed.get(7)?.onChange();
    assert.deepEqual(t.triggered, [7]);
  });

  it("stops watching a schedule that was cancelled, paused or ended, and is idempotent", () => {
    const t = setup();
    t.schedules.push(sched(1), sched(2));
    t.m.sync();
    t.m.sync();
    assert.deepEqual([...t.armed.keys()], [1, 2]);
    t.schedules.splice(0, 1);
    (t.schedules[0] as Schedule).state = "paused";
    t.m.sync();
    assert.deepEqual([...t.armed.keys()], []);
    (t.schedules[0] as Schedule).state = "active";
    t.m.sync();
    assert.deepEqual([...t.armed.keys()], [2], "resumed: watching again");
  });

  it("reports a watch that cannot start, keeps the reason, and retries until it works", () => {
    const t = setup();
    t.schedules.push(sched(1));
    t.failArm("/d does not exist");
    t.m.sync();
    assert.equal(t.m.problem(1), "/d does not exist");
    assert.equal(t.armed.size, 0);
    assert.match(t.says[0] ?? "", /file watch #1 is not watching: \/d does not exist \(retrying every 30s\)/);
    t.m.sync();
    assert.equal(t.says.length, 1, "the same problem is said once");
    t.failArm(undefined);
    t.tick(); // the periodic retry
    assert.equal(t.armed.has(1), true);
    assert.equal(t.m.problem(1), undefined);
    assert.match(t.says.at(-1) ?? "", /watching \/d\/f1 again/);
  });

  it("notices a watch whose directory went away and says so", () => {
    const t = setup();
    t.schedules.push(sched(1));
    t.m.sync();
    t.checks.set(1, false);
    t.failArm("/d does not exist"); // the retry in the same pass cannot re-arm either
    t.tick();
    assert.equal(t.armed.has(1), false);
    assert.equal(t.m.problem(1), "/d does not exist");
  });

  it("reports a watch that died on its own, and forgets the problem when the schedule goes", () => {
    const t = setup();
    t.schedules.push(sched(1));
    t.m.sync();
    t.failArm("limit reached");
    t.armed.get(1)?.onError("ENOSPC");
    assert.ok(t.m.problem(1));
    t.schedules.length = 0;
    t.m.sync();
    assert.equal(t.m.problem(1), undefined);
  });

  it("caps how many watches are live", () => {
    const t = setup();
    for (let i = 1; i <= MAX_WATCHES + 2; i++) {
      t.schedules.push(sched(i));
    }
    t.m.sync();
    assert.equal(t.armed.size, MAX_WATCHES);
    assert.match(t.m.problem(MAX_WATCHES + 1) ?? "", /too many file watches/);
  });

  it("runs its retry timer only while there is something to watch, and closes everything on stop", () => {
    const t = setup();
    t.m.sync();
    assert.equal(t.hasTimer(), false);
    t.schedules.push(sched(1));
    t.m.sync();
    assert.equal(t.hasTimer(), true);
    t.schedules.length = 0;
    t.m.sync();
    assert.equal(t.hasTimer(), false);
    t.schedules.push(sched(1));
    t.m.sync();
    t.m.stop();
    assert.equal(t.armed.size, 0);
    assert.equal(t.hasTimer(), false);
  });

  it("specOf is the watch a schedule asks for, only while it is active", () => {
    assert.equal(specOf(sched(1, { state: "paused" })), undefined);
    assert.equal(specOf(sched(1, { trigger: { kind: "once", at: 1 } })), undefined);
    assert.equal(specOf(sched(1))?.path, "/d/f1");
    assert.equal(RETRY_MS, 30_000);
  });
});
