import * as fs from "node:fs";
import * as path from "node:path";
import { LOG } from "./config.ts";

export function log(msg: string): void {
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
