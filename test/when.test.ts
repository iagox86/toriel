import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeTrigger, fmtClock, fmtDuration, fmtNext, nextFire, parseWhen, type ParsedWhen, type WhenMode } from "../src/when.ts";

// Saturday 2026-10-31 14:07 local time; every expectation below is built from local-time constructors.
const NOW = new Date(2026, 9, 31, 14, 7, 0, 0);
const at = (y: number, mo: number, d: number, h: number, m = 0) => new Date(y, mo - 1, d, h, m).getTime();

function ok(input: string, mode: WhenMode = "auto", now: Date = NOW): ParsedWhen {
  const r = parseWhen(input.split(" "), now, mode);
  assert.ok(r.ok, r.ok ? "" : r.error);
  return r;
}
function error(input: string, mode: WhenMode = "auto"): string {
  const r = parseWhen(input.split(" "), NOW, mode);
  assert.ok(!r.ok, "expected an error");
  return r.ok ? "" : r.error;
}

describe("delays", () => {
  it("reads compact, spaced and 'in' forms as one-shots after the delay", () => {
    for (const spec of ["90m", "1h30m", "in 90m", "90 minutes", "1.5h"]) {
      const r = ok(spec, "in");
      assert.deepEqual(r.trigger, { kind: "once", at: NOW.getTime() + 90 * 60_000 }, spec);
      assert.deepEqual(r.rest, []);
    }
  });

  it("leaves the words after the spec as the prompt", () => {
    const r = ok("2 hours check the build", "in");
    assert.deepEqual(r.rest, ["check", "the", "build"]);
    assert.equal(r.first, NOW.getTime() + 2 * 3_600_000);
  });

  it("refuses a zero delay and points /in at a delay, not a clock time", () => {
    assert.match(error("0m", "in"), /more than zero/);
    assert.match(error("14:30", "in"), /use \/at/);
  });
});

describe("clock times", () => {
  it("reads 24-hour, am/pm and named times for later today", () => {
    assert.equal(ok("14:30", "at").first, at(2026, 10, 31, 14, 30));
    assert.equal(ok("at 3pm", "at").first, at(2026, 10, 31, 15));
    assert.equal(ok("11:59pm", "at").first, at(2026, 10, 31, 23, 59));
    assert.equal(ok("midnight", "at").first, at(2026, 11, 1, 0));
  });

  it("rolls a time that has passed to tomorrow and says so", () => {
    const r = ok("9am", "at");
    assert.equal(r.first, at(2026, 11, 1, 9));
    assert.match(r.notes.join(), /already passed today, so this is tomorrow/);
  });

  it("refuses 'today' for a time that has passed, suggesting tomorrow", () => {
    assert.match(error("today 9am", "at"), /try "tomorrow 09:00"/);
  });

  it("reads tomorrow, weekdays and dates", () => {
    assert.equal(ok("tomorrow 9am", "at").first, at(2026, 11, 1, 9));
    assert.equal(ok("at monday 09:00", "at").first, at(2026, 11, 2, 9));
    assert.equal(ok("fri at 5:30pm", "at").first, at(2026, 11, 6, 17, 30));
    assert.equal(ok("2026-12-25 08:00", "at").first, at(2026, 12, 25, 8));
  });

  it("sends a weekday that is today to next week once its time has passed, and to later today before it", () => {
    assert.equal(ok("sat 9am", "at").first, at(2026, 11, 7, 9));
    assert.equal(ok("sat 5pm", "at").first, at(2026, 10, 31, 17));
  });

  it("refuses an ambiguous bare hour with concrete alternatives", () => {
    const e = error("5", "at");
    assert.match(e, /ambiguous/);
    assert.match(e, /5:00/);
    assert.match(e, /5pm/);
  });

  it("refuses impossible times and a day with no time", () => {
    assert.match(error("25:00", "at"), /hours go to 23/);
    assert.match(error("12:75", "at"), /minutes go to 59/);
    assert.match(error("13pm", "at"), /1-12/);
    assert.match(error("tomorrow", "at"), /needs a time/);
    assert.match(error("2020-01-01 09:00", "at"), /in the past/);
  });

  it("lands on the right wall-clock hour across a DST change", () => {
    const eve = new Date(2026, 10, 1, 0, 30); // US clocks go back at 02:00 on 2026-11-01
    const r = ok("9am", "at", eve);
    assert.equal(r.first, at(2026, 11, 1, 9));
    assert.equal(new Date(r.first).getHours(), 9);
  });
});

describe("repeats", () => {
  it("anchors a fixed interval at creation, first firing one period later", () => {
    const r = ok("every 30m", "every");
    assert.deepEqual(r.trigger, { kind: "every", ms: 30 * 60_000, anchor: NOW.getTime() });
    assert.equal(r.first, NOW.getTime() + 30 * 60_000);
  });

  it("accepts the interval with or without the word 'every', and bare unit words", () => {
    assert.deepEqual(ok("2h", "every").trigger, ok("every 2h", "every").trigger);
    assert.deepEqual(ok("hour", "every").trigger, { kind: "every", ms: 3_600_000, anchor: NOW.getTime() });
  });

  it("turns named cadences into cron expressions", () => {
    assert.deepEqual(ok("weekday 9am", "every").trigger, { kind: "cron", expr: "0 9 * * 1-5" });
    assert.deepEqual(ok("every day at 6:30pm", "every").trigger, { kind: "cron", expr: "30 18 * * *" });
    assert.deepEqual(ok("mondays 08:15", "every").trigger, { kind: "cron", expr: "15 8 * * 1" });
    assert.deepEqual(ok("weekend noon", "every").trigger, { kind: "cron", expr: "0 12 * * 0,6" });
  });

  it("computes the first fire of a cadence from the clock", () => {
    assert.equal(ok("weekday 9am", "every").first, at(2026, 11, 2, 9)); // Saturday -> Monday
  });

  it("keeps the prompt after a cadence and asks for the missing time", () => {
    assert.deepEqual(ok("weekday 9am run the tests", "every").rest, ["run", "the", "tests"]);
    assert.match(error("weekday", "every"), /needs a time of day/);
    assert.match(error("soon", "every"), /cannot read "soon"/);
  });
});

describe("cron", () => {
  it("accepts a five-field expression, quoted as one word or split", () => {
    const quoted = parseWhen(["*/15 * * * *", "ping"], NOW, "cron");
    assert.ok(quoted.ok);
    assert.deepEqual(quoted.ok && quoted.trigger, { kind: "cron", expr: "*/15 * * * *" });
    assert.deepEqual(quoted.ok && quoted.rest, ["ping"]);
    assert.equal(quoted.ok && quoted.first, at(2026, 10, 31, 14, 15));
    assert.deepEqual(ok("0 9 * * 1-5 standup", "cron").rest, ["standup"]);
  });

  it("explains a bad expression instead of throwing", () => {
    assert.match(error("61 * * * *", "cron"), /not a valid cron expression/);
    assert.match(error("* * *", "cron"), /five fields/);
  });
});

describe("loops", () => {
  it("takes an optional gap; without one the model paces itself and the first run is immediate", () => {
    assert.deepEqual(ok("5m check it", "loop").trigger, { kind: "loop", gapMs: 300_000 });
    const free = ok("check it", "loop");
    assert.deepEqual(free.trigger, { kind: "loop" });
    assert.deepEqual(free.rest, ["check", "it"]);
    assert.equal(free.first, NOW.getTime());
  });
});

describe("auto mode (the agent tool's single string)", () => {
  it("works out the shape from the words", () => {
    assert.equal(ok("in 10m").trigger.kind, "once");
    assert.equal(ok("10m").trigger.kind, "once");
    assert.equal(ok("at 15:00").trigger.kind, "once");
    assert.equal(ok("tomorrow 9am").trigger.kind, "once");
    assert.equal(ok("every 2h").trigger.kind, "every");
    assert.equal(ok("every weekday 9am").trigger.kind, "cron");
    assert.equal(ok("*/5 * * * *").trigger.kind, "cron");
  });

  it("gives guidance that names the accepted shapes when it cannot tell", () => {
    assert.match(error("whenever"), /cannot read "whenever"/);
    assert.match(error("whenever"), /every weekday 9am/);
  });
});

describe("nextFire", () => {
  it("returns a one-shot only while it is still ahead", () => {
    assert.equal(nextFire({ kind: "once", at: 100 }, 50), 100);
    assert.equal(nextFire({ kind: "once", at: 100 }, 100), undefined);
  });

  it("keeps a fixed interval on its grid however late the last run was", () => {
    const t = { kind: "every", ms: 1000, anchor: 0 } as const;
    assert.equal(nextFire(t, 0), 1000);
    assert.equal(nextFire(t, 1000), 2000);
    assert.equal(nextFire(t, 2500), 3000);
  });

  it("starts a loop's gap from when the run finished, and has no answer for a self-paced one", () => {
    assert.equal(nextFire({ kind: "loop", gapMs: 5000 }, 1000), 6000);
    assert.equal(nextFire({ kind: "loop" }, 1000), undefined);
  });

  it("asks cron for the next match after the given time", () => {
    assert.equal(nextFire({ kind: "cron", expr: "0 * * * *" }, at(2026, 10, 31, 14, 7)), at(2026, 10, 31, 15));
  });
});

describe("formatting", () => {
  it("prints durations in the form the parser reads back", () => {
    for (const ms of [30_000, 90 * 60_000, 2 * 86_400_000, 3_723_000]) {
      assert.equal(parseWhen([fmtDuration(ms)], NOW, "in").ok && (ok(fmtDuration(ms), "in").trigger as { at: number }).at - NOW.getTime(), ms);
    }
    assert.equal(fmtDuration(90 * 60_000), "1h30m");
  });

  it("shows just enough date to be unambiguous", () => {
    assert.equal(fmtClock(at(2026, 10, 31, 15), NOW), "15:00");
    assert.equal(fmtClock(at(2026, 11, 1, 9), NOW), "tomorrow 09:00");
    assert.equal(fmtClock(at(2026, 11, 4, 9), NOW), "Wed 09:00");
    assert.equal(fmtClock(at(2026, 12, 25, 8), NOW), "Dec 25 08:00");
    assert.equal(fmtNext(at(2026, 10, 31, 14, 19), NOW), "14:19 (in 12m)");
  });

  it("describes each kind of trigger", () => {
    assert.equal(describeTrigger({ kind: "every", ms: 1_800_000, anchor: 0 }, NOW), "every 30m");
    assert.equal(describeTrigger({ kind: "loop" }, NOW), "loop, self-paced");
    assert.equal(describeTrigger({ kind: "loop", gapMs: 300_000 }, NOW), "loop, 5m after each run");
    assert.equal(describeTrigger({ kind: "cron", expr: "0 9 * * 1-5" }, NOW), "cron 0 9 * * 1-5");
  });
});
