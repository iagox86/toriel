import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { readHeader, sessionIdOfFile } from "../src/session-file.ts";

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
