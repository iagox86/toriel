// The parts of `npm run check` (ticket 340) that need no child process: which steps to run, the lock and its takeover, and the summary lines.
import * as fs from "node:fs";
import * as path from "node:path";

export type Step = "typecheck" | "lint" | "tests";

export interface CheckArgs {
  steps: Step[];
  /** Test files to run instead of all of them. */
  files: string[];
  /** --name: run only the tests whose name matches. */
  name?: string;
}

/** Steps named with --typecheck/--lint/--tests run alone; named files or a --name mean tests only; otherwise everything. */
export function chooseSteps(flags: { typecheck?: boolean; lint?: boolean; tests?: boolean }, files: string[], name: string | undefined): Step[] {
  const named = (["typecheck", "lint", "tests"] as const).filter((s) => flags[s]);
  if (named.length > 0) {
    return [...named];
  }
  if (files.length > 0 || name !== undefined) {
    return ["tests"];
  }
  return ["typecheck", "lint", "tests"];
}

export interface LockOwner {
  pid: number;
  root: string;
  startedAt: number;
}

/** A lock older than this is taken as abandoned even if its pid is alive (a reused pid, or a hung run). */
export const LOCK_STALE_MS = 60 * 60_000;

/** Whether a found lock no longer holds: unreadable, its process gone, or too old. The same rule judges the takeover token. */
export function lockIsStale(owner: LockOwner | undefined, alive: (pid: number) => boolean, now: number): boolean {
  if (!owner || typeof owner.pid !== "number") {
    return true;
  }
  return !alive(owner.pid) || now - owner.startedAt > LOCK_STALE_MS;
}

/** The pid and clock a run needs to judge and take over a lock; `realDeps` reads the process, tests inject fakes. */
export interface LockDeps {
  /** Whether a pid is alive: a permission failure counts as alive (another user's pid is not ours to judge dead). */
  alive(pid: number): boolean;
  /** The clock for the age check. */
  now(): number;
  /** The pause between checks, `POLL_MS` in the runner. */
  wait(ms: number): Promise<void>;
  /** A message printed once when the run starts waiting for somebody else. */
  tell?(message: string): void;
}

/** The runner's deps: process.kill as the liveness oracle, a one-second pause, console.log. */
export const realDeps: LockDeps = {
  alive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  now: () => Date.now(),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  tell: (message) => console.log(message),
};

/** The lock dir's file names: LOCK_NAME as the mutex and TOKEN_NAME as the takeover token, one `LockOwner` payload each. */
export const LOCK_NAME = "check.lock";
export const TOKEN_NAME = "check.lock.takeover";

const POLL_MS = 1000;

function isErrno(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException).code === code;
}

/** The parsed payload of a lock or token file, or undefined when it is absent or unreadable. */
export function readOwner(file: string): LockOwner | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as LockOwner;
  } catch {
    return undefined;
  }
}

function sameOwner(a: LockOwner | undefined, b: LockOwner | undefined): boolean {
  return a !== undefined && b !== undefined && a.pid === b.pid && a.startedAt === b.startedAt;
}

function writeOwner(file: string, root: string, deps: LockDeps): void {
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, root, startedAt: deps.now() } satisfies LockOwner), { flag: "wx" });
}

/** Unlink the file only while it still names this pid: a file taken over by another run in the meantime is not ours to remove. */
function releaseOwner(file: string): void {
  if (readOwner(file)?.pid === process.pid) {
    fs.rmSync(file, { force: true });
  }
}

/**
 * Try to win the takeover token: exclusivity belongs to whichever process holds its own wx-created token file, so only the
 * token decides who may create or take over the lock (a rename race cannot hand the lock to two racers). A token owned by a
 * live, fresh process means a takeover is under way, so wait. A stale token (its holder died, or it is older than an hour,
 * leaving a crashed takeover behind) is renamed to a sidecar that is unlinked immediately - nothing stale accumulates - and
 * the wx-create is retried: its next winner, however late, is the exclusivity claim.
 */
function claimToken(tokenFile: string, root: string, deps: LockDeps): boolean {
  for (;;) {
    try {
      writeOwner(tokenFile, root, deps);
      return true;
    } catch (err) {
      if (!isErrno(err, "EEXIST")) {
        throw err;
      }
    }
    const owner = readOwner(tokenFile);
    if (owner && !lockIsStale(owner, deps.alive, deps.now())) {
      // someone else is taking over: wait for them to become the lock owner or clear their own token
      return false;
    }
    try {
      const sidecar = `${tokenFile}.stale-${process.pid}-${Math.random().toString(36).slice(2)}`;
      fs.renameSync(tokenFile, sidecar);
      fs.unlinkSync(sidecar);
    } catch (err) {
      if (!isErrno(err, "ENOENT")) {
        throw err;
      }
      // the token already vanished (another taker cleared it): retry the wx-create
    }
  }
}

/**
 * Take the machine-wide test lock in `dir`, waiting while another run holds it; resolves with a release function. The lock
 * is created or taken over only while this process holds its own token, and only when a fresh re-read of the lock shows it
 * gone or still the exact dead owner judged outside the token - so a lock a racer judged stale cannot silently gain a new
 * owner while it tries to take it. A runner killed while holding the lock leaves it stale (dead pid); the same rules take
 * that over. The token is released whatever path the takeover took, and only while it still names this pid.
 */
export async function acquireLock(dir: string, root: string, deps: LockDeps = realDeps): Promise<() => void> {
  fs.mkdirSync(dir, { recursive: true });
  const lockFile = path.join(dir, LOCK_NAME);
  const tokenFile = path.join(dir, TOKEN_NAME);
  let told = false;
  const note = (owner: LockOwner): void => {
    if (!told) {
      deps.tell?.(`waiting for another test run to finish (pid ${owner.pid}, ${owner.root})`);
      told = true;
    }
  };
  for (;;) {
    const judged = readOwner(lockFile);
    if (judged && !lockIsStale(judged, deps.alive, deps.now())) {
      // someone legitimately holds it: keep waiting
      note(judged);
      await deps.wait(POLL_MS);
      continue;
    }
    // the lock is absent or this dead (or aged) owner's file: try to win the exclusivity to create or take over
    if (!claimToken(tokenFile, root, deps)) {
      await deps.wait(POLL_MS);
      continue;
    }
    // exclusivity: until the token is released, only this process may create, remove or replace the lock
    try {
      const fresh = readOwner(lockFile);
      if (fresh !== undefined && !(sameOwner(judged, fresh) && lockIsStale(fresh, deps.alive, deps.now()))) {
        // present and not the exact dead owner judged: it changed or it is alive and young, never touch it
        note(fresh);
        await deps.wait(POLL_MS);
        continue;
      }
      if (fresh !== undefined) {
        try {
          fs.unlinkSync(lockFile);
        } catch (err) {
          if (!isErrno(err, "ENOENT")) {
            throw err;
          }
        }
      }
      try {
        writeOwner(lockFile, root, deps);
      } catch (err) {
        // cannot normally happen under exclusivity: fall back to polling instead of trusting the impossible
        if (isErrno(err, "EEXIST")) {
          continue;
        }
        throw err;
      }
      return () => releaseOwner(lockFile);
    } finally {
      releaseOwner(tokenFile);
    }
  }
}

/** The exit status for a killed run: the usual shell convention of 128 + the signal number. */
export function signalExitCode(signal: "SIGHUP" | "SIGINT" | "SIGTERM"): number {
  return 128 + { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }[signal];
}

/** One failed test as the reporter records it. */
export interface Failure {
  file?: string;
  /** Enclosing describe names, outermost first, then the test's own name. */
  path: string[];
  message: string;
}

export interface TestSummary {
  passed: number;
  failed: number;
  skipped: number;
  failures: Failure[];
}

/** At most this many failures are printed; the log has the rest. */
export const MAX_FAILURES_SHOWN = 15;

/** The lines `npm run check` prints for the test step. */
export function testSummaryLines(s: TestSummary, exitCode: number, seconds: number): string[] {
  const ok = exitCode === 0 && s.failed === 0;
  const lines = [`tests: ${ok ? "ok" : "FAILED"} - ${s.passed} passed, ${s.failed} failed${s.skipped > 0 ? `, ${s.skipped} skipped` : ""} (${seconds}s)`];
  for (const f of s.failures.slice(0, MAX_FAILURES_SHOWN)) {
    lines.push(`  FAIL ${[f.file, ...f.path].filter(Boolean).join(" > ")}`);
    if (f.message) {
      lines.push(`       ${f.message}`);
    }
  }
  if (s.failures.length > MAX_FAILURES_SHOWN) {
    lines.push(`  ... and ${s.failures.length - MAX_FAILURES_SHOWN} more in the log`);
  }
  if (!ok && s.failed === 0) {
    lines.push(`  node --test exited with ${exitCode} without a failed test: a file may have crashed; see the log`);
  }
  return lines;
}

/** The first `max` lines of `output` that match `pattern`: the error lines tsc or biome printed. */
export function pickLines(output: string, pattern: RegExp, max = 10): string[] {
  const hits = output.split("\n").filter((l) => pattern.test(l));
  return hits.length > max ? [...hits.slice(0, max), `... and ${hits.length - max} more in the log`] : hits;
}

/** The first line of an error message, trimmed to fit a terminal line; a lead-in ending in ":" (assert's "Expected values to be strictly equal:") takes the next line with it. */
export function firstLine(message: string, max = 200): string {
  const lines = message
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  let line = lines[0] ?? "";
  if (line.endsWith(":") && lines[1] !== undefined) {
    line = `${line} ${lines[1]}`;
  }
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}
