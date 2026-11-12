// The file watcher behind "on change" schedules (src/file-watch.ts): real inotify for what only the
// kernel can show (bursts, atomic saves, directories), fake dependencies for timing and for a
// directory replaced under the watch.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { FileWatcher, MAX_WAIT_MS, type WatchDeps, type WatchSpec } from "../src/file-watch.ts";

const until = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) {
      throw new Error("timed out waiting");
    }
    await new Promise((r) => setTimeout(r, 10));
  }
};
const quiet = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("watching real files", () => {
  let dir: string;
  let w: FileWatcher;
  let fired: number;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "toriel-watch-"));
    w = new FileWatcher();
    fired = 0;
  });
  afterEach(() => {
    w.closeAll();
    rmSync(dir, { recursive: true, force: true });
  });
  const file = (events: WatchSpec["events"] = "write", name = "review.md"): WatchSpec => ({ path: join(dir, name), dir: false, events, cooldownMs: 80 });
  const arm = (spec: WatchSpec, id = 1) => w.arm(id, spec, () => void fired++);

  it("fires once for a burst of writes to a file that did not exist yet", async () => {
    arm(file());
    for (let i = 0; i < 5; i++) {
      appendFileSync(join(dir, "review.md"), `line ${i}\n`);
      await quiet(5);
    }
    await until(() => fired > 0);
    await quiet(250);
    assert.equal(fired, 1, "one save, one fire");
    appendFileSync(join(dir, "review.md"), "later\n");
    await until(() => fired === 2);
  });

  it("ignores other files in the same directory", async () => {
    arm(file());
    writeFileSync(join(dir, "other.md"), "x");
    writeFileSync(join(dir, "review.md.swp"), "x");
    await quiet(300);
    assert.equal(fired, 0);
  });

  it("sees an atomic save: a temp file renamed over the target", async () => {
    writeFileSync(join(dir, "review.md"), "old");
    arm(file());
    writeFileSync(join(dir, ".review.md.tmp"), "new");
    renameSync(join(dir, ".review.md.tmp"), join(dir, "review.md"));
    await until(() => fired === 1);
    // and the watch is still alive after the inode behind the name changed
    writeFileSync(join(dir, ".review.md.tmp"), "newer");
    renameSync(join(dir, ".review.md.tmp"), join(dir, "review.md"));
    await until(() => fired === 2);
  });

  it("counts a deletion only when it was asked for", async () => {
    writeFileSync(join(dir, "review.md"), "x");
    arm(file("write"));
    rmSync(join(dir, "review.md"));
    await quiet(300);
    assert.equal(fired, 0, "events write: a deletion is not a change worth a prompt");
    w.disarm(1);
    writeFileSync(join(dir, "review.md"), "x");
    arm(file("any"));
    rmSync(join(dir, "review.md"));
    await until(() => fired === 1);
  });

  it("watches a directory: anything directly inside it counts", async () => {
    arm({ path: dir, dir: true, events: "write", cooldownMs: 80 });
    writeFileSync(join(dir, "a.txt"), "x");
    await until(() => fired === 1);
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "deep.txt"), "x");
    await quiet(300);
    assert.equal(fired, 2, "the new subdirectory is a change; what is inside it is not watched (not recursive)");
  });

  it("stops when disarmed, and a pending burst does not fire afterwards", async () => {
    arm(file());
    writeFileSync(join(dir, "review.md"), "x");
    w.disarm(1);
    await quiet(300);
    assert.equal(fired, 0);
    assert.equal(w.has(1), false);
  });

  it("refuses a directory that does not exist, saying so", () => {
    assert.throws(() => w.arm(1, { path: join(dir, "nope", "f"), dir: false, events: "write", cooldownMs: 50 }, () => {}), /nope does not exist/);
  });

  it("re-arming an id replaces its watch instead of doubling it", async () => {
    arm(file());
    arm(file());
    assert.equal(w.size, 1);
    writeFileSync(join(dir, "review.md"), "x");
    await until(() => fired >= 1);
    await quiet(250);
    assert.equal(fired, 1);
  });
});

/** A watcher whose clock, timers and filesystem the test drives. */
function fake() {
  let t = 0;
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  const watchers: Array<{ dir: string; emit: (event: string, name: string | null) => void; closed: boolean; fail: (e: Error) => void }> = [];
  const present = new Set<string>();
  const inodes = new Map<string, number>();
  const deps: WatchDeps = {
    watch: (dir, listener) => {
      let onError: (e: Error) => void = () => {};
      const w = { dir, closed: false, emit: (event: string, name: string | null) => !w.closed && listener(event, name), fail: (e: Error) => onError(e) };
      watchers.push(w);
      return {
        close: () => {
          w.closed = true;
        },
        on: (_event, l) => {
          onError = l;
        },
      };
    },
    exists: (p) => present.has(p),
    inode: (p) => inodes.get(p),
    now: () => t,
    setTimer: (fn, ms) => {
      const e = { at: t + ms, fn, live: true };
      timers.push(e);
      return e;
    },
    clearTimer: (h) => {
      (h as { live: boolean }).live = false;
    },
  };
  const advance = (ms: number) => {
    const end = t + ms;
    for (;;) {
      const next = timers.filter((x) => x.live && x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (next === undefined) {
        break;
      }
      t = next.at;
      next.live = false;
      next.fn();
    }
    t = end;
  };
  return { deps, advance, watchers, present, inodes, now: () => t };
}

describe("the watcher's timing and recovery", () => {
  const spec: WatchSpec = { path: "/d/f", dir: false, events: "write", cooldownMs: 1000 };

  it("fires once, a cooldown after the last event of a burst", () => {
    const f = fake();
    f.present.add("/d/f");
    const w = new FileWatcher(f.deps);
    let fired = 0;
    w.arm(1, spec, () => void fired++);
    f.watchers[0]?.emit("change", "f");
    f.advance(600);
    f.watchers[0]?.emit("change", "f");
    f.advance(600);
    assert.equal(fired, 0, "the second event restarted the quiet time");
    f.advance(500);
    assert.equal(fired, 1);
    f.advance(10_000);
    assert.equal(fired, 1);
  });

  it("still fires a burst that never goes quiet, once the maximum wait is reached", () => {
    const f = fake();
    f.present.add("/d/f");
    const w = new FileWatcher(f.deps);
    let fired = 0;
    w.arm(1, spec, () => void fired++);
    for (let i = 0; i < (MAX_WAIT_MS / 500) + 4; i++) {
      f.watchers[0]?.emit("change", "f");
      f.advance(500);
    }
    assert.ok(fired >= 1, "a file written without pause is not starved forever");
    assert.ok(f.now() <= MAX_WAIT_MS + 3000);
  });

  it("treats a rename of a missing file as a deletion, and a present one as a creation", () => {
    const f = fake();
    const w = new FileWatcher(f.deps);
    let fired = 0;
    w.arm(1, spec, () => void fired++);
    f.watchers[0]?.emit("rename", "f"); // not present
    f.advance(2000);
    assert.equal(fired, 0);
    f.present.add("/d/f");
    f.watchers[0]?.emit("rename", "f");
    f.advance(2000);
    assert.equal(fired, 1);
  });

  it("an unnamed event in directory mode counts, in file mode it is judged by the file", () => {
    const f = fake();
    f.present.add("/d/f");
    const w = new FileWatcher(f.deps);
    let fired = 0;
    w.arm(1, { path: "/d", dir: true, events: "write", cooldownMs: 100 }, () => void fired++);
    f.watchers[0]?.emit("change", null);
    f.advance(200);
    assert.equal(fired, 1);
  });

  it("re-arms when the directory was replaced (a new inode), and reports one that is gone", () => {
    const f = fake();
    f.inodes.set("/d", 10);
    f.present.add("/d/f");
    const w = new FileWatcher(f.deps);
    let fired = 0;
    w.arm(1, spec, () => void fired++);
    assert.equal(w.check(1), true);
    assert.equal(f.watchers.length, 1, "same inode: nothing to do");
    f.inodes.set("/d", 11);
    assert.equal(w.check(1), true);
    assert.equal(f.watchers.length, 2, "a new inode gets a new watch");
    assert.equal(f.watchers[0]?.closed, true);
    f.watchers[1]?.emit("change", "f");
    f.advance(2000);
    assert.equal(fired, 1, "the callback survived the re-arm");
    f.inodes.delete("/d");
    assert.equal(w.check(1), false, "the directory is gone");
  });

  it("drops a watch that dies on its own and says why", () => {
    const f = fake();
    const w = new FileWatcher(f.deps);
    const errors: string[] = [];
    w.arm(1, spec, () => {}, (m) => errors.push(m));
    f.watchers[0]?.fail(new Error("boom"));
    assert.deepEqual(errors, ["boom"]);
    assert.equal(w.has(1), false);
  });
});
