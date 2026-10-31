import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { startupProblems } from "../src/preflight.ts";

const ENTRY = path.join(import.meta.dirname, "..", "toriel.ts");

/** A checkout with the pin and (optionally) the dependencies in place. */
function checkout(nvmrc: string, deps: boolean): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-pre-"));
  fs.writeFileSync(path.join(root, ".nvmrc"), `${nvmrc}\n`);
  if (deps) {
    for (const d of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "commander"]) {
      fs.mkdirSync(path.join(root, "node_modules", d), { recursive: true });
    }
  }
  return root;
}

const ENV = { XDG_RUNTIME_DIR: "/run/user/1" };

describe("startupProblems", () => {
  it("finds nothing wrong with a complete setup", () => {
    assert.deepEqual(startupProblems(ENV, "26.12.0", checkout("26.12.0", true)), []);
  });

  it("says when node is older than the pinned major", () => {
    const [p] = startupProblems(ENV, "22.1.0", checkout("26.12.0", true));
    assert.match(p ?? "", /node 22\.1\.0 is too old.*node 26 or newer/);
  });

  it("accepts a newer node than the pin", () => {
    assert.deepEqual(startupProblems(ENV, "28.0.0", checkout("26.12.0", true)), []);
  });

  it("tells the user to run npm install when dependencies are missing, instead of a module-not-found trace", () => {
    const root = checkout("26.12.0", false);
    const [p] = startupProblems(ENV, "26.12.0", root);
    assert.match(p ?? "", new RegExp(`dependencies are not installed.*pi-coding-agent.*npm install in ${root}`));
  });

  it("needs a private directory for the socket unless TORIEL_SOCK says where", () => {
    const root = checkout("26.12.0", true);
    assert.match(startupProblems({}, "26.12.0", root)[0] ?? "", /XDG_RUNTIME_DIR is not set/);
    assert.deepEqual(startupProblems({ TORIEL_SOCK: "/x/s.sock" }, "26.12.0", root), []);
  });

  it("reports every problem at once", () => {
    assert.equal(startupProblems({}, "20.0.0", checkout("26.12.0", false)).length, 3);
  });
});

describe("toriel entry point", () => {
  const run = (...args: string[]) => spawnSync(process.execPath, [ENTRY, ...args], { encoding: "utf8", env: { ...process.env, XDG_RUNTIME_DIR: "/run/user/1" } });

  it("prints usage for --help without opening the UI or starting a daemon", () => {
    const r = run("--help");
    assert.equal(r.status, 0);
    assert.match(r.stdout, /toriel kill-server/);
  });

  it("rejects an unknown argument", () => {
    const r = run("--bogus");
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown argument "--bogus"/);
  });
});
