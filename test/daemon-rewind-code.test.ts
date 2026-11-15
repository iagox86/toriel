// Rewind with the code (ticket 11) through a real daemon: the journal the write/edit tools would have kept is written by hand, the
// rest (finding the target's time, putting the files back, dropping the records, the answer) is the daemon's.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { readChanges, recordAfter, recordBefore } from "../pi/extensions/lib/file-history.ts";
import { type Harness, type Msg, startDaemon } from "./helpers.ts";

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});
const isSettled = (m: Msg) => m.type === "event" && m.event?.type === "agent_settled";

/** A session with two prompts, and what a write/edit during the second one would have journaled. */
async function twoTurns() {
  harness = await startDaemon();
  const c = await harness.connect();
  const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
  await c.waitFor((m) => m.type === "history");
  await c.request({ type: "prompt", session: sessionId, message: "one" });
  await c.waitFor(isSettled);
  await c.request({ type: "prompt", session: sessionId, message: "two" });
  await c.waitFor((m) => isSettled(m) && c.messages.filter(isSettled).length >= 2);
  const file = c.sessions().find((s) => s.id === sessionId)?.sessionFile as string;
  const entries = () =>
    fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  const header = entries()[0];
  const second = entries().find((e) => e.message?.content === "two");
  const at = Date.parse(second.timestamp);
  const journal = path.join(harness.dir, "file-history", header.id as string);
  const work = path.join(harness.dir, "work");
  fs.mkdirSync(work);
  const target = path.join(work, "code.txt");
  fs.writeFileSync(target, "original\n");
  // the agent's edit during turn two
  recordBefore(journal, "call-1", "edit", target, at + 100);
  fs.writeFileSync(target, "edited\nby the agent\n");
  recordAfter(journal, "call-1", target, at + 101);
  return { c, sessionId, second, target, journal, entries, at, file };
}

describe("daemon: rewind with the code", () => {
  it("puts the files back with the conversation when asked, and drops the records", async () => {
    const t = await twoTurns();
    const r = await t.c.request({ type: "rewind", session: t.sessionId, entryId: t.second.id, code: true });
    assert.equal(r.text, "two");
    assert.deepEqual(r.code.restored, [fs.realpathSync(t.target)]);
    assert.deepEqual(r.code.left, []);
    assert.equal(fs.readFileSync(t.target, "utf8"), "original\n");
    assert.deepEqual(readChanges(t.journal), [], "the records of the cut-away conversation are gone");
    assert.equal(t.entries().some((e) => JSON.stringify(e).includes('"two"')), false);
  });

  it("leaves the files alone for a conversation-only rewind, and keeps the records", async () => {
    const t = await twoTurns();
    const r = await t.c.request({ type: "rewind", session: t.sessionId, entryId: t.second.id });
    assert.equal(r.code, undefined);
    assert.equal(fs.readFileSync(t.target, "utf8"), "edited\nby the agent\n");
    assert.equal(readChanges(t.journal).length, 1);
  });

  it("restore_code puts the files back and leaves the conversation as it is", async () => {
    const t = await twoTurns();
    const before = fs.readFileSync(t.file, "utf8");
    const r = await t.c.request({ type: "restore_code", session: t.sessionId, entryId: t.second.id });
    assert.equal(r.code.restored.length, 1);
    assert.equal(fs.readFileSync(t.target, "utf8"), "original\n");
    assert.equal(fs.readFileSync(t.file, "utf8"), before, "the session file is untouched");
    assert.equal(readChanges(t.journal).length, 1, "the records stay: the conversation they belong to does");
  });

  it("will not overwrite a file changed after the agent's last edit, and says so", async () => {
    const t = await twoTurns();
    fs.writeFileSync(t.target, "the user edited this afterwards\n");
    const r = await t.c.request({ type: "rewind", session: t.sessionId, entryId: t.second.id, code: true });
    assert.deepEqual(r.code.restored, []);
    assert.equal(r.code.left.length, 1);
    assert.equal(fs.readFileSync(t.target, "utf8"), "the user edited this afterwards\n");
  });
});
