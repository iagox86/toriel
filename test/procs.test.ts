import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const PROCS = path.join(import.meta.dirname, "..", "pi", "skills", "toriel", "procs");
const run = (...args: string[]) => spawnSync("sh", [PROCS, ...args], { encoding: "utf8" });

const kids: ChildProcess[] = [];
after(() => {
  for (const k of kids) {
    k.kill();
  }
});

/** A process that sleeps, started with `args` visible in its real command line. */
function sleeper(...args: string[]): ChildProcess {
  const k = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", "--", ...args], { stdio: "ignore" });
  kids.push(k);
  return k;
}

describe("procs (ticket 70)", () => {
  it("finds a process by its full command line, one line with pid, ppid, age, user and the whole argv", () => {
    const k = sleeper("--marker-70-alpha", "two words");
    const r = run("marker-70-alpha");
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.trim().split("\n");
    assert.equal(lines.length, 1, "exactly the sleeper: not procs itself, not the shell that ran it");
    const [pid, ppid, age, , ...cmd] = (lines[0] as string).split(" ");
    assert.equal(Number(pid), k.pid);
    assert.equal(Number(ppid), process.pid);
    assert.match(age as string, /^\d+[dhms]/);
    assert.match(cmd.join(" "), /--marker-70-alpha two words$/);
  });

  it("finds nothing, successfully, for a pattern nothing matches", () => {
    const r = run("no-such-process-70-zzz");
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  });

  it("matches case-insensitively only with -i", () => {
    sleeper("--Marker-70-Beta");
    assert.equal(run("marker-70-beta").stdout, "");
    assert.equal(run("-i", "marker-70-beta").stdout.trim().split("\n").length, 1);
  });

  it("--leak lists pi-related processes by age and leaves out the young ones", () => {
    const k = sleeper("fake-pi.mjs", "70-leak");
    const all = run("--leak", "0").stdout;
    assert.ok(all.split("\n").some((l) => l.startsWith(`${k.pid} `)), "a fake pi is listed");
    assert.ok(!run("--leak", "1").stdout.split("\n").some((l) => l.startsWith(`${k.pid} `)), "a process seconds old is not older than an hour");
  });

  it("rejects an unknown option", () => {
    const r = run("--bogus");
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown option/);
  });
});
