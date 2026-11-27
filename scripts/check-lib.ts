// The pure parts of `npm run check` (ticket 340): which steps to run, the lock's staleness, and the summary lines.

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

/** Whether a found lock no longer holds: unreadable, its process gone, or too old. */
export function lockIsStale(owner: LockOwner | undefined, alive: (pid: number) => boolean, now: number): boolean {
  if (!owner || typeof owner.pid !== "number") {
    return true;
  }
  return !alive(owner.pid) || now - owner.startedAt > LOCK_STALE_MS;
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
