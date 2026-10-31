// One daemon per toriel state directory. The lock is a pidfile in that
// directory (not next to the socket), so a daemon started with another socket
// name or after a rename still finds the live one instead of running beside it
// and sharing, and corrupting, the same state files.
import * as fs from "node:fs";
import * as path from "node:path";

/** True when `pid` is a live toriel daemon (not a recycled pid belonging to something else). */
export function isDaemonProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("daemon.ts");
  } catch {
    return true; // no /proc: a live pid is the best evidence there is
  }
}

/** The pid recorded in the lock file, if there is one. */
export function lockedPid(file: string): number | undefined {
  try {
    const pid = Number.parseInt(fs.readFileSync(file, "utf8").trim(), 10);
    return Number.isNaN(pid) ? undefined : pid;
  } catch {
    return undefined;
  }
}

/** The live daemon that holds the lock, if any. */
export function runningDaemon(file: string, alive = isDaemonProcess): number | undefined {
  const pid = lockedPid(file);
  return pid !== undefined && alive(pid) ? pid : undefined;
}

export type LockResult = { acquired: true } | { acquired: false; pid: number };

/** Take the lock for `pid`; a lock left by a dead daemon is replaced. */
export function acquireDaemonLock(file: string, pid = process.pid, alive = isDaemonProcess): LockResult {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(file, `${pid}\n`, { flag: "wx", mode: 0o600 });
      return { acquired: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
    }
    const holder = lockedPid(file);
    if (holder !== undefined && holder !== pid && alive(holder)) {
      return { acquired: false, pid: holder };
    }
    fs.rmSync(file, { force: true }); // stale: its daemon is gone
  }
  throw new Error(`could not take the daemon lock ${file}`);
}

/** Give the lock back, but only if it is still ours. */
export function releaseDaemonLock(file: string, pid = process.pid): void {
  if (lockedPid(file) === pid) {
    fs.rmSync(file, { force: true });
  }
}
