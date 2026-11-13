// Session names through a real daemon and a fake pi that resolves names the way pi does
// (FAKE_PI_NAME_MODE in test/fixtures/fake-pi.mjs). Board 156.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { type Client, type Harness, type Msg, startDaemon } from "./helpers.ts";

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const isSettled = (m: Msg) => m.type === "event" && m.event?.type === "agent_settled";

/** Send a prompt and wait for the run that answers it (not an earlier one). */
async function say(c: Client, session: number, message: string): Promise<void> {
  const seen = c.messages.length;
  await c.request({ type: "prompt", session, message });
  await c.waitFor((m) => isSettled(m) && c.messages.indexOf(m) >= seen);
}

/** A started session that has answered once (so its file exists) and carries `name`. */
async function namedSession(h: Harness, name: string): Promise<{ c: Client; id: number; file: string; uuid: string }> {
  const c = await h.connect();
  const { sessionId } = await c.request({ type: "spawn", cwd: h.dir });
  await c.waitFor((m) => m.type === "history");
  await say(c, sessionId, "base");
  const renamed = await c.request({ type: "rename", session: sessionId, name });
  assert.equal(renamed.name, name);
  const meta = c.sessions().find((s) => s.id === sessionId) as Msg;
  return { c, id: sessionId, file: meta.sessionFile as string, uuid: meta.sessionId as string };
}

/** The names in a session file's session_info entries, oldest first. */
function fileNames(file: string): string[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Msg)
    .filter((e) => e.type === "session_info")
    .map((e) => e.name as string);
}

const meta = (c: Client, id: number): Msg | undefined => c.sessions().find((s) => s.id === id);

async function eventually(check: () => boolean, what: string, ms = 6000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("naming: a fork keeps the name it was given (board 156)", () => {
  it("ends up named, in the registry, the file and the fork record, though pi dropped the first two writes", async () => {
    // the --name flag is write 1 and the first set_session_name is write 2; pi answers both and writes neither
    harness = await startDaemon({ FAKE_PI_NAME_MODE: "ignore:2" });
    const parent = await namedSession(harness, "Parent");
    const forked = await parent.c.request({ type: "adopt", path: parent.file, cwd: harness.dir, fork: true, name: "⑂ Parent", parentName: "Parent" });
    assert.equal(forked.name, "⑂ Parent");
    assert.equal(forked.nameVerified, true);
    const fork = meta(parent.c, forked.sessionId) as Msg;
    assert.equal(fork.sessionName, "⑂ Parent");
    assert.equal(fileNames(fork.sessionFile).at(-1), "⑂ Parent", "the fork's own entry is the latest, so pi resolves it");
    const lineage = JSON.parse(fs.readFileSync(path.join(harness.dir, "data", "toriel", "lineage.json"), "utf8")) as Msg;
    assert.equal(lineage[parent.uuid].forks[0].name, "⑂ Parent", "the fork graph holds the applied name");
    assert.equal(meta(parent.c, parent.id)?.sessionName, "Parent", "the parent is untouched");
  });

  it("answers success with nameVerified false when pi will not take the name, and keeps the fork", async () => {
    harness = await startDaemon({ FAKE_PI_NAME_MODE: "ignore:50" });
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    await say(c, sessionId, "base");
    const file = meta(c, sessionId)?.sessionFile as string;
    const forked = await c.request({ type: "adopt", path: file, cwd: harness.dir, fork: true, name: "⑂ Lost" });
    assert.equal(forked.nameVerified, false);
    assert.ok(meta(c, forked.sessionId), "the fork exists");
    assert.equal(meta(c, forked.sessionId)?.sessionName, "⑂ Lost", "the registry shows the wanted name, not pi's");
  });

  it("gives two forks of one parent requested at once the names X and X #2", async () => {
    harness = await startDaemon({ FAKE_PI_NAME_MODE: "file" });
    const parent = await namedSession(harness, "Parent");
    const other = await harness.connect();
    const [a, b] = await Promise.all([
      parent.c.request({ type: "adopt", path: parent.file, cwd: harness.dir, fork: true, name: "⑂ X" }),
      other.request({ type: "adopt", path: parent.file, cwd: harness.dir, fork: true, name: "⑂ X" }),
    ]);
    assert.deepEqual([a.name, b.name].sort(), ["⑂ X", "⑂ X #2"]);
    assert.deepEqual([a.nameVerified, b.nameVerified], [true, true]);
    const lineage = JSON.parse(fs.readFileSync(path.join(harness.dir, "data", "toriel", "lineage.json"), "utf8")) as Msg;
    assert.deepEqual((lineage[parent.uuid].forks as Msg[]).map((f) => f.name).sort(), ["⑂ X", "⑂ X #2"]);
  });

  it("refuses an empty name before it registers anything", async () => {
    harness = await startDaemon({ FAKE_PI_NAME_MODE: "file" });
    const parent = await namedSession(harness, "Parent");
    const before = parent.c.sessions().length;
    await assert.rejects(parent.c.request({ type: "adopt", path: parent.file, cwd: harness.dir, fork: true, name: "   " }), /name is empty/);
    assert.equal(parent.c.sessions().length, before);
  });
});

describe("naming: rename", () => {
  it("is made unique by the daemon, and the answer says what was applied", async () => {
    harness = await startDaemon({ FAKE_PI_NAME_MODE: "file" });
    const first = await namedSession(harness, "Shared");
    const c = first.c;
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir, ready: true });
    const r = await c.request({ type: "rename", session: sessionId, name: "shared" });
    assert.deepEqual([r.name, r.nameVerified], ["shared #2", true]);
    assert.equal(meta(c, sessionId)?.sessionName, "shared #2");
    const again = await c.request({ type: "rename", session: sessionId, name: "shared #2" });
    assert.equal(again.name, "shared #2", "renaming to its own name is not a collision");
  });

  it("waits for a late write, and says so when pi never takes it", async () => {
    harness = await startDaemon({ FAKE_PI_NAME_MODE: "delay:150" });
    const slow = await namedSession(harness, "Late").catch((e: Error) => e);
    assert.ok(!(slow instanceof Error), "the delayed write landed within the retries");
    harness = await (async () => {
      await harness?.stop();
      return startDaemon({ FAKE_PI_NAME_MODE: "fail:3" });
    })();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history");
    const r = await c.request({ type: "rename", session: sessionId, name: "Stubborn" });
    assert.deepEqual([r.name, r.nameVerified], ["Stubborn", false]);
    assert.equal(meta(c, sessionId)?.sessionName, "Stubborn", "shown at once, not blocked on pi");
  });

  it("is written to the file of a session with no process, and read back", async () => {
    harness = await startDaemon({ FAKE_PI_NAME_MODE: "file" });
    const s = await namedSession(harness, "Before");
    await s.c.request({ type: "deactivate", session: s.id });
    const r = await s.c.request({ type: "rename", session: s.id, name: "After" });
    assert.deepEqual([r.name, r.nameVerified], ["After", true]);
    assert.equal(fileNames(s.file).at(-1), "After");
  });

  it("heals a name pi stopped reporting, once, and does not write when nothing drifted", async () => {
    // after a compaction pi's latest name entry can sit off the active branch, so it reports an older name
    harness = await startDaemon({ FAKE_PI_NAME_MODE: "file", FAKE_PI_COMPACT_ORPHANS_NAME: "1" });
    const s = await namedSession(harness, "Keep me");
    assert.deepEqual(fileNames(s.file), ["Keep me"]);
    await s.c.request({ type: "compact", session: s.id });
    await eventually(() => fileNames(s.file).length === 2, "the name to be asserted again");
    assert.deepEqual(fileNames(s.file), ["Keep me", "Keep me"]);
    assert.equal(meta(s.c, s.id)?.sessionName, "Keep me", "the registry never showed anything else");
    await say(s.c, s.id, "more");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(fileNames(s.file).length, 2, "converged: a refresh writes nothing");
  });
});
