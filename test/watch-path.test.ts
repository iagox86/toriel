import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveWatchTarget } from "../src/watch-path.ts";

const dirs = new Set(["/work", "/work/notes", "/home/u", "/home/u/docs", "/etc"]);
const fsApi = { isDirectory: (p: string) => dirs.has(p) };
const at = (raw: string, cwd: string | undefined = "/work", home: string | undefined = "/home/u") => resolveWatchTarget(raw, cwd, home, fsApi);

describe("resolving a /watch path", () => {
  it("takes an absolute file whose directory exists, even when the file does not (yet)", () => {
    assert.deepEqual(at("/work/notes/review.md"), { path: "/work/notes/review.md", dir: false });
  });

  it("resolves a relative path against the session's directory, and normalizes ..", () => {
    assert.deepEqual(at("notes/review.md"), { path: "/work/notes/review.md", dir: false });
    assert.deepEqual(at("./notes/../notes/review.md"), { path: "/work/notes/review.md", dir: false });
  });

  it("expands ~ and ~/x", () => {
    assert.deepEqual(at("~/docs/out.md"), { path: "/home/u/docs/out.md", dir: false });
    assert.deepEqual(at("~"), { path: "/home/u", dir: true });
    assert.throws(() => resolveWatchTarget("~/x", "/work", undefined, fsApi), /cannot expand ~/);
  });

  it("an existing directory is watched as a directory, with or without a trailing slash", () => {
    assert.deepEqual(at("notes"), { path: "/work/notes", dir: true });
    assert.deepEqual(at("notes/"), { path: "/work/notes", dir: true });
  });

  it("a trailing slash insists on an existing directory", () => {
    assert.throws(() => at("nope/"), /\/work\/nope is not an existing directory/);
  });

  it("needs the file's directory to exist, and says which one is missing", () => {
    assert.throws(() => at("/work/missing/review.md"), /\/work\/missing does not exist, so review\.md cannot appear in it/);
  });

  it("refuses the filesystem root, an empty path, and a relative path with no session directory", () => {
    assert.throws(() => at("/"), /filesystem root/);
    assert.throws(() => at("   "), /watch what/);
    assert.throws(() => resolveWatchTarget("notes/x", undefined, "/home/u", fsApi), /relative and this session has no known directory/);
    assert.deepEqual(resolveWatchTarget("/etc/hosts", undefined, "/home/u", fsApi), { path: "/etc/hosts", dir: false }, "an absolute path needs no session directory");
  });
});
