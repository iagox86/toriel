import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { clipMiddle, errText, fireAndReport, moveFile, readJsonOr, rotateLog, writeFileAtomic, writeJsonAtomic } from "../src/util.ts";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "toriel-util-"));

describe("errText", () => {
  it("gives an Error's message and any other thrown value as text", () => {
    assert.equal(errText(new Error("boom")), "boom");
    assert.equal(errText("plain"), "plain");
    assert.equal(errText(42), "42");
  });
});

describe("writeFileAtomic", () => {
  it("creates missing directories and replaces an existing file without leaving temp files", () => {
    const dir = tmp();
    const file = path.join(dir, "a", "b", "f.txt");
    writeFileAtomic(file, "one");
    writeFileAtomic(file, "two");
    assert.equal(fs.readFileSync(file, "utf8"), "two");
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["f.txt"]);
  });

  it("applies the requested mode to a new file", () => {
    const file = path.join(tmp(), "secret.json");
    writeFileAtomic(file, "{}", 0o600);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });
});

describe("writeJsonAtomic / readJsonOr", () => {
  it("round-trips a value, written as indented JSON with a trailing newline", () => {
    const file = path.join(tmp(), "d.json");
    writeJsonAtomic(file, { a: [1, 2] });
    assert.equal(fs.readFileSync(file, "utf8"), '{\n  "a": [\n    1,\n    2\n  ]\n}\n');
    assert.deepEqual(readJsonOr(file, {}), { a: [1, 2] });
  });

  it("returns the fallback for a missing file and for invalid JSON", () => {
    const dir = tmp();
    assert.deepEqual(readJsonOr(path.join(dir, "none.json"), { x: 1 }), { x: 1 });
    fs.writeFileSync(path.join(dir, "bad.json"), "{ nope");
    assert.deepEqual(readJsonOr(path.join(dir, "bad.json"), []), []);
  });
});

describe("rotateLog", () => {
  it("leaves a log under the limit alone", () => {
    const file = path.join(tmp(), "d.log");
    fs.writeFileSync(file, "x".repeat(10));
    assert.equal(rotateLog(file, 10), false);
    assert.equal(fs.readFileSync(file, "utf8"), "x".repeat(10));
  });

  it("moves a log over the limit to .1, replacing the previous one, so the next append starts fresh", () => {
    const file = path.join(tmp(), "d.log");
    fs.writeFileSync(`${file}.1`, "older");
    fs.writeFileSync(file, "x".repeat(11));
    assert.equal(rotateLog(file, 10), true);
    assert.equal(fs.readFileSync(`${file}.1`, "utf8"), "x".repeat(11));
    assert.equal(fs.existsSync(file), false);
  });

  it("does nothing when there is no log yet", () => {
    assert.equal(rotateLog(path.join(tmp(), "none.log")), false);
  });
});

describe("moveFile", () => {
  const exdev = (): never => {
    throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
  };

  it("moves a file with a plain rename on one filesystem", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-move-"));
    fs.writeFileSync(path.join(dir, "a"), "hello");
    moveFile(path.join(dir, "a"), path.join(dir, "b"));
    assert.equal(fs.readFileSync(path.join(dir, "b"), "utf8"), "hello");
    assert.equal(fs.existsSync(path.join(dir, "a")), false);
  });

  it("copies and removes the original when the rename crosses filesystems", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-move-"));
    fs.writeFileSync(path.join(dir, "a"), "hello");
    moveFile(path.join(dir, "a"), path.join(dir, "b"), exdev);
    assert.equal(fs.readFileSync(path.join(dir, "b"), "utf8"), "hello");
    assert.deepEqual(fs.readdirSync(dir), ["b"]);
  });

  it("passes any other error through and leaves the file where it was", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-move-"));
    fs.writeFileSync(path.join(dir, "a"), "hello");
    assert.throws(() => moveFile(path.join(dir, "a"), path.join(dir, "b"), () => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    }), /EACCES/);
    assert.equal(fs.existsSync(path.join(dir, "a")), true);
  });
});

describe("fireAndReport", () => {
  it("turns a rejection into a notice naming what failed, and says nothing on success", async () => {
    const notes: string[] = [];
    fireAndReport(Promise.reject(new Error("disk full")), "saving the group", (t) => notes.push(t));
    fireAndReport(Promise.resolve(1), "fine", (t) => notes.push(t));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(notes, ["saving the group failed: disk full"]);
  });
});

describe("clipMiddle", () => {
  it("leaves short text alone and cuts a long one to its first third plus its tail around a marker", () => {
    assert.equal(clipMiddle("short", 10), "short");
    const text = "a".repeat(30) + "b".repeat(30) + "c".repeat(30);
    const clipped = clipMiddle(text, 30);
    assert.equal(clipped, `${"a".repeat(10)}\n[...]\n${"c".repeat(20)}`);
  });
});
