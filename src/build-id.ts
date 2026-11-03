// Which toriel code a process is running, so a controller can tell when the
// daemon it reached is from another checkout (or older). The fingerprint is
// what is compared: a hash of the CONTENT of every source file the daemon and
// its pi children load, so two checkouts with the same code agree and an
// uncommitted edit shows. The label (git short hash, +dirty) is only for people.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { BuildInfo } from "./shared.ts";

const ROOT = path.join(import.meta.dirname, "..");
/** Folders whose .ts files are the running code: our modules, and the extensions every pi child loads with -e. */
const CODE_DIRS = ["src", "pi/extensions"];

function codeFiles(root: string): string[] {
  const files: string[] = [];
  for (const dir of CODE_DIRS) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(path.join(root, dir), { recursive: true, encoding: "utf8" });
    } catch {
      continue; // a checkout without that folder
    }
    for (const name of names) {
      if (name.endsWith(".ts")) {
        files.push(path.join(dir, name));
      }
    }
  }
  return files.sort();
}

/** Hash of path + content of every code file; "unknown" when none could be read. */
export function fingerprint(root = ROOT): string {
  const hash = createHash("sha256");
  let any = false;
  for (const file of codeFiles(root)) {
    try {
      hash.update(file).update("\0").update(fs.readFileSync(path.join(root, file))).update("\0");
      any = true;
    } catch {
      // vanished while hashing: the next start sees the real state
    }
  }
  return any ? hash.digest("hex").slice(0, 12) : "unknown";
}

/** "1fa724e" or "1fa724e+dirty" from git, undefined outside a checkout or without the git binary. */
export function gitLabel(root = ROOT): string | undefined {
  const run = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 2000 });
  const head = run(["rev-parse", "--short", "HEAD"]);
  if (head.status !== 0 || !head.stdout.trim()) {
    return undefined;
  }
  const status = run(["status", "--porcelain", "--", "src", "pi/extensions"]);
  const dirty = status.status === 0 && status.stdout.trim() !== "";
  return `${head.stdout.trim()}${dirty ? "+dirty" : ""}`;
}

/** What this checkout is now. A process calls it once at start and keeps the result: that describes the code it loaded, not the disk later. */
export function buildInfo(root = ROOT): BuildInfo {
  const print = fingerprint(root);
  return { fingerprint: print, label: gitLabel(root) ?? print, dir: root };
}
