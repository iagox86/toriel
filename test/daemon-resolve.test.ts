import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { dirOfSession } from "../src/daemon-resolve.ts";

const ID = "0f8e7d6c-1234-4abc-9def-0123456789ab";

describe("dirOfSession", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-resolve-"));
  fs.mkdirSync(path.join(root, "proj-a"));
  fs.mkdirSync(path.join(root, "proj-b"));
  fs.writeFileSync(path.join(root, "proj-a", "2026-11-01T00-00-00-000Z_aaaaaaaa-1234-4abc-9def-0123456789ab.jsonl"), "");
  fs.writeFileSync(path.join(root, "proj-b", `2026-11-02T00-00-00-000Z_${ID}.jsonl`), "");

  it("finds the project directory of a full UUID from file names alone", () => {
    assert.equal(dirOfSession(ID, root), path.join(root, "proj-b"));
    assert.equal(dirOfSession(ID.toUpperCase(), root), path.join(root, "proj-b"));
  });

  it("leaves anything but a full UUID, and an unknown UUID, to the full scan", () => {
    assert.equal(dirOfSession("0f8e7d6c", root), undefined);
    assert.equal(dirOfSession("my session", root), undefined);
    assert.equal(dirOfSession("ffffffff-1234-4abc-9def-0123456789ab", root), undefined);
    assert.equal(dirOfSession(ID, path.join(root, "missing")), undefined);
  });

  it("leaves a UUID found in two project directories to the full scan, which reports it as ambiguous", () => {
    const dup = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-resolve-dup-"));
    for (const d of ["a", "b"]) {
      fs.mkdirSync(path.join(dup, d));
      fs.writeFileSync(path.join(dup, d, `2026-11-02T00-00-00-000Z_${ID}.jsonl`), "");
    }
    assert.equal(dirOfSession(ID, dup), undefined);
  });
});
