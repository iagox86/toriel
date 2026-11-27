import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";

const PROCS = path.join(import.meta.dirname, "..", "pi", "skills", "toriel", "procs");
const run = (...args: string[]) => spawnSync("sh", [PROCS, ...args], { encoding: "utf8" });

// Unique per run: a sleeper left over from another run (an overlapping gate in a parallel worktree) must not match this
// run's patterns (tickets 327, 329). Lowercase, so the case-sensitivity test controls the case of the marker itself.
const RUN = `${process.pid}-${randomBytes(4).toString("hex")}`;

const kids: ChildProcess[] = [];
// Killed after each test, not once at the end of the file: a sleeper must not outlast the test that made it.
afterEach(() => {
  for (const k of kids.splice(0)) {
    k.kill();
  }
});

/** A process that sleeps, started with `args` visible in its real command line. */
function sleeper(...args: string[]): ChildProcess {
  const k = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", "--", ...args], { stdio: "ignore" });
  // The handle must not hold the test file's process open: that is what kept sleepers alive past their run.
  k.unref();
  kids.push(k);
  return k;
}

describe("procs (ticket 70)", () => {
  it("finds a process by its full command line, one line with pid, ppid, age, user and the whole argv", () => {
    const k = sleeper(`--marker-70-alpha-${RUN}`, "two words");
    const r = run(`marker-70-alpha-${RUN}`);
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.trim().split("\n");
    assert.equal(lines.length, 1, "exactly the sleeper: not procs itself, not the shell that ran it");
    const [pid, ppid, age, , ...cmd] = (lines[0] as string).split(" ");
    assert.equal(Number(pid), k.pid);
    assert.equal(Number(ppid), process.pid);
    assert.match(age as string, /^\d+[dhms]/);
    assert.match(cmd.join(" "), new RegExp(`--marker-70-alpha-${RUN} two words$`));
  });

  it("finds nothing, successfully, for a pattern nothing matches", () => {
    // per run too: a concurrent run's own `procs <pattern>` is a matching process
    const r = run(`no-such-process-70-zzz-${RUN}`);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  });

  it("matches case-insensitively only with -i", () => {
    sleeper(`--Marker-70-Beta-${RUN}`);
    assert.equal(run(`marker-70-beta-${RUN}`).stdout, "");
    assert.equal(run("-i", `marker-70-beta-${RUN}`).stdout.trim().split("\n").length, 1);
  });

  it("--leak lists pi-related processes by age and leaves out the young ones", () => {
    const k = sleeper("fake-pi.mjs", "70-leak");
    const all = run("--leak", "0").stdout;
    assert.ok(all.split("\n").some((l) => l.startsWith(`${k.pid} `)), "a fake pi is listed");
    assert.ok(!run("--leak", "1").stdout.split("\n").some((l) => l.startsWith(`${k.pid} `)), "a process seconds old is not older than an hour");
  });

  it("--leak leaves out the user's own tools: a process that merely mentions cli.js or the toriel directory is not a leak", () => {
    const own = sleeper("/x/node_modules/pi-other/cli.js", "-C", "/home/me/projects/toriel", "70-own-tools");
    const real = sleeper("/x/node_modules/@earendil-works/pi-coding-agent/dist/cli.js", "70-real-pi");
    const script = sleeper("/x/toriel/src/daemon.ts", "70-daemon");
    const listed = run("--leak", "0").stdout.split("\n");
    assert.ok(!listed.some((l) => l.startsWith(`${own.pid} `)), "cli.js of another package and a repo-dir argument");
    assert.ok(listed.some((l) => l.startsWith(`${real.pid} `)), "pi-coding-agent's cli.js");
    assert.ok(listed.some((l) => l.startsWith(`${script.pid} `)), "daemon.ts as a script argument");
  });

  it("takes -- before a pattern that starts with a dash, and --leak takes only whole hours", () => {
    sleeper("--", `-dash-marker-70-${RUN}`);
    assert.equal(run("--", `-dash-marker-70-${RUN}`).stdout.trim().split("\n").length, 1);
    const r = run("--leak", "1.5");
    assert.equal(r.status, 2);
    assert.match(r.stderr, /whole number of hours/);
    assert.equal(run("--leak").status, 0, "--leak alone is the default 12 hours");
  });

  it("rejects an unknown option", () => {
    const r = run("--bogus");
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown option/);
  });
});
