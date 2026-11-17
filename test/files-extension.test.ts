// The toriel-files extension (ticket 13, tool-efficiency study of ticket 63): the freshness check, the hint on a failed edit and the
// replaceAll edit tool, each as a unit and through the extension's handlers.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createEditToolDefinition } from "@earendil-works/pi-coding-agent";
import { childEnv } from "../src/child-env.ts";
import { dice, editHint, editsOf, nearestText, occurrences } from "../pi/extensions/lib/edit-help.ts";
import { FRESHNESS_ENV, FreshnessStore, fileTool, targetPath } from "../pi/extensions/lib/freshness.ts";
import { replaceEvery } from "../pi/extensions/lib/replace-all.ts";
import files, { editWithReplaceAll } from "../pi/extensions/toriel-files.ts";

let dir: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "toriel-files-")));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const write = (name: string, content: string): string => {
  const f = path.join(dir, name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
  return f;
};
/** Make the file look modified without changing a byte of it. */
const touch = (f: string, secondsLater = 5): void => {
  const t = new Date(Date.now() + secondsLater * 1000);
  fs.utimesSync(f, t, t);
};

describe("FreshnessStore", () => {
  it("refuses an edit or write of a file the session has not read, and says to read it", () => {
    const f = write("a.txt", "one\n");
    const store = new FreshnessStore();
    assert.match(store.verdict("edit", f, "a.txt") ?? "", /a\.txt has not been read in this session, so it cannot be edited yet: read it first/);
    assert.match(store.verdict("write", f, "a.txt") ?? "", /cannot be overwritten yet/);
  });

  it("lets a read file be edited, and a new file be written without a read", () => {
    const f = write("a.txt", "one\n");
    const store = new FreshnessStore();
    store.record(f);
    assert.equal(store.verdict("edit", f, "a.txt"), undefined);
    assert.equal(store.verdict("write", path.join(dir, "new.txt"), "new.txt"), undefined, "a file that does not exist is new");
  });

  it("refuses when the file changed after the read, whoever changed it", () => {
    const f = write("a.txt", "one\n");
    const store = new FreshnessStore();
    store.record(f);
    fs.writeFileSync(f, "one and more\n");
    assert.match(store.verdict("edit", f, "a.txt") ?? "", /has changed since you read it.*read it again/);
  });

  it("notices a same-size rewrite by content, but not a touch that left the bytes alone", () => {
    const f = write("a.txt", "aaaa\n");
    const store = new FreshnessStore();
    store.record(f);
    touch(f);
    assert.equal(store.verdict("edit", f, "a.txt"), undefined, "same bytes, new mtime: nothing the model needs to see");
    fs.writeFileSync(f, "bbbb\n");
    touch(f, 10);
    assert.match(store.verdict("edit", f, "a.txt") ?? "", /has changed/, "same size, other bytes");
  });

  it("takes the session's own write as a read: record again after it and the next edit passes", () => {
    const f = write("a.txt", "one\n");
    const store = new FreshnessStore();
    store.record(f);
    fs.writeFileSync(f, "two, longer\n");
    store.record(f);
    assert.equal(store.verdict("edit", f, "a.txt"), undefined);
  });

  it("keys a file by its real path, so a symlink and its target are one file", () => {
    const f = write("real.txt", "x\n");
    const link = path.join(dir, "link.txt");
    fs.symlinkSync(f, link);
    const store = new FreshnessStore();
    store.record(link);
    assert.equal(store.knows(f), true);
    assert.equal(store.verdict("edit", f, "real.txt"), undefined);
  });

  it("leaves a directory or an unreadable thing alone", () => {
    const store = new FreshnessStore();
    assert.equal(store.verdict("write", dir, "dir"), undefined);
    store.record(dir);
    assert.equal(store.knows(dir), false);
  });
});

describe("targetPath and fileTool", () => {
  it("resolves against the working directory, drops a leading @, and expands ~", () => {
    assert.equal(targetPath({ path: "a/b.txt" }, "/w"), "/w/a/b.txt");
    assert.equal(targetPath({ path: "@a.txt" }, "/w"), "/w/a.txt");
    assert.equal(targetPath({ path: "~/x" }, "/w", "/home/u"), "/home/u/x");
    assert.equal(targetPath({ path: "/abs/x" }, "/w"), "/abs/x");
    assert.equal(targetPath({}, "/w"), undefined);
    assert.equal(targetPath({ path: "" }, "/w"), undefined);
    assert.equal(targetPath(undefined, "/w"), undefined);
  });

  it("knows only read, write and edit", () => {
    assert.deepEqual(["read", "write", "edit", "bash", 3].map(fileTool), ["read", "write", "edit", undefined, undefined]);
  });
});

describe("edit hints", () => {
  const FILE = ["function main() {", "  const total = items.length;", "  return total;", "}", ""].join("\n");

  it("scores similar strings above dissimilar ones", () => {
    assert.equal(dice("abc", "abc"), 1);
    assert.ok(dice("const total = items.length;", "const total = items.size;") > 0.7);
    assert.ok(dice("const total", "zzzzzzz") < 0.1);
    assert.equal(dice("a", "b"), 0);
  });

  it("shows the nearest lines and says when only whitespace differs", () => {
    const hint = nearestText(FILE, "const total = items.length;\n    return total;", "m.ts") ?? "";
    assert.match(hint, /nearest text in m\.ts is at lines 2-3; it differs from your oldText only in whitespace/);
    assert.match(hint, /Copy it exactly:\n {2}const total = items\.length;\n {2}return total;/);
  });

  it("says plainly when the text differs in more than whitespace", () => {
    const hint = nearestText(FILE, "const total = items.size;", "m.ts") ?? "";
    assert.match(hint, /lines 2-2; it differs from your oldText\. Copy it exactly:\n {2}const total = items\.length;/);
  });

  it("says nothing resembles it when nothing does", () => {
    assert.match(nearestText(FILE, "zzzzz qqqqq wwwww", "m.ts") ?? "", /No line of m\.ts resembles the first line of oldText/);
  });

  it("anchors on the first non-blank line and aligns the window to it", () => {
    const hint = nearestText(FILE, "\n  return total;\n}", "m.ts") ?? "";
    assert.match(hint, /lines 2-4/, "a leading blank line shifts the window up by one");
    assert.match(hint, /return total;/);
  });

  it("lists where an oldText that matched more than once occurs", () => {
    const text = "x\nfoo\ny\nfoo\nz\nfoo\n";
    assert.deepEqual(occurrences(text, "foo"), { lines: [2, 4, 6], total: 3 });
    assert.deepEqual(occurrences(text, "nope"), { lines: [], total: 0 });
    assert.deepEqual(occurrences("a\r\nfoo\r\n", "foo"), { lines: [2], total: 1 });
  });

  it("turns pi's two edit errors into a hint, finding the edit by its index", () => {
    const edits = [
      { oldText: "return total;", newText: "x" },
      { oldText: "const total = items.size;", newText: "y" },
    ];
    assert.match(editHint("Could not find edits[1] in m.ts. The oldText must match exactly.", edits, FILE, "m.ts") ?? "", /lines 2-2/);
    assert.match(editHint("Could not find the exact text in m.ts. The old text must match.", edits, FILE, "m.ts") ?? "", /lines 3-3/, "a single-edit message means the first");
    const dup = editHint("Found 3 occurrences of the text in m.ts. The text must be unique.", [{ oldText: "foo", newText: "bar" }], "foo\nfoo\nfoo\n", "m.ts") ?? "";
    assert.match(dup, /matches at lines 1, 2, 3.*replaceAll: true/);
    assert.equal(editHint("Could not edit file: m.ts. Error code: ENOENT.", edits, FILE, "m.ts"), undefined);
    assert.equal(editHint("Could not find edits[9] in m.ts.", edits, FILE, "m.ts"), undefined);
  });

  it("reads the edits the way pi's own argument handling does", () => {
    assert.deepEqual(editsOf({ edits: [{ oldText: "a", newText: "b" }] }), [{ oldText: "a", newText: "b", replaceAll: false }]);
    assert.deepEqual(editsOf({ edits: JSON.stringify([{ oldText: "a", newText: "b", replaceAll: true }]) }), [{ oldText: "a", newText: "b", replaceAll: true }]);
    assert.deepEqual(editsOf({ edits: { oldText: "a", newText: "b" } }), [{ oldText: "a", newText: "b", replaceAll: false }]);
    assert.deepEqual(editsOf({ oldText: "a", newText: "b" }), [{ oldText: "a", newText: "b", replaceAll: false }]);
    assert.deepEqual(editsOf({ edits: [{ oldText: 1 }, null] }), []);
    assert.deepEqual(editsOf(undefined), []);
  });
});

describe("replaceEvery", () => {
  it("replaces every exact occurrence and counts them", () => {
    assert.deepEqual(replaceEvery("a.b a.b a.b", "a.b", "X"), { content: "X X X", count: 3 }, "a dot is a dot, not a pattern");
    assert.deepEqual(replaceEvery("abc", "zzz", "X"), { content: "abc", count: 0 });
    assert.deepEqual(replaceEvery("abc", "", "X"), { content: "abc", count: 0 });
  });

  it("keeps a CRLF file CRLF when the model wrote LF", () => {
    assert.deepEqual(replaceEvery("a\r\nfoo\r\nb\r\nfoo\r\n", "foo\n", "bar\nbaz\n"), { content: "a\r\nbar\r\nbaz\r\nb\r\nbar\r\nbaz\r\n", count: 2 });
  });
});

describe("edit with replaceAll", () => {
  const base = createEditToolDefinition(process.cwd()).execute as unknown as Parameters<typeof editWithReplaceAll>[0];
  const run = (input: unknown) => editWithReplaceAll(base, "id", input, undefined, undefined, { cwd: dir });

  it("changes every occurrence and returns a diff for the renderer", async () => {
    const f = write("a.ts", "foo(1);\nfoo(2);\nbar();\nfoo(3);\n");
    const r = await run({ path: "a.ts", edits: [{ oldText: "foo(", newText: "baz(", replaceAll: true }] });
    assert.equal(fs.readFileSync(f, "utf8"), "baz(1);\nbaz(2);\nbar();\nbaz(3);\n");
    assert.match(r.content[0].text, /Successfully replaced 1 block\(s\) in a\.ts \(3 occurrences changed by replaceAll\)/);
    const d = r.details as { diff: string; patch: string; firstChangedLine: number };
    assert.equal(d.firstChangedLine, 1);
    assert.match(d.diff, /baz\(1\)/);
    assert.match(d.patch, /^--- a\.ts/m);
  });

  it("applies the call's other edits through pi's tool, then the replaceAll ones", async () => {
    const f = write("a.ts", "let x = 1;\nuse(x);\nuse(x);\nlet y = 2;\n");
    await run({
      path: "a.ts",
      edits: [
        { oldText: "use(x)", newText: "use(z)", replaceAll: true },
        { oldText: "let y = 2;", newText: "let y = 3;" },
      ],
    });
    assert.equal(fs.readFileSync(f, "utf8"), "let x = 1;\nuse(z);\nuse(z);\nlet y = 3;\n");
  });

  it("keeps CRLF line endings and a BOM", async () => {
    const f = write("w.txt", "﻿foo\r\nfoo\r\n");
    await run({ path: "w.txt", edits: [{ oldText: "foo\n", newText: "bar\n", replaceAll: true }] });
    assert.equal(fs.readFileSync(f, "utf8"), "﻿bar\r\nbar\r\n");
  });

  it("fails the whole call, writing nothing, when an oldText is missing or empty", async () => {
    const f = write("a.ts", "foo\nlet y = 2;\n");
    await assert.rejects(run({ path: "a.ts", edits: [{ oldText: "let y = 2;", newText: "let y = 3;" }, { oldText: "nope", newText: "x", replaceAll: true }] }), /Could not find edits\[1\] in a\.ts/);
    await assert.rejects(run({ path: "a.ts", edits: [{ oldText: "", newText: "x", replaceAll: true }] }), /edits\[0\]\.oldText must not be empty/);
    assert.equal(fs.readFileSync(f, "utf8"), "foo\nlet y = 2;\n", "the unique edit was not applied either");
  });

  it("errors on a file that is not there, and on an edit that changes nothing", async () => {
    await assert.rejects(run({ path: "missing.ts", edits: [{ oldText: "a", newText: "b", replaceAll: true }] }), /Could not edit file: missing\.ts\. Error code: ENOENT/);
    write("same.ts", "a a\n");
    await assert.rejects(run({ path: "same.ts", edits: [{ oldText: "a", newText: "a", replaceAll: true }] }), /No changes made to same\.ts/);
  });
});

type Block = { block: true; reason: string } | undefined;
type Patch = { content: Array<{ type: string; text: string }> } | undefined;

/** The extension loaded into a fake pi: its handlers and the tools it registered. */
function load(env: Record<string, string | undefined>) {
  const saved = new Map(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  const handlers: Record<string, (e: unknown, c?: unknown) => unknown> = {};
  const tools: Array<Record<string, unknown>> = [];
  files({
    on: (name: string, h: (e: unknown, c?: unknown) => unknown) => {
      handlers[name] = h;
    },
    registerTool: (t: Record<string, unknown>) => {
      tools.push(t);
    },
  } as never);
  for (const [k, v] of saved) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  const ctx = { cwd: dir };
  return {
    tools,
    call: (toolName: string, input: unknown): Block => handlers.tool_call?.({ toolName, input }, ctx) as Block,
    result: (toolName: string, input: unknown, extra: Record<string, unknown> = {}): Patch => handlers.tool_result?.({ toolName, input, isError: false, ...extra }, ctx) as Patch,
  };
}

describe("the toriel-files extension", () => {
  it("does nothing outside a toriel child", () => {
    const x = load({ TORIEL_CHILD: undefined });
    assert.equal(x.tools.length, 0);
    assert.equal(x.call("edit", { path: "a.txt" }), undefined);
  });

  it("blocks an edit of an unread file, and lets it through after a read", () => {
    write("a.txt", "one\n");
    const x = load({ TORIEL_CHILD: "1", [FRESHNESS_ENV]: undefined });
    assert.match(x.call("edit", { path: "a.txt" })?.reason ?? "", /has not been read in this session/);
    assert.match(x.call("write", { path: "a.txt" })?.reason ?? "", /has not been read in this session/);
    assert.equal(x.call("read", { path: "a.txt" }), undefined, "reading is never blocked");
    x.result("read", { path: "a.txt" });
    assert.equal(x.call("edit", { path: "a.txt" }), undefined);
  });

  it("does not take a failed read, or a failed edit, as seeing the file", () => {
    write("a.txt", "one\n");
    const x = load({ TORIEL_CHILD: "1", [FRESHNESS_ENV]: undefined });
    x.result("read", { path: "a.txt" }, { isError: true, content: [] });
    assert.match(x.call("edit", { path: "a.txt" })?.reason ?? "", /has not been read/);
  });

  it("lets a new file be created, and the session's own write be edited at once", () => {
    const x = load({ TORIEL_CHILD: "1", [FRESHNESS_ENV]: undefined });
    assert.equal(x.call("write", { path: "new.txt" }), undefined);
    write("new.txt", "made\n");
    x.result("write", { path: "new.txt" });
    assert.equal(x.call("edit", { path: "new.txt" }), undefined);
  });

  it("checks nothing when the fileFreshness setting turned it off, but still adds hints and registers edit", () => {
    write("a.txt", "one\n");
    const x = load({ TORIEL_CHILD: "1", [FRESHNESS_ENV]: "off" });
    assert.equal(x.call("edit", { path: "a.txt" }), undefined);
    assert.equal(x.tools.length, 1);
  });

  it("adds the nearest text to a failed edit and leaves other errors alone", () => {
    write("a.txt", "alpha\n  beta gamma\n");
    const x = load({ TORIEL_CHILD: "1", [FRESHNESS_ENV]: undefined });
    const input = { path: "a.txt", edits: [{ oldText: "beta gamma", newText: "x" }] };
    const patched = x.result("edit", input, { isError: true, content: [{ type: "text", text: "Could not find the exact text in a.txt. The old text must match exactly." }] });
    assert.match(patched?.content[0].text ?? "", /^Could not find the exact text in a\.txt\..*\n\nThe nearest text in a\.txt is at lines 2-2/s);
    assert.equal(x.result("edit", input, { isError: true, content: [{ type: "text", text: "Operation aborted" }] }), undefined);
    assert.equal(x.result("write", input, { isError: true, content: [{ type: "text", text: "Could not find the exact text" }] }), undefined, "only edit gets hints");
  });

  it("registers an edit tool that keeps pi's name and adds replaceAll to its schema", () => {
    const x = load({ TORIEL_CHILD: "1", [FRESHNESS_ENV]: undefined });
    const [tool] = x.tools as Array<{ name: string; parameters: { properties: { edits: { items: { properties: Record<string, unknown> } } } }; description: string; execute: unknown }>;
    assert.equal(tool.name, "edit");
    assert.ok(tool.parameters.properties.edits.items.properties.replaceAll);
    assert.match(tool.description, /replaceAll/);
    assert.equal(typeof tool.execute, "function");
  });

  it("runs an edit with replaceAll through the registered tool", async () => {
    const f = write("a.txt", "q q q\n");
    const x = load({ TORIEL_CHILD: "1", [FRESHNESS_ENV]: undefined });
    const tool = x.tools[0] as { execute: (id: string, input: unknown, s: unknown, u: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }> };
    const r = await tool.execute("1", { path: "a.txt", edits: [{ oldText: "q", newText: "r", replaceAll: true }] }, undefined, undefined, { cwd: dir });
    assert.equal(fs.readFileSync(f, "utf8"), "r r r\n");
    assert.match(r.content[0].text, /3 occurrences/);
    const plain = await tool.execute("2", { path: "a.txt", edits: [{ oldText: "r r r", newText: "s" }] }, undefined, undefined, { cwd: dir });
    assert.match(plain.content[0].text, /Successfully replaced 1 block\(s\) in a\.txt\.$/, "without replaceAll it is pi's own edit");
    assert.equal(fs.readFileSync(f, "utf8"), "s\n");
  });
});

describe("the fileFreshness setting reaches the child", () => {
  it("sets the off switch only when the setting is false, and never lets the daemon's own value through", () => {
    assert.equal(childEnv({}, "/sock", {}, undefined, { freshness: false })[FRESHNESS_ENV], "off");
    assert.equal(childEnv({}, "/sock", {}, undefined, { freshness: true })[FRESHNESS_ENV], undefined);
    assert.equal(childEnv({}, "/sock", {}, undefined, {})[FRESHNESS_ENV], undefined, "unset = on");
    assert.equal(childEnv({}, "/sock", { [FRESHNESS_ENV]: "off" }, undefined, {})[FRESHNESS_ENV], undefined, "a daemon started with it off does not turn it off for every child");
  });
});
