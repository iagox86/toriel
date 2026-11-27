// What a test run must not inherit from a surrounding toriel session (ticket 339), and the test files to run. Shared by
// scripts/test.ts (`npm test`), scripts/check.ts (`npm run check`) and the daemon harness in test/helpers.ts.
import * as fs from "node:fs";
import * as path from "node:path";
import { CHILD_ENV_KEYS } from "../src/child-env.ts";

/**
 * What a daemon hands its children (scope, sandbox, socket, delegation: CHILD_ENV_KEYS), plus TORIEL_PROFILE (an isolated
 * instance) and the `toriel --timing` switches a daemon inherits from the controller. A test run inside a toriel session
 * inherits them and must not act on them: sandbox tests would see the session's sandbox, and test daemons would write to the
 * real timing.jsonl (ticket 225). Unit tests import src modules that read some of these at import time, so the runner drops
 * them from the test process itself, not only from the daemons the harness spawns.
 */
export const SESSION_ENV: readonly string[] = [...CHILD_ENV_KEYS, "TORIEL_PROFILE", "TORIEL_TIMING", "TORIEL_TIMING_MS", "TORIEL_TIMING_FILE"];

/** `env` without the variables a surrounding toriel session set. */
export function withoutSessionEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const k of SESSION_ENV) {
    delete clean[k];
  }
  return clean;
}

/** The repository root (this file lives in `<root>/scripts`). */
export const REPO_ROOT = path.resolve(import.meta.dirname, "..");

/** Every test file, relative to the root: test/*.test.ts, not a recursive search (a checkout can hold worktrees under .claude/). */
export function allTestFiles(root: string = REPO_ROOT): string[] {
  return fs
    .readdirSync(path.join(root, "test"))
    .filter((f) => f.endsWith(".test.ts"))
    .sort()
    .map((f) => path.join("test", f));
}

/**
 * Value-taking flags whose next token must not count as a test file: the runner's own (pattern, reporter, shard, concurrency,
 * timeout) plus ones whose values can carry a path - a module to preload (`--import`, `-r`/`--require`), a coverage rule
 * (`--test-coverage-include/exclude`), a setup or state file (`--test-global-setup`, `--test-rerun-failures`) or an env file
 * (`--env-file`, `--env-file-if-exists`). The `=value` form rides on its dash and needs no looking ahead.
 */
const VALUE_FLAGS = [
  "--test-name-pattern",
  "--test-skip-pattern",
  "--test-reporter",
  "--test-reporter-destination",
  "--test-shard",
  "--test-concurrency",
  "--test-timeout",
  "--import",
  "-r",
  "--require",
  "--test-coverage-include",
  "--test-coverage-exclude",
  "--test-global-setup",
  "--test-rerun-failures",
  "--env-file",
  "--env-file-if-exists",
];

/**
 * Whether a `npm test` argument names a test file: not a flag, not the token after a value-taking one (space-separated
 * `--test-name-pattern foo.ts` must not count foo.ts as a file), and matching a script/test extension, so flags alone
 * still run every file.
 */
export function isTestFileArg(a: string, prev?: string): boolean {
  if (prev !== undefined && VALUE_FLAGS.includes(prev)) {
    return false;
  }
  return !a.startsWith("-") && /\.(test\.)?[cm]?[jt]s$/.test(a);
}

/** Where a file argument resolves from: INIT_CWD, where the user (or agent) ran npm, or the process cwd without it. */
export function fileArgFrom(env: NodeJS.ProcessEnv, cwd: string): string {
  return env.INIT_CWD ?? cwd;
}

/** A file argument as a path relative to the root: resolved from `from` when the file exists there, from the root otherwise. */
export function resolveFileArg(f: string, from: string, root: string = REPO_ROOT): string {
  const own = path.resolve(from, f);
  return path.relative(root, fs.existsSync(own) ? own : path.resolve(root, f));
}
