import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import type { Schedule } from "../src/scheduler.ts";
import { AWAKE_BEFORE_FIRE_MS, needsAwake, type SpawnFn, SleepInhibitor } from "../src/sleep-inhibit.ts";

const NOW = 1_000_000_000_000;
const idle = { streaming: false, compacting: false };
const sched = (over: Partial<Schedule>): Schedule => ({
  id: 1,
  session: "s",
  prompt: "p",
  trigger: { kind: "every", ms: 60_000, anchor: 0 },
  fired: 0,
  createdAt: 0,
  expiresAt: null,
  catchup: "once",
  by: "user",
  state: "active",
  nextFire: NOW + 3_600_000,
  ...over,
});

describe("needsAwake", () => {
  it("is false for an idle fleet with nothing due soon", () => {
    assert.equal(needsAwake([idle], [sched({})], NOW), false);
    assert.equal(needsAwake([], [], NOW), false);
  });

  it("is true while any session is working or compacting", () => {
    assert.equal(needsAwake([idle, { streaming: true, compacting: false }], [], NOW), true);
    assert.equal(needsAwake([{ streaming: false, compacting: true }], [], NOW), true);
  });

  it("is true when an active schedule is due within half an hour, but not for a paused one or a far one", () => {
    assert.equal(needsAwake([idle], [sched({ nextFire: NOW + AWAKE_BEFORE_FIRE_MS - 1000 })], NOW), true);
    assert.equal(needsAwake([idle], [sched({ nextFire: NOW + AWAKE_BEFORE_FIRE_MS + 1000 })], NOW), false);
    assert.equal(needsAwake([idle], [sched({ nextFire: NOW + 1000, state: "paused" })], NOW), false);
    assert.equal(needsAwake([idle], [sched({ nextFire: NOW - 5000 })], NOW), true, "overdue still counts");
  });
});

class FakeChild extends EventEmitter {
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

function setup(opts: { platform?: NodeJS.Platform } = {}) {
  const spawned: Array<{ cmd: string; args: string[]; child: FakeChild }> = [];
  const logs: string[] = [];
  let t = NOW;
  const spawn: SpawnFn = (cmd, args) => {
    const child = new FakeChild();
    spawned.push({ cmd, args, child });
    return child as never;
  };
  const inhibitor = new SleepInhibitor({ spawn, log: (m) => void logs.push(m), ownerPid: 4242, platform: opts.platform ?? "linux", now: () => t });
  return { inhibitor, spawned, logs, tick: (ms: number) => {
      t += ms;
    },
  };
}

describe("SleepInhibitor", () => {
  it("takes one inhibitor lock when work starts, however often it is told, and drops it when work ends", () => {
    const { inhibitor, spawned, logs } = setup();
    inhibitor.update(true);
    inhibitor.update(true);
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0]?.cmd, "systemd-inhibit");
    assert.ok(spawned[0]?.args.includes("--what=idle:sleep"));
    assert.ok(spawned[0]?.args.includes("--mode=block"));
    assert.equal(inhibitor.held, true);
    inhibitor.update(false);
    assert.equal(spawned[0]?.child.killed, true);
    assert.equal(inhibitor.held, false);
    assert.equal(logs.length, 2);
    inhibitor.update(false);
    assert.equal(spawned.length, 1);
  });

  it("makes the lock end by itself when the daemon's pid disappears", () => {
    const { inhibitor, spawned } = setup();
    inhibitor.update(true);
    assert.match(spawned[0]?.args.at(-1) ?? "", /kill -0 4242/);
  });

  it("takes the lock again for later work", () => {
    const { inhibitor, spawned, tick } = setup();
    inhibitor.update(true);
    inhibitor.update(false);
    tick(60_000);
    inhibitor.update(true);
    assert.equal(spawned.length, 2);
  });

  it("restarts the lock if its process died after running a while", () => {
    const { inhibitor, spawned, tick } = setup();
    inhibitor.update(true);
    tick(60_000);
    spawned[0]?.child.emit("exit", 0);
    assert.equal(inhibitor.held, false);
    inhibitor.update(true);
    assert.equal(spawned.length, 2);
  });

  it("gives up with one log line when systemd-inhibit is missing or exits straight away", () => {
    const missing = setup();
    missing.inhibitor.update(true);
    missing.spawned[0]?.child.emit("error", new Error("spawn systemd-inhibit ENOENT"));
    missing.inhibitor.update(true);
    assert.equal(missing.spawned.length, 1);
    assert.equal(missing.logs.filter((l) => l.includes("cannot inhibit sleep")).length, 1);
    assert.match(missing.logs.join("\n"), /preventSleep/);

    const quick = setup();
    quick.inhibitor.update(true);
    quick.spawned[0]?.child.emit("exit", 1);
    quick.inhibitor.update(true);
    assert.equal(quick.spawned.length, 1);
  });

  it("does nothing off Linux, and nothing after stop", () => {
    const mac = setup({ platform: "darwin" });
    mac.inhibitor.update(true);
    assert.equal(mac.spawned.length, 0);
    const { inhibitor, spawned } = setup();
    inhibitor.update(true);
    inhibitor.stop();
    assert.equal(spawned[0]?.child.killed, true);
    inhibitor.update(true);
    assert.equal(spawned.length, 1);
  });
});
