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
    assert.match(r.stdout, /toriel doctor/);
  });

  it("runs doctor, whose --help needs no daemon and no pi setup", () => {
    const r = run("doctor", "--help");
    assert.equal(r.status, 0);
    assert.match(r.stdout, /usage: toriel doctor \[--fix\] \[--yes\]/);
  });

  it("exits 1 from doctor with a readable report when pi is not set up, without touching anything", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-doc-home-"));
    try {
      const r = spawnSync(process.execPath, [ENTRY, "doctor"], { encoding: "utf8", env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: path.join(home, "no-pi"), XDG_RUNTIME_DIR: "/run/user/1", XDG_CONFIG_HOME: path.join(home, "cfg") } });
      assert.equal(r.status, 1);
      assert.match(r.stdout, /PROBLEM {2}pi is set up[\s\S]*pi has no config at .*no-pi: run pi once and log in/);
      assert.deepEqual(fs.readdirSync(home), [], "doctor wrote nothing");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("still explains itself when the dependencies are missing: the checks that need them are skipped, not crashed", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-doc-bare-"));
    try {
      fs.mkdirSync(path.join(root, "src"));
      for (const f of ["toriel.ts", "src/preflight.ts", "src/doctor-cli.ts"]) {
        fs.copyFileSync(path.join(import.meta.dirname, "..", f), path.join(root, f));
      }
      fs.writeFileSync(path.join(root, ".nvmrc"), "20\n");
      const r = spawnSync(process.execPath, [path.join(root, "toriel.ts"), "doctor"], { encoding: "utf8", env: { ...process.env, XDG_RUNTIME_DIR: "/run/user/1" } });
      assert.equal(r.status, 1);
      assert.match(r.stdout, /PROBLEM {2}dependencies are not installed \(.*commander.*\): run npm install/);
      assert.match(r.stdout, /Fix these first/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an unknown argument", () => {
    const r = run("--bogus");
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown argument "--bogus"/);
  });
});
