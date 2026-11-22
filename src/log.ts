import * as fs from "node:fs";
import * as path from "node:path";
import { LOG } from "./config.ts";

export function log(msg: string): void {
  // a unit test running in-process (node --test sets NODE_TEST_CONTEXT) must not write into the user's real daemon.log, which /feedback
  // bundles and people read; a test that wants a log points TORIEL_LOG, XDG_STATE_HOME or a profile somewhere else, as the harness does
  if (process.env.NODE_TEST_CONTEXT && LOG === path.join(process.env.HOME ?? "", ".local", "state", "toriel", "daemon.log")) {
    return;
  }
  const line = `${new Date().toISOString()} ${msg}\n`;
  try {
    try {
      fs.appendFileSync(LOG, line);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
      fs.mkdirSync(path.dirname(LOG), { recursive: true }); // first line in a fresh state dir
      fs.appendFileSync(LOG, line);
    }
  } catch {
    // logging must never take the daemon down
  }
}
