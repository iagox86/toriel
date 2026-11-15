// File history (ticket 11): the journal the write/edit tools feed, the plan of what a rewind would undo, the restore, and the
// extension that records it.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import toriel, { sessionDir, targetOf } from "../pi/extensions/toriel-filehistory.ts";
import { applyRestore, FILE_HISTORY_ENV, journalFile, lineDiff, MAX_FILE_BYTES, planRestore, pruneFrom, readChanges, recordAfter, recordBefore } from "../pi/extensions/lib/file-history.ts";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "toriel-fh-"));

/** A session dir and a work dir, with `edit(n, content)` standing in for one write/edit call at time `ts`. */
function world() {
  const dir = path.join(tmp(), "session");
  const work = tmp();
  return {
    dir,
    work,
    file: (name: string) => path.join(work, name),
    /** What the tools do: journal the file, change it, journal the result. */
    edit(call: string, file: string, content: string | null, ts: number) {
      recordBefore(dir, call, "edit", file, ts);
      if (content === null) {
        fs.rmSync(file, { force: true });
      } else {
        fs.writeFileSync(file, content);
      }
      recordAfter(dir, call, file, ts + 1);
    },
  };
}

describe("lineDiff", () => {
  it("counts lines added and removed", () => {
    assert.deepEqual(lineDiff("a\nb\nc\n", "a\nb\nc\n"), { added: 0, removed: 0 });
    assert.deepEqual(lineDiff("a\nb\nc\n", "a\nX\nc\nd\n"), { added: 2, removed: 1 });
    assert.deepEqual(lineDiff("", "x\ny\n"), { added: 2, removed: 0 });
    assert.deepEqual(lineDiff("x\ny\n", ""), { added: 0, removed: 2 });
    assert.deepEqual(lineDiff("one\ntwo", "one\ntwo\n"), { added: 0, removed: 0 }, "a trailing newline is not a line");
  });

  it("copes with a large change without blowing up (counting every differing line once each way)", () => {
    const a = Array.from({ length: 6000 }, (_, i) => `a${i}`).join("\n");
    const b = Array.from({ length: 6000 }, (_, i) => `b${i}`).join("\n");
    assert.deepEqual(lineDiff(a, b), { added: 6000, removed: 6000 });
  });
});

describe("the journal", () => {
  it("keeps what a file held before each call and after it, oldest first, and the blobs once", () => {
    const w = world();
    const f = w.file("a.txt");
    fs.writeFileSync(f, "one\n");
    w.edit("c1", f, "two\n", 1000);
    w.edit("c2", f, "two\n", 2000);
    const changes = readChanges(w.dir);
    assert.deepEqual(
      changes.map((c) => [c.call, c.before.kind, c.after?.kind]),
      [
        ["c1", "file", "file"],
        ["c2", "file", "file"],
      ],
    );
    assert.equal(fs.readdirSync(path.join(w.dir, "blobs")).length, 2, "one blob per distinct content");
    assert.equal(fs.statSync(journalFile(w.dir)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(w.dir).mode & 0o777, 0o700);
  });

  it("records a file that did not exist as absent, and one that is too big as big (not kept)", () => {
    const w = world();
    w.edit("new", w.file("n.txt"), "hello\n", 10);
    fs.writeFileSync(w.file("big.bin"), Buffer.alloc(MAX_FILE_BYTES + 1));
    recordBefore(w.dir, "big", "write", w.file("big.bin"), 20);
    const [a, b] = readChanges(w.dir);
    assert.equal(a?.before.kind, "absent");
    assert.equal(b?.before.kind, "big");
    assert.equal(fs.existsSync(path.join(w.dir, "blobs", "big")), false);
  });

  it("skips a directory, and a torn line in the journal", () => {
    const w = world();
    recordBefore(w.dir, "d", "write", w.work, 1);
    w.edit("ok", w.file("a"), "x", 5);
    fs.appendFileSync(journalFile(w.dir), '{"k":"before","ts":');
    assert.deepEqual(
      readChanges(w.dir).map((c) => c.call),
      ["ok"],
    );
  });

  it("never throws when the journal cannot be written", () => {
    const blocker = path.join(tmp(), "file");
    fs.writeFileSync(blocker, "x");
    recordBefore(path.join(blocker, "nope"), "c", "edit", blocker, 1);
    recordAfter(path.join(blocker, "nope"), "c", blocker, 2);
  });
});

describe("planRestore and applyRestore", () => {
  it("puts back what a file held when the message was sent, with the lines the agent changed", () => {
    const w = world();
    const f = w.file("a.txt");
    fs.writeFileSync(f, "1\n2\n3\n");
    w.edit("c1", f, "1\nTWO\n3\n4\n", 5000); // after the message sent at 4000
    w.edit("c2", f, "1\nTWO\n3\n4\n5\n", 6000);
    const plan = planRestore(w.dir, 4000);
    assert.equal(plan.restorable, 1);
    assert.deepEqual([plan.files[0]?.status, plan.added, plan.removed], ["restore", 3, 1]);
    const result = applyRestore(w.dir, plan);
    assert.deepEqual(result.restored, [f]);
    assert.equal(fs.readFileSync(f, "utf8"), "1\n2\n3\n");
  });

  it("leaves out what happened before the message", () => {
    const w = world();
    const f = w.file("a.txt");
    fs.writeFileSync(f, "v0");
    w.edit("old", f, "v1", 1000);
    w.edit("new", f, "v2", 5000);
    applyRestore(w.dir, planRestore(w.dir, 4000));
    assert.equal(fs.readFileSync(f, "utf8"), "v1", "back to the state at the message, not the very first");
    assert.equal(planRestore(w.dir, 9000).files.length, 0, "nothing was changed after a later message");
  });

  it("removes a file the agent created, and brings back one that is gone", () => {
    const w = world();
    const made = w.file("made.txt");
    w.edit("c1", made, "created\n", 5000);
    applyRestore(w.dir, planRestore(w.dir, 4000));
    assert.equal(fs.existsSync(made), false);
    const gone = w.file("gone.txt");
    fs.writeFileSync(gone, "keep me\n");
    w.edit("c2", gone, null, 6000);
    const plan = planRestore(w.dir, 5500);
    assert.deepEqual([plan.files[0]?.status, plan.removed], ["restore", 1]);
    applyRestore(w.dir, plan);
    assert.equal(fs.readFileSync(gone, "utf8"), "keep me\n");
  });

  it("leaves a file alone when something else changed it after the agent's last edit", () => {
    const w = world();
    const f = w.file("a.txt");
    fs.writeFileSync(f, "orig");
    w.edit("c1", f, "agent", 5000);
    fs.writeFileSync(f, "the user typed this");
    const plan = planRestore(w.dir, 4000);
    assert.equal(plan.files[0]?.status, "changed-since");
    assert.equal(plan.restorable, 0);
    const result = applyRestore(w.dir, plan);
    assert.deepEqual(result.restored, []);
    assert.match(result.left[0]?.why ?? "", /changed after the agent's last edit/);
    assert.equal(fs.readFileSync(f, "utf8"), "the user typed this");
  });

  it("a file already as it was is no change; a file too big to keep is left alone", () => {
    const w = world();
    const f = w.file("a.txt");
    fs.writeFileSync(f, "same");
    w.edit("c1", f, "other", 5000);
    fs.writeFileSync(f, "same");
    assert.equal(planRestore(w.dir, 4000).files[0]?.status, "same");
    const big = w.file("big");
    fs.writeFileSync(big, Buffer.alloc(MAX_FILE_BYTES + 5));
    recordBefore(w.dir, "b", "edit", big, 6000);
    const plan = planRestore(w.dir, 5500);
    assert.equal(plan.files[0]?.status, "too-big");
    assert.match(applyRestore(w.dir, plan).left[0]?.why ?? "", /too big/);
  });

  it("several files: only the restorable ones are counted", () => {
    const w = world();
    const a = w.file("a");
    const b = w.file("b");
    fs.writeFileSync(a, "1\n");
    fs.writeFileSync(b, "1\n");
    w.edit("c1", a, "1\n2\n", 5000);
    w.edit("c2", b, "x\n", 5100);
    const plan = planRestore(w.dir, 4000);
    assert.deepEqual([plan.restorable, plan.added, plan.removed], [2, 2, 1]);
  });
});

describe("pruneFrom", () => {
  it("forgets the records from a time on, and the blobs only they used", () => {
    const w = world();
    const f = w.file("a");
    fs.writeFileSync(f, "v0");
    w.edit("c1", f, "v1", 1000);
    w.edit("c2", f, "v2", 5000);
    pruneFrom(w.dir, 4000);
    assert.deepEqual(
      readChanges(w.dir).map((c) => c.call),
      ["c1"],
    );
    assert.equal(fs.readdirSync(path.join(w.dir, "blobs")).length, 1);
    pruneFrom(w.dir, 0);
    assert.deepEqual(readChanges(w.dir), []);
  });
});

describe("the extension", () => {
  const handlers: Record<string, (e: unknown, ctx?: unknown) => undefined> = {};
  const pi = {
    on: (name: string, h: (e: unknown, ctx?: unknown) => undefined) => {
      handlers[name] = h;
    },
  };

  it("records write and edit calls (and only those), before and after, under the session's directory", () => {
    const root = tmp();
    const work = tmp();
    const saved = [process.env[FILE_HISTORY_ENV], process.env.TORIEL_CHILD, process.env.TORIEL_SESSION_ID];
    process.env[FILE_HISTORY_ENV] = root;
    process.env.TORIEL_CHILD = "1";
    process.env.TORIEL_SESSION_ID = "sess-1";
    try {
      toriel(pi as never);
      const ctx = { cwd: work };
      fs.writeFileSync(path.join(work, "a.txt"), "before");
      const event = { toolName: "edit", toolCallId: "call-1", input: { path: "a.txt" } };
      handlers.tool_call?.(event, ctx);
      fs.writeFileSync(path.join(work, "a.txt"), "after");
      handlers.tool_result?.(event, ctx);
      handlers.tool_call?.({ toolName: "read", toolCallId: "call-2", input: { path: "a.txt" } }, ctx);
      handlers.tool_call?.({ toolName: "bash", toolCallId: "call-3", input: { command: "rm a.txt" } }, ctx);
      const changes = readChanges(path.join(root, "sess-1"));
      assert.equal(changes.length, 1);
      assert.equal(changes[0]?.path, fs.realpathSync(path.join(work, "a.txt")));
      assert.equal(changes[0]?.before.kind, "file");
      assert.equal(changes[0]?.after?.kind, "file");
    } finally {
      [FILE_HISTORY_ENV, "TORIEL_CHILD", "TORIEL_SESSION_ID"].forEach((k, i) => {
        if (saved[i] === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = saved[i];
        }
      });
    }
  });

  it("does nothing without a directory or outside a toriel child", () => {
    const seen: string[] = [];
    const saved = [process.env[FILE_HISTORY_ENV], process.env.TORIEL_CHILD];
    delete process.env[FILE_HISTORY_ENV];
    process.env.TORIEL_CHILD = "1";
    try {
      toriel({ on: (n: string) => void seen.push(n) } as never);
      assert.deepEqual(seen, []);
    } finally {
      [FILE_HISTORY_ENV, "TORIEL_CHILD"].forEach((k, i) => {
        if (saved[i] === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = saved[i];
        }
      });
    }
  });

  it("targetOf resolves @, ~ and relative paths, and ignores other tools; sessionDir refuses odd ids", () => {
    const cwd = fs.realpathSync(tmp());
    assert.equal(targetOf({ toolName: "write", input: { path: "@x/y.txt" } }, cwd), path.join(cwd, "x", "y.txt"));
    assert.equal(targetOf({ toolName: "edit", input: { path: "sub/../z.txt" } }, cwd), path.join(cwd, "z.txt"));
    assert.equal(targetOf({ toolName: "edit", input: { path: path.join(cwd, "abs.txt") } }, "/elsewhere"), path.join(cwd, "abs.txt"));
    assert.equal(targetOf({ toolName: "read", input: { path: "a" } }, "/tmp"), undefined);
    assert.equal(targetOf({ toolName: "edit", input: {} }, "/tmp"), undefined);
    assert.equal(sessionDir("/r", "../evil"), undefined);
    assert.equal(sessionDir("/r", "abc-123"), "/r/abc-123");
    assert.equal(sessionDir(undefined, "abc"), undefined);
  });
});
