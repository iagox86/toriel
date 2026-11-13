import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { RpcClient } from "@earendil-works/pi-coding-agent";
import { cleanName, DaemonNaming, type NamingOptions } from "../src/daemon-naming.ts";
import { type DaemonSession, SessionRegistry } from "../src/daemon-session.ts";
import type { ClientHub } from "../src/daemon-hub.ts";
import { renameNotice, uniqueName } from "../src/session-id.ts";

/** A pi child that reports what it was told, optionally late, never, or only after a few calls. */
function fakeChild(opts: { dropFirst?: number; failSets?: number; hang?: boolean; initial?: string } = {}) {
  const calls = { set: [] as string[], state: 0 };
  let reported = opts.initial;
  let writes = 0;
  const child = {
    async setSessionName(name: string) {
      calls.set.push(name);
      if (opts.hang) {
        return new Promise<void>(() => {});
      }
      if (calls.set.length <= (opts.failSets ?? 0)) {
        throw new Error("rejected");
      }
      writes++;
      if (writes > (opts.dropFirst ?? 0)) {
        reported = name;
      }
    },
    async getState() {
      calls.state++;
      return { sessionName: reported };
    },
  };
  return { child: child as unknown as RpcClient, calls, report: () => reported };
}

function setup(over: NamingOptions = {}) {
  const registry = new SessionRegistry();
  const broadcasts = { n: 0 };
  const hub = { broadcastSessions: () => void broadcasts.n++ } as unknown as ClientHub;
  const sleeps: number[] = [];
  const clock = { now: 1_000_000 };
  const naming = new DaemonNaming(registry, hub, { sleep: async (ms) => void sleeps.push(ms), now: () => clock.now, ...over });
  const session = (name?: string): DaemonSession => {
    const s = registry.create("/tmp");
    s.sessionName = name;
    return s;
  };
  return { registry, naming, sleeps, clock, broadcasts, session };
}

describe("cleanName", () => {
  it("makes one trimmed line, caps it, and refuses an empty name", () => {
    assert.equal(cleanName("  a \n b\t c  "), "a b c");
    assert.equal(cleanName("x".repeat(500)).length, 120);
    assert.throws(() => cleanName("  \n "), /name is empty/);
  });
});

describe("claim", () => {
  it("is unique across every session, active or not, ignoring case", () => {
    const t = setup();
    t.session("Alpha");
    const inactive = t.session();
    inactive.wantedName = "Beta";
    const s = t.session();
    assert.equal(t.naming.claim(s, "alpha", { source: "user" }), "alpha #2");
    assert.equal(t.naming.claim(s, "beta", { source: "user" }), "beta #2");
    assert.equal(t.naming.claim(s, "Gamma", { source: "user" }), "Gamma");
  });

  it("does not count a session's own name against it, so renaming to the same name is a no-op", () => {
    const t = setup();
    const s = t.session("Same");
    assert.equal(t.naming.claim(s, "Same", { source: "user" }), "Same");
    assert.equal(s.nameSource, "user");
  });

  it("gives two simultaneous requests for one name different names, with no await between choosing and recording", () => {
    const t = setup();
    const a = t.session();
    const b = t.session();
    assert.deepEqual([t.naming.claim(a, "X", { source: "fork" }), t.naming.claim(b, "X", { source: "fork" })], ["X", "X #2"]);
  });

  it("keeps the fork glyph, and lets a user's name outrank the auto-namer's", () => {
    const t = setup();
    const a = t.session();
    assert.equal(t.naming.claim(a, "⑂ Parent", { source: "fork" }), "⑂ Parent");
    const b = t.session();
    assert.equal(t.naming.claim(b, "⑂ Parent", { source: "fork" }), "⑂ Parent #2");
    const c = t.session();
    t.naming.claim(c, "Mine", { source: "user" });
    assert.equal(t.naming.claim(c, "Auto name", { source: "auto" }), undefined, "an auto name after a user's is dropped");
    assert.equal(c.wantedName, "Mine");
  });

  it("with ifUnset only names a session nobody has named", () => {
    const t = setup();
    assert.equal(t.naming.claim(t.session(), "First", { source: "auto", ifUnset: true }), "First");
    assert.equal(t.naming.claim(t.session("Has one"), "Auto", { source: "auto", ifUnset: true }), undefined);
    const claimed = t.session();
    t.naming.claim(claimed, "Claimed", { source: "spawn" });
    assert.equal(t.naming.claim(claimed, "Auto", { source: "auto", ifUnset: true }), undefined);
  });

  it("release gives the name back", () => {
    const t = setup();
    const a = t.session();
    t.naming.claim(a, "X", { source: "user" });
    t.naming.release(a);
    assert.equal(t.naming.claim(t.session(), "X", { source: "user" }), "X");
  });
});

describe("apply with a child", () => {
  it("verifies on the first try with one set and one state read, and publishes", async () => {
    const t = setup();
    const s = t.session();
    const c = fakeChild();
    s.child = c.child;
    t.naming.claim(s, "Name", { source: "user" });
    assert.deepEqual(await t.naming.apply(s), { name: "Name", verified: true });
    assert.deepEqual([c.calls.set, c.calls.state], [["Name"], 1]);
    assert.equal(s.sessionName, "Name");
    assert.equal(t.broadcasts.n, 1);
  });

  it("sets again when pi does not report it, and gives up after three tries without throwing", async () => {
    const t = setup();
    const s = t.session();
    const late = fakeChild({ dropFirst: 2, initial: "Parent" });
    s.child = late.child;
    t.naming.claim(s, "Fork", { source: "fork" });
    assert.deepEqual(await t.naming.apply(s), { name: "Fork", verified: true });
    assert.equal(late.calls.set.length, 3);
    assert.deepEqual(t.sleeps, [100, 300]);

    const stuck = t.session();
    const never = fakeChild({ dropFirst: 99, initial: "Parent" });
    stuck.child = never.child;
    t.naming.claim(stuck, "Fork 2", { source: "fork" });
    assert.deepEqual(await t.naming.apply(stuck), { name: "Fork 2", verified: false });
    assert.equal(never.calls.set.length, 3);
    assert.equal(stuck.wantedName, "Fork 2", "still wanted, so the refresh guard keeps asserting it");
    assert.equal(stuck.sessionName, "Fork 2", "and the registry shows it, never the parent's");
  });

  it("treats a rejected or unanswered request as a failed attempt, not an error", async () => {
    const t = setup({ rpcTimeoutMs: 15 });
    const rejected = t.session();
    rejected.child = fakeChild({ failSets: 2 }).child;
    t.naming.claim(rejected, "R", { source: "user" });
    assert.equal((await t.naming.apply(rejected)).verified, true, "the third attempt took");
    const hung = t.session();
    hung.child = fakeChild({ hang: true }).child;
    t.naming.claim(hung, "H", { source: "user" });
    assert.deepEqual(await t.naming.apply(hung), { name: "H", verified: false });
  });

  it("needs a claim first", async () => {
    const t = setup();
    await assert.rejects(t.naming.apply(t.session()), /no name was claimed/);
  });
});

describe("apply without a child", () => {
  const sessionFile = (dir: string) => {
    const file = path.join(dir, "s.jsonl");
    fs.writeFileSync(
      file,
      `${[
        JSON.stringify({ type: "session", version: 3, id: "11111111-1111-4111-8111-111111111111", timestamp: new Date().toISOString(), cwd: dir }),
        JSON.stringify({ type: "message", id: "a1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "hi", timestamp: Date.now() } }),
      ].join("\n")}\n`,
    );
    return file;
  };

  it("writes the name into the session file and reads it back", async () => {
    const t = setup();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-naming-"));
    const s = t.session();
    s.sessionFile = sessionFile(dir);
    t.naming.claim(s, "On disk", { source: "user" });
    assert.deepEqual(await t.naming.apply(s), { name: "On disk", verified: true });
    assert.match(fs.readFileSync(s.sessionFile, "utf8"), /"type":"session_info"[^\n]*"name":"On disk"/);
  });

  it("is a real error when there is no file, and the claim is given back", async () => {
    const t = setup();
    const s = t.session();
    t.naming.claim(s, "Nowhere", { source: "user" });
    await assert.rejects(t.naming.apply(s), /no file/);
    assert.equal(s.wantedName, undefined);
  });

  it("renames a bare file, unique against the registry", () => {
    const t = setup();
    t.session("Taken");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-naming-"));
    assert.equal(t.naming.renameFile(sessionFile(dir), "Taken"), "Taken #2");
  });
});

describe("noteObserved", () => {
  const driftSession = (t: ReturnType<typeof setup>, over: Parameters<typeof fakeChild>[0] = {}) => {
    const s = t.session();
    const c = fakeChild({ dropFirst: 99, ...over });
    s.child = c.child;
    t.naming.claim(s, "Wanted", { source: "user" });
    return { s, c };
  };

  it("does nothing when the names match, or when no name was wanted", () => {
    const t = setup();
    const { s, c } = driftSession(t);
    t.naming.noteObserved(s, "Wanted");
    t.naming.noteObserved(t.session(), "anything");
    assert.deepEqual(c.calls.set, []);
  });

  it("sets the name again when pi reports another, at most once per 30 seconds", () => {
    const t = setup();
    const { s, c } = driftSession(t);
    t.naming.noteObserved(s, "Parent");
    t.naming.noteObserved(s, "Parent");
    assert.equal(c.calls.set.length, 1);
    t.clock.now += 29_000;
    t.naming.noteObserved(s, "Parent");
    assert.equal(c.calls.set.length, 1);
    t.clock.now += 2_000;
    t.naming.noteObserved(s, "Parent");
    assert.equal(c.calls.set.length, 2);
  });

  it("gives up after five in a row, and starts again once the name converges", () => {
    const t = setup();
    const { s, c } = driftSession(t);
    for (let i = 0; i < 8; i++) {
      t.naming.noteObserved(s, "Parent");
      t.clock.now += 31_000;
    }
    assert.equal(c.calls.set.length, 5);
    assert.equal(s.nameGaveUp, true);
    t.naming.noteObserved(s, "Wanted");
    assert.deepEqual([s.nameAsserts, s.nameGaveUp], [0, false]);
    t.naming.noteObserved(s, "Parent");
    assert.equal(c.calls.set.length, 6);
  });

  it("stays out of the way of a start or a write being verified", async () => {
    const t = setup();
    const { s, c } = driftSession(t);
    s.spawning = true;
    t.naming.noteObserved(s, "Parent");
    s.spawning = false;
    assert.equal(c.calls.set.length, 0);
    const during = t.naming.apply(s);
    const own = c.calls.set.length; // the verify loop's own first write, made synchronously
    t.naming.noteObserved(s, "Parent");
    assert.equal(c.calls.set.length, own, "the verify loop is writing; a refresh must not write too");
    await during;
  });

  it("does not wait a second time once a claim is set again by the user", () => {
    const t = setup();
    const { s, c } = driftSession(t);
    t.naming.noteObserved(s, "Parent");
    t.naming.claim(s, "Renamed", { source: "user" });
    t.naming.noteObserved(s, "Parent");
    assert.deepEqual(c.calls.set, ["Wanted", "Renamed"], "a new claim starts the budget over");
  });
});

describe("uniqueName edge", () => {
  it("replaces a trailing #N the user typed (known; parked in docs/design.md)", () => {
    assert.equal(uniqueName("Task #5", ["Task #5"]), "Task #2");
  });
});

describe("renameNotice", () => {
  it("says what was applied, that it was taken, and that pi has not confirmed it", () => {
    assert.equal(renameNotice("A", "A", true), "renamed to A");
    assert.equal(renameNotice("A", "A #2", undefined), "renamed to A #2 (A is taken)");
    assert.match(renameNotice("A", "A", false), /renamed to A - pi has not confirmed it yet/);
  });
});
