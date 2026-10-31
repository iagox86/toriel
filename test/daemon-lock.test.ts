import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { acquireDaemonLock, isDaemonProcess, lockedPid, releaseDaemonLock, runningDaemon } from "../src/daemon-lock.ts";

const lockFile = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "toriel-lock-")), "state", "daemon.pid");
const alive = (pids: number[]) => (pid: number) => pids.includes(pid);

describe("acquireDaemonLock", () => {
  it("takes a free lock, creating the directory, with the pid inside and owner-only permissions", () => {
    const file = lockFile();
    assert.deepEqual(acquireDaemonLock(file, 100, alive([])), { acquired: true });
    assert.equal(lockedPid(file), 100);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  it("refuses while the daemon that holds it is alive, naming its pid", () => {
    const file = lockFile();
    acquireDaemonLock(file, 100, alive([100]));
    assert.deepEqual(acquireDaemonLock(file, 200, alive([100])), { acquired: false, pid: 100 });
    assert.equal(lockedPid(file), 100, "the holder's lock is untouched");
  });

  it("replaces a lock left by a daemon that is gone", () => {
    const file = lockFile();
    acquireDaemonLock(file, 100, alive([]));
    assert.deepEqual(acquireDaemonLock(file, 200, alive([])), { acquired: true });
    assert.equal(lockedPid(file), 200);
  });

  it("replaces a lock file that holds garbage", () => {
    const file = lockFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "not a pid");
    assert.deepEqual(acquireDaemonLock(file, 200, alive([])), { acquired: true });
  });
});

describe("releaseDaemonLock", () => {
  it("removes the lock it holds but not one taken over by another daemon", () => {
    const file = lockFile();
    acquireDaemonLock(file, 100, alive([]));
    releaseDaemonLock(file, 200);
    assert.equal(lockedPid(file), 100);
    releaseDaemonLock(file, 100);
    assert.equal(lockedPid(file), undefined);
  });
});

describe("runningDaemon", () => {
  it("is the locked pid only while that process is alive", () => {
    const file = lockFile();
    assert.equal(runningDaemon(file, alive([100])), undefined);
    acquireDaemonLock(file, 100, alive([]));
    assert.equal(runningDaemon(file, alive([100])), 100);
    assert.equal(runningDaemon(file, alive([])), undefined);
  });
});

describe("isDaemonProcess", () => {
  it("is false for a pid that does not exist and for a live process that is not a daemon", () => {
    assert.equal(isDaemonProcess(2 ** 22 + 12345), false);
    assert.equal(isDaemonProcess(process.pid), false);
  });
});
