// `npm run check` (ticket 340): which steps run, when the test lock is abandoned and taken over, what the summary prints, and
// how npm test classifies its arguments.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { acquireLock, chooseSteps, firstLine, LOCK_NAME, LOCK_STALE_MS, lockIsStale, MAX_FAILURES_SHOWN, pickLines, realDeps, readOwner, signalExitCode, TOKEN_NAME, type LockDeps, type LockOwner, testSummaryLines, type TestSummary } from "../scripts/check-lib.ts";
import checkReporter, { type EventData } from "../scripts/check-reporter.ts";
import { fileArgFrom, isTestFileArg, REPO_ROOT, resolveFileArg } from "../scripts/test-env.ts";

/** A provably dead pid: a child node process that has already exited (asserted dead, so a freak pid reuse fails loudly). */
const deadPid = async (): Promise<number> => {
  const child = spawn(process.execPath, ["-e", ""]);
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error("the child had no pid");
  }
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  if (realDeps.alive(pid)) {
    throw new Error("the fixture pid is somehow alive again");
  }
  return pid;
};

/** A temp dir for lock files, removed with the test: the real ~/.cache/toriel is never touched. */
const tempDir = (t: TestContext): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-check-lock-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** Seed a lock or token file in `dir` and return its path for the content assertions. */
const seedOwner = (dir: string, name: string, owner: LockOwner): string => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(owner));
  return file;
};

/** LockDeps that never sleep; wait doubles as a runaway guard so a buggy polling loop fails fast instead of hanging. */
function testDeps(over: Partial<LockDeps> = {}): LockDeps {
  let waits = 0;
  return {
    alive: realDeps.alive,
    now: realDeps.now,
    tell: () => {},
    wait: () => {
      waits += 1;
      if (waits > 100) {
        throw new Error("acquireLock is still polling after 100 loops");
      }
      return Promise.resolve();
    },
    ...over,
  };
}

describe("npm test's file arguments", () => {
  it("sees a test file argument but not a flag or a flag's value, so flags alone still run every file", () => {
    assert.equal(isTestFileArg("test/a.test.ts"), true);
    assert.equal(isTestFileArg("a.test.ts"), true);
    assert.equal(isTestFileArg("x.mjs"), true);
    assert.equal(isTestFileArg("--test-name-pattern=foo.ts"), false);
    assert.equal(isTestFileArg("--test-name-pattern"), false);
    assert.equal(isTestFileArg("-w"), false);
    assert.equal(isTestFileArg("test/a.test.ts", "-w"), true);
    // the space-separated documented form: the value rides on no dash, so the flag must consume it
    assert.equal(isTestFileArg("foo.ts", "--test-name-pattern"), false);
    assert.equal(isTestFileArg("foo.ts", "--test-reporter-destination"), false);
    assert.equal(isTestFileArg("foo.ts", "--test-concurrency"), false);
    assert.equal(isTestFileArg("foo.ts", "--test-name-pattern=foo.ts"), true);
  });

  it("does not count the token of a space-separated value-taking flag as a file either", () => {
    assert.equal(isTestFileArg("foo.ts", "--test-skip-pattern"), false);
    assert.equal(isTestFileArg("foo.ts", "--test-shard"), false);
    assert.equal(isTestFileArg("foo.ts", "--test-timeout"), false);
  });

  it("resolves a file argument from INIT_CWD when it exists there, and from the repo root otherwise", (t) => {
    assert.equal(fileArgFrom({ INIT_CWD: "/x" }, "/y"), "/x");
    assert.equal(fileArgFrom({}, "/y"), "/y");
    const outside = tempDir(t);
    fs.writeFileSync(path.join(outside, "probe.test.ts"), "");
    assert.equal(resolveFileArg("probe.test.ts", outside), path.relative(REPO_ROOT, path.join(outside, "probe.test.ts")));
    assert.equal(resolveFileArg("test/check.test.ts", outside), "test/check.test.ts");
    assert.equal(resolveFileArg("test/check.test.ts", REPO_ROOT), "test/check.test.ts");
  });
});

describe("the check reporter", () => {
  const summaryOf = async (events: Array<{ type: string; data: EventData }>): Promise<TestSummary> => {
    const source = async function* (): AsyncGenerator<{ type: string; data: EventData }> {
      for (const e of events) {
        yield e;
      }
    };
    let out = "";
    for await (const line of checkReporter(source())) {
      out += line;
    }
    return JSON.parse(out) as TestSummary;
  };

  it("counts a failing todo test as skipped, as node --test treats it (it exits 0 there)", async () => {
    const fail = (todo: unknown): Array<{ type: string; data: EventData }> => [
      { type: "test:start", data: { file: "/r/test/a.test.ts", name: "t", nesting: 0, todo } },
      { type: "test:fail", data: { file: "/r/test/a.test.ts", name: "t", nesting: 0, todo, details: { error: { message: "boom" } } } },
    ];
    const todo = await summaryOf(fail("not finished yet"));
    assert.equal(todo.failed, 0);
    assert.equal(todo.skipped, 1);
    assert.deepEqual(todo.failures, []);
    const plain = await summaryOf(fail(false));
    assert.equal(plain.failed, 1);
    assert.equal(plain.skipped, 0);
    assert.equal(plain.failures[0]?.message, "boom");
  });
});

describe("which steps a check runs", () => {
  it("runs everything by default, only the tests for named files or a name pattern, and only the named steps when given", () => {
    assert.deepEqual(chooseSteps({}, [], undefined), ["typecheck", "lint", "tests"]);
    assert.deepEqual(chooseSteps({}, ["test/a.test.ts"], undefined), ["tests"]);
    assert.deepEqual(chooseSteps({}, [], "x"), ["tests"]);
    assert.deepEqual(chooseSteps({ lint: true, typecheck: true }, ["test/a.test.ts"], undefined), ["typecheck", "lint"]);
  });
});

describe("the test lock", () => {
  const now = 1_800_000_000_000;
  it("holds while its process lives, and is abandoned when the process is gone, the file unreadable, or it is too old", () => {
    const owner = { pid: 42, root: "/r", startedAt: now - 1000 };
    assert.equal(lockIsStale(owner, () => true, now), false);
    assert.equal(lockIsStale(owner, () => false, now), true);
    assert.equal(lockIsStale(undefined, () => true, now), true);
    assert.equal(lockIsStale({ ...owner, startedAt: now - LOCK_STALE_MS - 1 }, () => true, now), true);
  });
});

describe("the lock takeover", () => {
  const FRESH = Date.now();

  it("takes over a lock whose owner is dead, removing the old file and leaving nothing else behind", async (t) => {
    const dir = tempDir(t);
    seedOwner(dir, LOCK_NAME, { pid: await deadPid(), root: "/old", startedAt: FRESH });
    const release = await acquireLock(dir, "/new", testDeps({ now: () => FRESH }));
    assert.deepEqual(readOwner(path.join(dir, LOCK_NAME)), { pid: process.pid, root: "/new", startedAt: FRESH });
    assert.deepEqual(fs.readdirSync(dir), [LOCK_NAME]);
    release();
    assert.equal(fs.existsSync(path.join(dir, LOCK_NAME)), false);
  });

  it("waits for a lock whose owner is alive and never touches the file", async (t) => {
    const dir = tempDir(t);
    const owner = { pid: 424242, root: "/live", startedAt: FRESH - 1000 };
    seedOwner(dir, LOCK_NAME, owner);
    const told: string[] = [];
    await assert.rejects(acquireLock(dir, "/new", testDeps({ alive: () => true, now: () => FRESH, tell: (m) => told.push(m) })));
    assert.deepEqual(readOwner(path.join(dir, LOCK_NAME)), owner);
    assert.deepEqual(fs.readdirSync(dir), [LOCK_NAME]);
    assert.deepEqual(told, ["waiting for another test run to finish (pid 424242, /live)"]);
  });

  it("waits instead of taking over while another live process holds the takeover token", async (t) => {
    const dir = tempDir(t);
    const lockOwner = { pid: await deadPid(), root: "/dead", startedAt: FRESH };
    const tokenOwner = { pid: process.pid, root: "/taker", startedAt: FRESH };
    seedOwner(dir, LOCK_NAME, lockOwner);
    seedOwner(dir, TOKEN_NAME, tokenOwner);
    await assert.rejects(acquireLock(dir, "/new", testDeps({ alive: (p) => p === process.pid, now: () => FRESH })));
    assert.deepEqual(readOwner(path.join(dir, LOCK_NAME)), lockOwner);
    assert.deepEqual(readOwner(path.join(dir, TOKEN_NAME)), tokenOwner);
    assert.deepEqual(fs.readdirSync(dir).sort(), [LOCK_NAME, TOKEN_NAME]);
  });

  it("clears a token whose holder is dead and then takes the lock", async (t) => {
    const dir = tempDir(t);
    seedOwner(dir, TOKEN_NAME, { pid: await deadPid(), root: "/crashed", startedAt: FRESH });
    const release = await acquireLock(dir, "/new", testDeps({ now: () => FRESH }));
    assert.deepEqual(readOwner(path.join(dir, LOCK_NAME)), { pid: process.pid, root: "/new", startedAt: FRESH });
    assert.deepEqual(fs.readdirSync(dir), [LOCK_NAME]);
    release();
    assert.equal(fs.existsSync(path.join(dir, LOCK_NAME)), false);
  });

  it("releases the lock only while it still names this pid", async (t) => {
    const dir = tempDir(t);
    const file = path.join(dir, LOCK_NAME);
    const release = await acquireLock(dir, "/new", testDeps());
    fs.writeFileSync(file, JSON.stringify({ pid: 424243, root: "/other", startedAt: FRESH }));
    release();
    assert.equal(readOwner(file)?.pid, 424243);
  });
});

describe("a killed run's exit code", () => {
  it("follows the shell convention of 128 + the signal number", () => {
    assert.equal(signalExitCode("SIGINT"), 130);
    assert.equal(signalExitCode("SIGTERM"), 143);
    assert.equal(signalExitCode("SIGHUP"), 129);
  });
});

describe("the summary", () => {
  it("says ok with the counts when everything passed", () => {
    assert.deepEqual(testSummaryLines({ passed: 5, failed: 0, skipped: 1, failures: [] }, 0, 3), ["tests: ok - 5 passed, 0 failed, 1 skipped (3s)"]);
  });

  it("names each failure with its file, suites and first message line, and caps the list", () => {
    const failures = Array.from({ length: MAX_FAILURES_SHOWN + 2 }, (_, i) => ({ file: "test/a.test.ts", path: ["suite", `t${i}`], message: "1 !== 2" }));
    const lines = testSummaryLines({ passed: 1, failed: failures.length, skipped: 0, failures }, 1, 2);
    assert.equal(lines[0], `tests: FAILED - 1 passed, ${failures.length} failed (2s)`);
    assert.equal(lines[1], "  FAIL test/a.test.ts > suite > t0");
    assert.equal(lines[2], "       1 !== 2");
    assert.equal(lines.at(-1), "  ... and 2 more in the log");
  });

  it("points at the log when the runner failed without a failed test (a file crashed)", () => {
    const lines = testSummaryLines({ passed: 3, failed: 0, skipped: 0, failures: [] }, 1, 1);
    assert.match(lines[0] ?? "", /FAILED/);
    assert.match(lines[1] ?? "", /crashed/);
  });

  it("keeps only the matching lines of tool output, and the first line of a message", () => {
    assert.deepEqual(pickLines("x\nsrc/a.ts(1,2): error TS2322: no\ny", /error TS\d+/), ["src/a.ts(1,2): error TS2322: no"]);
    assert.deepEqual(pickLines("e1\ne2\ne3", /e/, 2), ["e1", "e2", "... and 1 more in the log"]);
    assert.equal(firstLine("\n  Expected values to be strictly equal:\n\n1 !== 2\n"), "Expected values to be strictly equal: 1 !== 2");
    assert.equal(firstLine("boom\n    at x"), "boom");
  });
});
