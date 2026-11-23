// toriel feedback list | prune | export (ticket 240).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { bundleTime, exportBundle, findBundle, fmtBytes, listBundles, parseAge, pruneBundles } from "../src/feedback-admin.ts";
import { feedbackMain } from "../src/feedback-cli.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-23T12:00:00.000Z");

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-fbadmin-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A bundle folder written `daysAgo` before NOW, named the way feedback-bundle.ts names them. */
function bundle(daysAgo: number, id: string, bytes = 100): string {
  const at = new Date(NOW - daysAgo * DAY).toISOString().replace(/[:.]/g, "-");
  const name = `${at}-${id}`;
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, "session.jsonl"), "x".repeat(bytes));
  fs.writeFileSync(path.join(dir, name, "manifest.txt"), "m");
  return name;
}

const names = (xs: Array<{ name: string }>) => xs.map((b) => b.name.slice(-8));

describe("feedback bundles (ticket 240)", () => {
  it("reads the time from the folder name, and sizes the folder", () => {
    assert.equal(bundleTime("2026-11-22T22-45-23-015Z-ab12cd34"), Date.parse("2026-11-22T22:45:23.015Z"));
    assert.equal(bundleTime("notes"), undefined);
    bundle(1, "aaaaaaaa", 1000);
    const [b] = listBundles(dir);
    assert.equal(b?.bytes, 1001);
    assert.equal(fmtBytes(36 * 1024 * 1024), "36 MB");
    assert.equal(fmtBytes(500), "500 B");
    assert.equal(parseAge("30d"), 30 * DAY);
    assert.equal(parseAge("2w"), 14 * DAY);
    assert.equal(parseAge("soon"), undefined);
  });

  it("lists newest first, and ignores files such as the notes file", () => {
    bundle(5, "old00000");
    bundle(1, "new00000");
    bundle(3, "mid00000");
    fs.writeFileSync(path.join(dir, "feedback.jsonl"), "{}\n");
    assert.deepEqual(names(listBundles(dir)), ["new00000", "mid00000", "old00000"]);
    assert.deepEqual(listBundles(path.join(dir, "missing")), []);
  });

  it("prunes by count, keeping the newest", () => {
    for (const [d, id] of [[1, "a0000000"], [2, "b0000000"], [3, "c0000000"], [4, "d0000000"]] as const) {
      bundle(d, id);
    }
    const r = pruneBundles(dir, { keep: 2, now: NOW });
    assert.deepEqual(names(r.removed), ["c0000000", "d0000000"]);
    assert.deepEqual(names(listBundles(dir)), ["a0000000", "b0000000"]);
  });

  it("prunes by age, and by either rule when both are given", () => {
    bundle(1, "a0000000");
    bundle(10, "b0000000");
    bundle(40, "c0000000");
    assert.deepEqual(names(pruneBundles(dir, { olderThanMs: 30 * DAY, now: NOW, dryRun: true }).removed), ["c0000000"]);
    assert.equal(listBundles(dir).length, 3, "a dry run deletes nothing");
    const both = pruneBundles(dir, { olderThanMs: 30 * DAY, keep: 1, now: NOW });
    assert.deepEqual(names(both.removed).sort(), ["b0000000", "c0000000"]);
    assert.deepEqual(names(listBundles(dir)), ["a0000000"]);
  });

  it("never deletes without a rule, and never touches the notes file", () => {
    bundle(100, "a0000000");
    fs.writeFileSync(path.join(dir, "feedback.jsonl"), "{}\n");
    assert.deepEqual(pruneBundles(dir, { now: NOW }).removed, []);
    pruneBundles(dir, { keep: 0, now: NOW });
    assert.equal(listBundles(dir).length, 0);
    assert.equal(fs.existsSync(path.join(dir, "feedback.jsonl")), true);
  });

  it("finds a bundle by any unique part of its name", () => {
    const a = bundle(1, "abcd1234");
    bundle(2, "abef5678");
    assert.equal((findBundle(dir, "abcd") as { bundle: { name: string } }).bundle.name, a);
    assert.match((findBundle(dir, "ab") as { error: string }).error, /matches 2 bundles/);
    assert.match((findBundle(dir, "zzzz") as { error: string }).error, /no bundle matches/);
    assert.match((findBundle(dir, "") as { error: string }).error, /no bundle matches/);
  });

  it("exports with tar, to a file only the user can read", async () => {
    const name = bundle(1, "abcd1234");
    const seen: string[][] = [];
    const out = await exportBundle(listBundles(dir)[0] as never, path.join(dir, "out"), async (args) => {
      seen.push(args);
      fs.writeFileSync(args[1] as string, "tar");
    });
    assert.equal(out, path.join(dir, "out", `feedback-${name}.tar.gz`));
    assert.equal(fs.statSync(out).mode & 0o777, 0o600);
    assert.deepEqual(seen[0]?.slice(2), ["-C", dir, name]);
  });

  it("really packs a bundle (system tar)", async () => {
    bundle(1, "abcd1234", 5000);
    const out = await exportBundle(listBundles(dir)[0] as never, path.join(dir, "out"));
    assert.ok(fs.statSync(out).size > 0);
  });
});

describe("toriel feedback (the command)", () => {
  const run = async (args: string[], extra: Record<string, unknown> = {}) => {
    let text = "";
    const code = await feedbackMain(args, { write: (t) => (text += t) }, { feedbackDir: dir, cwd: dir, now: NOW, ...extra });
    return { code, text };
  };

  it("lists, with sizes and a total", async () => {
    bundle(2, "abcd1234", 2048);
    const r = await run(["list"]);
    assert.equal(r.code, 0);
    assert.match(r.text, /abcd1234 +2\.0 KB +2d old/);
    assert.match(r.text, /1 bundles, 2\.0 KB/);
    assert.match((await run(["list"], { feedbackDir: path.join(dir, "none") })).text, /no bundles/);
  });

  it("prune needs a rule, validates its values, and --dry-run changes nothing", async () => {
    bundle(40, "abcd1234");
    assert.equal((await run(["prune"])).code, 2);
    assert.equal((await run(["prune", "--keep", "x"])).code, 2);
    assert.equal((await run(["prune", "--older-than", "soon"])).code, 2);
    assert.equal((await run(["prune", "--frobnicate"])).code, 2);
    const dry = await run(["prune", "--older-than", "30d", "--dry-run"]);
    assert.match(dry.text, /would remove .*abcd1234/);
    assert.match(dry.text, /nothing was deleted/);
    assert.equal(listBundles(dir).length, 1);
    const real = await run(["prune", "--older-than=30d"]);
    assert.match(real.text, /removed 1 bundles/);
    assert.equal(listBundles(dir).length, 0);
  });

  it("exports one bundle, says the session is not redacted, and reports a bad name", async () => {
    bundle(1, "abcd1234");
    const tar = async (args: string[]) => void fs.writeFileSync(args[1] as string, "tar");
    const ok = await run(["export", "abcd", "--to", "out"], { tar });
    assert.equal(ok.code, 0);
    assert.match(ok.text, /feedback-.*abcd1234\.tar\.gz/);
    assert.match(ok.text, /not redacted/);
    assert.equal(fs.existsSync(path.join(dir, "out")), true);
    const bad = await run(["export", "nope"], { tar });
    assert.equal(bad.code, 1);
    assert.match(bad.text, /no bundle matches/);
    assert.equal((await run(["export"])).code, 2);
  });

  it("prints usage with no command or an unknown one", async () => {
    assert.equal((await run([])).code, 2);
    assert.equal((await run(["--help"])).code, 0);
    assert.equal((await run(["sweep"])).code, 2);
  });
});
