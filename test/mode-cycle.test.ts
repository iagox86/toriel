import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ModeNoticeDebounce, modeOf, nextMode, switches } from "../src/mode-cycle.ts";

describe("mode cycle (ticket 233)", () => {
  it("names the mode a session is in, plan outranking auto", () => {
    assert.equal(modeOf({}), "normal");
    assert.equal(modeOf({ auto: true }), "auto");
    assert.equal(modeOf({ plan: true }), "plan");
    assert.equal(modeOf({ auto: true, plan: true }), "plan");
  });

  it("goes normal, auto, plan, normal", () => {
    assert.equal(nextMode({ sessionId: "u" }), "auto");
    assert.equal(nextMode({ sessionId: "u", auto: true }), "plan");
    assert.equal(nextMode({ sessionId: "u", plan: true }), "normal");
  });

  it("skips plan for a session with no id yet", () => {
    assert.equal(nextMode({ auto: true }), "normal");
    assert.equal(nextMode({}), "auto");
  });

  it("changes only the flags that differ, plan first", () => {
    assert.deepEqual(switches({}, "auto"), [{ flag: "auto", on: true }]);
    assert.deepEqual(switches({ auto: true }, "plan"), [
      { flag: "plan", on: true },
      { flag: "auto", on: false },
    ]);
    assert.deepEqual(switches({ plan: true }, "normal"), [{ flag: "plan", on: false }]);
    assert.deepEqual(switches({ auto: true, plan: true }, "normal"), [
      { flag: "plan", on: false },
      { flag: "auto", on: false },
    ]);
    assert.deepEqual(switches({ auto: true }, "auto"), []);
  });
});

describe("the shift+tab notice debounce (ticket 236)", () => {
  /** A clock the test moves by hand, in place of setTimeout. */
  function fakeClock() {
    let now = 0;
    let next = 1;
    const pending = new Map<number, { at: number; fn: () => void }>();
    const set = ((fn: () => void, ms: number) => {
      const id = next++;
      pending.set(id, { at: now + ms, fn });
      return Object.assign(id as unknown as NodeJS.Timeout, { unref: () => undefined });
    }) as unknown as typeof setTimeout;
    const clear = ((t: unknown) => {
      const id = Number(t);
      pending.delete(id);
    }) as unknown as typeof clearTimeout;
    const advance = (ms: number) => {
      now += ms;
      for (const [id, t] of [...pending]) {
        if (t.at <= now) {
          pending.delete(id);
          t.fn();
        }
      }
    };
    return { set, clear, advance, pending };
  }

  const make = () => {
    const clock = fakeClock();
    const said: number[] = [];
    const d = new ModeNoticeDebounce((s) => said.push(s), 700, { set: clock.set, clear: clock.clear });
    return { d, said, clock };
  };

  const toAuto = { before: "normal", after: "auto" } as const;
  const toPlan = { before: "auto", after: "plan" } as const;
  const toNormal = { before: "plan", after: "normal" } as const;

  it("announces once, for the settled mode, after a burst of presses", () => {
    const { d, said, clock } = make();
    for (let i = 0; i < 6; i++) {
      d.poke(7, toAuto);
      clock.advance(300);
    }
    assert.deepEqual(said, [], "still pressing: nothing yet");
    clock.advance(700);
    assert.deepEqual(said, [7]);
    clock.advance(5000);
    assert.deepEqual(said, [7], "and not again");
  });

  it("announces a single press after the wait, and two bursts apart twice", () => {
    const { d, said, clock } = make();
    d.poke(7, toAuto);
    clock.advance(699);
    assert.deepEqual(said, []);
    clock.advance(1);
    assert.deepEqual(said, [7]);
    d.poke(7, toAuto);
    clock.advance(700);
    assert.deepEqual(said, [7, 7]);
  });

  it("says nothing when a burst wrapped back to the mode it started in (live check: shift+tab auto -> plan -> normal -> auto)", () => {
    const { d, said, clock } = make();
    d.poke(7, toPlan);
    d.poke(7, toNormal);
    d.poke(7, { before: "normal", after: "auto" });
    clock.advance(700);
    assert.deepEqual(said, [], "the settled mode is the one the burst started in: no line");
  });

  it("still says the settled mode when a burst ends somewhere new (auto -> plan)", () => {
    const { d, said, clock } = make();
    d.poke(7, toPlan);
    d.poke(7, toPlan);
    clock.advance(700);
    assert.deepEqual(said, [7]);
  });

  it("after a wrap, a later real move announces again (the wrap does not stick)", () => {
    const { d, said, clock } = make();
    d.poke(7, toPlan);
    d.poke(7, toNormal);
    d.poke(7, { before: "normal", after: "auto" });
    clock.advance(700);
    d.poke(7, toPlan);
    clock.advance(700);
    assert.deepEqual(said, [7], "one line for the new burst");
  });

  it("announces an earlier session at once when a press lands on another, and drops everything on cancel", () => {
    const { d, said, clock } = make();
    d.poke(7, toAuto);
    d.poke(8, toAuto);
    assert.deepEqual(said, [7]);
    d.cancel();
    clock.advance(5000);
    assert.deepEqual(said, [7], "cancelled: the pending one never fires");
    assert.equal(clock.pending.size, 0, "no timer is left behind");
  });

  it("waits five seconds by default (live check: presses a little slower than the old 700 ms each printed)", () => {
    const clock = fakeClock();
    const said: number[] = [];
    const d = new ModeNoticeDebounce((s) => said.push(s), undefined, { set: clock.set, clear: clock.clear });
    d.poke(7, toPlan);
    d.poke(7, toNormal);
    d.poke(7, { before: "normal", after: "auto" });
    clock.advance(4999);
    assert.deepEqual(said, [], "a slow 1.6 s wrap still counts as one burst");
    clock.advance(1);
    assert.deepEqual(said, [], "and a full wrap still says nothing");
  });
});
