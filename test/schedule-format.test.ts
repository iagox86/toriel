import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scheduleLabel, scheduleListing, scheduleStripLines } from "../src/schedule-format.ts";
import type { Schedule } from "../src/scheduler.ts";
import type { ScheduleView } from "../src/shared.ts";

const NOW = new Date(2026, 9, 31, 14, 7);
const view = (over: Partial<ScheduleView>): ScheduleView => ({
  id: 1,
  session: "11111111-2222-3333-4444-555555555555",
  prompt: "check the build",
  when: "every 30m",
  state: "active",
  next: new Date(2026, 9, 31, 14, 30).getTime(),
  fired: 0,
  expiresAt: new Date(2026, 10, 7, 14, 7).getTime(),
  by: "user",
  catchup: "once",
  ...over,
});

describe("schedule listing", () => {
  it("shows what it does, the real next run, runs so far, expiry and the prompt", () => {
    const text = scheduleListing([view({ name: "poll", fired: 2, max: 5 })], NOW, false);
    assert.equal(text, "#1 poll | every 30m | next 14:30 (in 23m) | run 2/5 | expires Nov 7 14:07\n    check the build");
  });

  it("orders soonest first and puts paused ones last", () => {
    const text = scheduleListing([view({ id: 1, next: undefined, state: "paused" }), view({ id: 2, next: NOW.getTime() + 3_600_000 }), view({ id: 3, next: NOW.getTime() + 60_000 })], NOW, false);
    assert.deepEqual(text.split("\n").filter((l) => l.startsWith("#")).map((l) => l.slice(0, 2)), ["#3", "#2", "#1"]);
    assert.match(text, /#1 \| every 30m \| paused/);
  });

  it("names the session when listing across sessions, falling back to a short id", () => {
    assert.match(scheduleListing([view({ sessionName: "Mealie" })], NOW, true), /session: Mealie/);
    assert.match(scheduleListing([view({})], NOW, true), /session: 11111111/);
  });

  it("flags failures, agent-made schedules and loops waiting on a run", () => {
    const failed = scheduleListing([view({ state: "paused", next: undefined, lastError: "cannot start the session" })], NOW, false);
    assert.match(failed, /PAUSED after repeated failures/);
    assert.match(failed, /last error: cannot start the session/);
    assert.match(scheduleListing([view({ by: "agent", expiresAt: null })], NOW, false), /never expires \| made by the agent/);
    assert.match(scheduleListing([view({ when: "loop, 5m after each run", next: undefined })], NOW, false), /waiting for the current run to finish/);
  });

  it("shows a shell condition under the prompt", () => {
    assert.match(scheduleListing([view({ until: "test -f out" })], NOW, false), /\n {4}until `test -f out` succeeds/);
    assert.match(scheduleListing([view({ while: "pgrep job" })], NOW, false), /while `pgrep job` succeeds/);
  });

  it("labels a schedule by id and name", () => {
    assert.equal(scheduleLabel(view({ id: 7 })), "#7");
    assert.equal(scheduleLabel(view({ id: 7, name: "x" })), "#7 x");
  });
});

describe("schedule strip", () => {
  const sched = (id: number, over: Partial<Schedule> = {}): Schedule => ({
    id,
    session: "s",
    prompt: "check the build",
    trigger: { kind: "every", ms: 1_800_000, anchor: 0 },
    fired: 0,
    createdAt: 0,
    expiresAt: null,
    catchup: "once",
    by: "user",
    state: "active",
    nextFire: new Date(2026, 9, 31, 14, 30).getTime() + id * 60_000,
    ...over,
  });

  it("gives a line per active schedule, soonest first, with fixed clock times", () => {
    const lines = scheduleStripLines([sched(2, { name: "poll" }), sched(1), sched(3, { state: "paused" })], NOW);
    assert.deepEqual(lines, ["scheduled: #1, every 30m, next 14:31 - check the build", "scheduled: poll, every 30m, next 14:32 - check the build"]);
  });

  it("caps at three lines and counts the rest", () => {
    const lines = scheduleStripLines([1, 2, 3, 4, 5].map((i) => sched(i)), NOW);
    assert.equal(lines.length, 4);
    assert.equal(lines[3], "+2 more (/schedules)");
  });

  it("says when a schedule is waiting on a hold or on its current run", () => {
    assert.match(scheduleStripLines([sched(1)], NOW, () => "usage 97%")[0] ?? "", /waiting: usage 97%/);
    assert.match(scheduleStripLines([sched(1, { nextFire: undefined })], NOW)[0] ?? "", /after the current run/);
  });

  it("is empty with nothing active", () => {
    assert.deepEqual(scheduleStripLines([], NOW), []);
  });
});
