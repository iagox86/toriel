import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import setup, { classify, learn, learnFromHistory, type Table, threshold, warningFor } from "../pi/extensions/toriel-cache-warn.ts";

const MIN = 60_000;
const T0 = 1_800_000_000_000;
const hit = { input: 500, cacheRead: 100_000 };
const miss = { input: 100_000, cacheRead: 0 };

describe("cache hit/miss classification", () => {
  it("calls mostly-cached prompts hits and uncached ones misses", () => {
    assert.equal(classify(hit), "hit");
    assert.equal(classify(miss), "miss");
  });

  it("ignores small prompts and mixed ones", () => {
    assert.equal(classify({ input: 800, cacheRead: 0 }), undefined);
    assert.equal(classify({ input: 70_000, cacheRead: 30_000 }), undefined);
  });
});

describe("learning the expiry", () => {
  it("brackets the expiry between the longest hit and the shortest miss", () => {
    const t: Table = {};
    learn(t, "p/m", 2 * MIN, hit);
    learn(t, "p/m", 4 * MIN, hit);
    learn(t, "p/m", 9 * MIN, miss);
    learn(t, "p/m", 30 * MIN, miss);
    assert.deepEqual(t["p/m"], { maxHit: 4 * MIN, minMiss: 9 * MIN });
    assert.equal(threshold(t["p/m"]), 9 * MIN);
  });

  it("does not take a quick miss as expiry, since the prefix must have changed", () => {
    const t: Table = {};
    learn(t, "p/m", 10_000, miss);
    assert.equal(threshold(t["p/m"]), undefined);
  });

  it("trusts hits over a shorter recorded miss", () => {
    assert.equal(threshold({ maxHit: 20 * MIN, minMiss: 5 * MIN }), 20 * MIN + 1);
  });

  it("learns from a replayed session history", () => {
    const msg = (timestamp: number, usage: object) => ({
      type: "message",
      message: { role: "assistant", provider: "p", model: "m", timestamp, usage },
    });
    const t: Table = {};
    const changed = learnFromHistory(t, [msg(T0, hit), msg(T0 + 3 * MIN, hit), msg(T0 + 20 * MIN, miss)]);
    assert.equal(changed, true);
    assert.deepEqual(t["p/m"], { maxHit: 3 * MIN, minMiss: 17 * MIN });
  });

  it("does not take a miss after a prompt change (loaded tools, a changed section) as expiry, on replay or live (ticket 310)", () => {
    const msg = (timestamp: number, usage: object) => ({ type: "message", message: { role: "assistant", provider: "p", model: "m", timestamp, usage } });
    const system = { type: "message", message: { role: "system" } };
    const t: Table = {};
    learnFromHistory(t, [msg(T0, hit), system, msg(T0 + 3 * MIN, miss), msg(T0 + 8 * MIN, miss)]);
    assert.deepEqual(t["p/m"], { maxHit: 0, minMiss: 5 * MIN }, "only the miss with an unchanged prompt counts");

    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "toriel-cachewarn-")), "cache-ttl.json");
    const previous = process.env.TORIEL_CACHE_TTL_FILE;
    process.env.TORIEL_CACHE_TTL_FILE = file;
    const handlers = new Map<string, (event: never, ctx: never) => unknown>();
    try {
      setup({ on: (event: string, handler: (event: never, ctx: never) => unknown) => void handlers.set(event, handler) } as never);
    } finally {
      if (previous === undefined) {
        delete process.env.TORIEL_CACHE_TTL_FILE;
      } else {
        process.env.TORIEL_CACHE_TTL_FILE = previous;
      }
    }
    const end = (message: object) => handlers.get("message_end")?.({ message } as never, {} as never);
    end(msg(T0, hit).message);
    end(system.message);
    end(msg(T0 + 3 * MIN, miss).message);
    assert.equal(fs.existsSync(file), false, "nothing learned from the miss after the change");
    end(msg(T0 + 8 * MIN, miss).message);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8"))["p/m"], { maxHit: 0, minMiss: 5 * MIN });
  });

  it("does not learn a miss after a restart whose history ends with a prompt change (session_start, ticket 310)", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "toriel-cachewarn-")), "cache-ttl.json");
    const previous = process.env.TORIEL_CACHE_TTL_FILE;
    process.env.TORIEL_CACHE_TTL_FILE = file;
    const handlers = new Map<string, (event: never, ctx: never) => unknown>();
    try {
      setup({ on: (event: string, handler: (event: never, ctx: never) => unknown) => void handlers.set(event, handler) } as never);
      const msg = (timestamp: number, usage: object) => ({ type: "message", message: { role: "assistant", provider: "p", model: "m", timestamp, usage } });
      const system = { type: "message", message: { role: "system" } };
      const start = (entries: object[]) => handlers.get("session_start")?.({} as never, { sessionManager: { getBranch: () => entries } } as never);
      const end = (message: object) => handlers.get("message_end")?.({ message } as never, {} as never);
      // the session loaded tools after its last call and was left before answering: the branch ends with the system message
      start([msg(T0, hit), system]);
      end(msg(T0 + 3 * MIN, miss).message);
      assert.equal(fs.existsSync(file), false, "nothing learned from the miss that follows the change");
      // a restart of a session whose branch ends with a call clears the flag again, and a system message before that call leaves it off
      start([system, msg(T0, hit)]);
      end(msg(T0 + 8 * MIN, miss).message);
      assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8"))["p/m"], { maxHit: 0, minMiss: 8 * MIN });
    } finally {
      if (previous === undefined) {
        delete process.env.TORIEL_CACHE_TTL_FILE;
      } else {
        process.env.TORIEL_CACHE_TTL_FILE = previous;
      }
    }
  });
});

describe("warning before sending", () => {
  const last = { role: "assistant", timestamp: T0, usage: { input: 500, cacheRead: 199_500 } };
  const learned = { maxHit: 4 * MIN, minMiss: 9 * MIN };

  it("stays quiet while the expiry is unknown", () => {
    assert.equal(warningFor(last, undefined, undefined, T0 + 60 * MIN), undefined);
  });

  it("stays quiet inside the learned window or for a small context", () => {
    assert.equal(warningFor(last, learned, undefined, T0 + 5 * MIN), undefined);
    const small = { ...last, usage: { input: 100, cacheRead: 9_000 } };
    assert.equal(warningFor(small, learned, undefined, T0 + 60 * MIN), undefined);
  });

  it("warns with the token count and the price difference", () => {
    const text = warningFor(last, learned, { input: 0.5, cacheRead: 0.1 }, T0 + 12 * MIN);
    assert.match(text ?? "", /200K tokens/);
    assert.match(text ?? "", /\$0\.08/);
  });
});
