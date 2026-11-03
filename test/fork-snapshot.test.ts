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
const result = (id: string) => line({ type: "message", message: { role: "toolResult", toolCallId: id, content: [] } });
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
    assert.equal(fs.readFileSync(file, "utf8"), user("hi") + call("a"), "the session file itself is not touched");
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
