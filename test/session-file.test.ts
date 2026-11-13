import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { messagesFromFile } from "../src/transcript.ts";
import { parseLines, readEntries, readHeader, readLines, sessionIdOfFile } from "../src/session-file.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-session-file-"));
const write = (name: string, text: string): string => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
};
const HEADER = JSON.stringify({ type: "session", id: "0f8e7d6c-1234-4abc-9def-0123456789ab", cwd: "/w/é" });

describe("readHeader", () => {
  it("parses the first line and ignores the rest", () => {
    const file = write("a.jsonl", `${HEADER}\n{"type":"message"}\n`);
    assert.equal(readHeader(file)?.cwd, "/w/é");
    assert.equal(sessionIdOfFile(file), "0f8e7d6c-1234-4abc-9def-0123456789ab");
  });

  it("reads a header that is the whole file, with or without a newline", () => {
    assert.equal(sessionIdOfFile(write("b.jsonl", HEADER)), "0f8e7d6c-1234-4abc-9def-0123456789ab");
    assert.equal(sessionIdOfFile(write("c.jsonl", `${HEADER}\n`)), "0f8e7d6c-1234-4abc-9def-0123456789ab");
  });

  it("reads only the start of a large file", () => {
    const body = `${"x".repeat(1000)}\n`.repeat(20_000); // about 20 MB of lines after the header
    assert.equal(sessionIdOfFile(write("big.jsonl", `${HEADER}\n${body}`)), "0f8e7d6c-1234-4abc-9def-0123456789ab");
  });

  it("gives undefined for a missing, empty or malformed file, and for a first line that is not an object", () => {
    assert.equal(readHeader(path.join(dir, "missing.jsonl")), undefined);
    assert.equal(readHeader(write("empty.jsonl", "")), undefined);
    assert.equal(readHeader(write("bad.jsonl", "not json\n")), undefined);
    assert.equal(readHeader(write("array.jsonl", "[1]\n")), undefined);
    assert.equal(sessionIdOfFile(write("noid.jsonl", '{"type":"session"}\n')), undefined);
    assert.equal(sessionIdOfFile(write("numid.jsonl", '{"id":7}\n')), undefined);
  });

  it("gives undefined for a first line longer than any header", () => {
    assert.equal(readHeader(write("long.jsonl", `{"id":"${"y".repeat(70_000)}"}\n`)), undefined);
  });
});

const lines = (...entries: unknown[]): string => `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;

describe("readEntries", () => {
  it("skips a torn trailing line and does not touch the file", () => {
    const text = `${lines({ type: "session", id: "s", version: 3 }, { type: "message", id: "a", message: { role: "user", content: "hi" } })}{"type":"mess`;
    const file = write("torn.jsonl", text);
    assert.deepEqual(readEntries(file).map((e) => e.type), ["session", "message"]);
    assert.equal(fs.readFileSync(file, "utf8"), text, "reading a file pi may be writing must not append to it");
  });

  it("brings a version-1 file (no ids, compaction by index) to the current format", () => {
    const file = write(
      "v1.jsonl",
      lines(
        { type: "session", id: "s", version: 1 },
        { type: "message", message: { role: "user", content: "old" } },
        { type: "message", message: { role: "user", content: "kept" } },
        { type: "compaction", summary: "sum", firstKeptEntryIndex: 2, tokensBefore: 1 },
      ),
    );
    const entries = readEntries(file);
    assert.ok(entries.every((e) => e.type === "session" || typeof e.id === "string"), "every entry has an id");
    assert.equal(entries[3]?.firstKeptEntryId, entries[2]?.id);
    // and the transcript built from it flags exactly what the summary replaced
    const ms = messagesFromFile(file) as Array<{ role: string; outOfContext?: boolean }>;
    assert.deepEqual(ms.map((m) => [m.role, Boolean(m.outOfContext)]), [["user", true], ["user", false], ["compactionSummary", false]]);
  });

  it("renames the old hookMessage role", () => {
    const file = write("v2.jsonl", lines({ type: "session", id: "s", version: 2 }, { type: "message", id: "a", parentId: null, message: { role: "hookMessage", content: "x" } }));
    const message = readEntries(file)[1]?.message as { role: string } | undefined;
    assert.equal(message?.role, "custom");
  });
});

describe("readLines", () => {
  it("keeps every physical line, blank ones too, and leaves a torn one without an entry", () => {
    const file = write("raw.jsonl", `${HEADER}\n\n{"type":"mess\n`);
    const got = readLines(file);
    assert.deepEqual(got.map((l) => l.raw), [HEADER, "", '{"type":"mess', ""]);
    assert.deepEqual(got.map((l) => l.entry !== undefined), [true, false, false, false]);
  });

  it("does not migrate: a version-1 file's lines come back as written", () => {
    const file = write("raw1.jsonl", lines({ type: "session", id: "s" }, { type: "message", message: { role: "user", content: "x" } }));
    assert.equal(readLines(file)[1]?.entry?.id, undefined);
    assert.equal(parseLines('{"a":1}\n').length, 2);
  });
});
