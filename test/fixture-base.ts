// Where the sandbox tests build their fixture trees, and whether they can. The sandbox hides /tmp, so the trees live in
// /var/tmp; inside a toriel sandbox /var/tmp is read-only (ticket 203). The test runner drops TORIEL_SANDBOX from the test
// process (ticket 339), so the env var cannot say whether we are in one: try a write instead (ticket 344).
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The directory fixture trees go under: /var/tmp when there is one (not under /tmp, which the sandbox hides). */
export const FIXTURE_BASE = existsSync("/var/tmp") ? "/var/tmp" : tmpdir();

/** Whether a directory can be created under `dir`; false on EROFS, EACCES and the like. */
export function canMakeDirUnder(dir: string): boolean {
  try {
    rmSync(mkdtempSync(join(dir, "toriel-probe-")), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** The skip reason for a test that builds fixtures under FIXTURE_BASE, or false when it can run. */
export const FIXTURE_SKIP: string | false = canMakeDirUnder(FIXTURE_BASE) ? false : `this test builds sandbox fixtures under ${FIXTURE_BASE}, which is not writable here (inside a toriel sandbox it is read-only)`;
