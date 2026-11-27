// Where the sandbox tests build their fixture trees, and whether they can. The sandbox hides /tmp, so the trees live in
// /var/tmp; inside a toriel sandbox /var/tmp is read-only (ticket 203). The test runner drops TORIEL_SANDBOX from the test
// process (ticket 339), so the env var cannot say whether we are in one: try a write instead (ticket 344).
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The directory fixture trees go under: /var/tmp when there is one (not under /tmp, which the sandbox hides). */
export const FIXTURE_BASE = existsSync("/var/tmp") ? "/var/tmp" : tmpdir();

/** The errno code when a directory cannot be created under `dir`, or false when it can. */
export function mkdirFailureUnder(dir: string): string | false {
  try {
    rmSync(mkdtempSync(join(dir, "toriel-probe-")), { recursive: true, force: true });
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    return typeof code === "string" ? code : "UNKNOWN";
  }
}

const NOT_WRITABLE = `this test builds sandbox fixtures under ${FIXTURE_BASE}, which is not writable here`;
const PROBE = mkdirFailureUnder(FIXTURE_BASE);
/** The skip reason for a test that builds fixtures under FIXTURE_BASE, or false when it can run. EROFS is what a read-only
 * mount (a toriel sandbox's /var/tmp, ticket 203) gives; any other failure is unexpected and names its own code. */
export const FIXTURE_SKIP: string | false = PROBE === false
  ? false
  : PROBE === "EROFS"
    ? `${NOT_WRITABLE} (inside a toriel sandbox it is read-only)`
    : `${NOT_WRITABLE} (the probe failed with ${PROBE})`;
