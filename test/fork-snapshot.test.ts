import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { forkSnapshot, settledPrefix } from "../src/fork-snapshot.ts";
import { GrantStore } from "../src/permissions.ts";

const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const user = (text: string) => line({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const call = (...ids: string[]) => line({ type: "message", message: { role: "assistant", content: ids.map((id) => ({ type: "toolCall", id, name: "bash", arguments: {} })) } });
const result = (id: string, entryId?: string) => entryId === undefined ? line({ type: "message", message: { role: "toolResult", toolCallId: id, content: [] } }) : withResultId(entryId, line({ type: "message", message: { role: "toolResult", toolCallId: id, content: [] } }));
const withId = (id: string, l: string) => l.replace('{"type":"message"', `{"type":"message","id":"${id}"`);
const edit = (targetId: string, replacement: unknown) => line({ type: "context_edit", id: `e-${targetId}`, targetId, replacement });
const withResultId = (id: string, l: string) => l.replace('{"type":"message"', `{"type":"message","id":"${id}"`);
const answer = line({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }] } });

describe("settledPrefix", () => {
  it("keeps a settled session whole", () => {
    const text = user("hi") + call("a") + result("a") + answer;
    assert.deepEqual(settledPrefix(text), { text, dropped: 0 });
  });

  it("cuts back to before a tool call that has no result yet", () => {
    const done = user("hi") + call("a") + result("a");
    const r = settledPrefix(done + call("b"));
    assert.equal(r.text, done);
    assert.equal(r.dropped, 1);
  });

  it("waits for every call of a parallel batch, and drops what came after the first gap", () => {
    const done = user("hi");
    const r = settledPrefix(done + call("a", "b") + result("a") + user("queued"));
    assert.equal(r.text, done);
    assert.equal(r.dropped, 3);
  });

  describe("context_edit (pi's compaction machinery, ticket 210)", () => {


    it("does not wait for the result of a call whose entry was removed, and keeps the long tail", () => {
      const text = user("hi") + withId("A", call("a")) + edit("A", null) + user("later") + call("b") + result("b") + answer;
      assert.deepEqual(settledPrefix(text), { text, dropped: 0 });
    });

    it("still cuts at a call that really is unanswered after such an edit", () => {
      const done = user("hi") + withId("A", call("a")) + edit("A", null) + user("later");
      const r = settledPrefix(done + call("b"));
      assert.equal(r.text, done);
      assert.equal(r.dropped, 1);
    });

    it("retires a call when the replacement no longer contains it, and keeps one it still does", () => {
      const text = user("hi") + withId("A", call("a", "b")) + edit("A", { content: [{ type: "toolCall", id: "b", name: "bash", arguments: {} }] }) + user("later");
      assert.equal(settledPrefix(text).text, user("hi"), "b is still unanswered");
      const gone = user("hi") + withId("A", call("a")) + edit("A", { content: "summary" }) + user("later");
      assert.deepEqual(settledPrefix(gone), { text: gone, dropped: 0 });
    });

    it("ignores an edit of an entry that made no calls", () => {
      const text = user("hi") + call("a") + withId("U", user("x")) + edit("U", null) + result("a");
      assert.deepEqual(settledPrefix(text), { text, dropped: 0 });
    });

    it("re-arms a call that a later edit restores after an earlier edit removed it", () => {
      const done = user("hi") + withId("A", call("a")) + edit("A", null);
      const r = settledPrefix(done + edit("A", { content: [{ type: "toolCall", id: "a", name: "bash", arguments: {} }] }) + user("later"));
      assert.equal(r.text, done, "the restored call has no result, so the copy must end before it is back in context");
      assert.equal(r.dropped, 2);
    });

    it("cuts when an edit removes the result entry but keeps the call entry", () => {
      const done = user("hi") + withId("A", call("a")) + result("a", "R");
      const r = settledPrefix(done + edit("R", null) + user("later"));
      assert.equal(r.text, done, "without its result the call is unanswered again");
      assert.equal(r.dropped, 2);
    });

    it("cuts when a replacement introduces a call the entry never made", () => {
      const done = user("hi") + withId("A", call("a")) + result("a");
      const r = settledPrefix(done + edit("A", { content: [{ type: "toolCall", id: "x", name: "bash", arguments: {} }] }) + user("later"));
      assert.equal(r.text, done, "the new call x is unanswered");
      assert.equal(r.dropped, 2);
    });

    it("retires the calls of a replacement with no content, like null does", () => {
      const text = user("hi") + withId("A", call("a")) + edit("A", {}) + user("later") + call("b") + result("b") + answer;
      assert.deepEqual(settledPrefix(text), { text, dropped: 0 });
    });
  });

  it("drops a half-written last line", () => {
    const done = user("hi") + answer;
    const r = settledPrefix(`${done}{"type":"mess`);
    assert.equal(r.text, done);
    assert.equal(r.dropped, 1);
  });
});

describe("forkSnapshot", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "toriel-snap-"));

  it("forks a settled file in place", () => {
    const dir = tmp();
    const file = path.join(dir, "s.jsonl");
    fs.writeFileSync(file, user("hi") + answer);
    const snap = forkSnapshot(file, dir);
    assert.equal(snap.path, file);
    assert.equal(snap.dropped, 0);
  });

  it("makes a trimmed copy of an unsettled file, and removes it again", () => {
    const dir = tmp();
    const file = path.join(dir, "s.jsonl");
    fs.writeFileSync(file, user("hi") + call("a"));
    const snap = forkSnapshot(file, dir);
    assert.notEqual(snap.path, file);
    assert.equal(fs.readFileSync(snap.path, "utf8"), user("hi"));
    assert.equal(snap.dropped, 1);
    assert.equal(fs.readFileSync(file, "utf8"), user("hi") + call("a"), "the session file itself is not touched");
    snap.cleanup();
    assert.equal(fs.existsSync(snap.path), false);
  });

  it("neutralizes an orphan toolResult with an appended context_edit, keeping the rest", () => {
    const dir = tmp();
    const file = path.join(dir, "s.jsonl");
    const whole = user("hi") + withId("A", call("a")) + edit("A", null) + result("a", "R") + answer;
    fs.writeFileSync(file, whole);
    const snap = forkSnapshot(file, dir);
    assert.notEqual(snap.path, file);
    // pi walks parentId from the leaf, so the result line must not be dropped from the chain; the copy
    // appends a context_edit that takes it out of the projection instead
    const neutralize = `${JSON.stringify({ type: "context_edit", id: "toriel-edit-1", parentId: "R", targetId: "R", replacement: null })}\n`;
    assert.equal(fs.readFileSync(snap.path, "utf8"), whole + neutralize);
    assert.equal(snap.dropped, 0);
    snap.cleanup();
    assert.equal(fs.existsSync(snap.path), false);
  });
});

describe("GrantStore.copySession", () => {
  const store = () => new GrantStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "toriel-grants-")), "p.json"), () => 1_000_000);

  it("copies active grants with their expiry, not saved-but-dormant ones", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-grants-"));
    const file = path.join(dir, "p.json");
    const first = new GrantStore(file, () => 1_000_000);
    first.load();
    first.add({ session: "A", surface: "bash", pattern: "old" });
    const reloaded = new GrantStore(file, () => 1_000_000);
    reloaded.load(); // everything read from the file is dormant
    reloaded.add({ session: "A", surface: "bash", pattern: "git status", expiresIn: 60_000 });
    const copies = reloaded.copySession("A", "B");
    assert.deepEqual(copies.map((g) => [g.pattern, g.expiresAt, g.session]), [["git status", 1_060_000, "B"]]);
    assert.deepEqual(reloaded.list("A").length, 2);
  });

  it("stops at the per-session limit", () => {
    const s = new GrantStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "toriel-grants-")), "p.json"), () => 1, { perSession: 1 });
    s.add({ session: "A", surface: "bash", pattern: "x" });
    s.add({ session: "B", surface: "bash", pattern: "y" });
    assert.equal(s.copySession("A", "B").length, 0);
  });

  it("does nothing for a session without grants", () => {
    assert.deepEqual(store().copySession("A", "B"), []);
  });
});
