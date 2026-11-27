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
