// File watching for the "on change" schedules (board 98, docs/reference.md "File triggers"). One
// FileWatcher holds a node fs.watch (inotify on Linux, no dependency) per watch schedule and turns
// the raw event stream into at most one callback per burst. The traps it exists to avoid, each a
// real one:
//
//  - Atomic saves (vim, most tools) write a temp file and RENAME it over the target. A watch on the
//    file itself follows the old inode and misses that, so a file is watched through its PARENT
//    directory and filtered by name.
//  - One save is several inotify events (truncate, write, close, rename). The callback fires once,
//    after `cooldownMs` of quiet (watchman calls this the cooldown). A file written without a pause
//    still fires every MAX_WAIT_MS, so it cannot starve the watcher.
//  - A watched directory that is deleted or replaced silently stops delivering (no error), so
//    `check` compares the directory's inode with the one it armed on and re-arms.
//  - inotify does not wake a sleeping machine and does not replay what happened meanwhile: this is
//    live-only, by design (v1).
//
// Everything that touches the system (watch, stat, the clock) is injected, so the logic is tested
// without a real filesystem where that matters, and with one where it must.
import * as fs from "node:fs";
import * as path from "node:path";
import type { WatchEvents } from "./when.ts";
import { errText } from "./util.ts";

export interface WatchSpec {
  /** Absolute path of the file or directory. */
  path: string;
  /** true: the path is a directory and anything directly inside it counts; false: one file in its parent. */
  dir: boolean;
  events: WatchEvents;
  /** Quiet time after the last relevant event before the callback fires. */
  cooldownMs: number;
}

/** A burst that never goes quiet still fires after this long. */
export const MAX_WAIT_MS = 60_000;

interface FsWatcherLike {
  close(): void;
  on(event: "error", listener: (err: Error) => void): unknown;
}

export interface WatchDeps {
  watch(dir: string, listener: (event: string, filename: string | Buffer | null) => void): FsWatcherLike;
  exists(p: string): boolean;
  /** The inode of a directory, or undefined when it is gone. */
  inode(p: string): number | undefined;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export const systemWatchDeps: WatchDeps = {
  watch: (dir, listener) => fs.watch(dir, { persistent: false }, listener),
  exists: (p) => fs.existsSync(p),
  inode: (p) => {
    try {
      return fs.statSync(p).ino;
    } catch {
      return undefined;
    }
  },
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  },
  clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
};

interface Armed {
  spec: WatchSpec;
  /** The directory actually watched (the path itself, or the parent of a file). */
  dir: string;
  ino: number | undefined;
  watcher: FsWatcherLike;
  timer?: unknown;
  /** When the current burst began (undefined while quiet). */
  burstAt?: number;
  onChange: () => void;
}

/** The directory fs.watch is put on for a spec. */
export function watchedDir(spec: WatchSpec): string {
  return spec.dir ? spec.path : path.dirname(spec.path);
}

export class FileWatcher {
  private readonly armed = new Map<number, Armed>();
  private readonly deps: WatchDeps;

  constructor(deps: WatchDeps = systemWatchDeps) {
    this.deps = deps;
  }

  has(id: number): boolean {
    return this.armed.has(id);
  }

  specOf(id: number): WatchSpec | undefined {
    return this.armed.get(id)?.spec;
  }

  get size(): number {
    return this.armed.size;
  }

  /** The ids with a live watch. */
  ids(): number[] {
    return [...this.armed.keys()];
  }

  /**
   * Start (or restart) watching for `id`. `onChange` is called once per burst of relevant changes;
   * `onError` when the watch dies on its own (the directory vanished, a system limit). Throws when
   * the watch cannot be set up at all, with a message meant to be shown.
   */
  arm(id: number, spec: WatchSpec, onChange: () => void, onError: (message: string) => void = () => {}): void {
    this.disarm(id);
    const dir = watchedDir(spec);
    let watcher: FsWatcherLike;
    try {
      watcher = this.deps.watch(dir, (event, filename) => this.onEvent(id, event, filename));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      throw new Error(code === "ENOENT" ? `${dir} does not exist` : code === "ENOSPC" ? "the system's limit on file watches is reached (fs.inotify.max_user_watches)" : `cannot watch ${dir}: ${errText(err)}`);
    }
    const entry: Armed = { spec, dir, ino: this.deps.inode(dir), watcher, onChange };
    watcher.on("error", (err) => {
      if (this.armed.get(id) === entry) {
        this.disarm(id);
        onError(err.message);
      }
    });
    this.armed.set(id, entry);
  }

  disarm(id: number): void {
    const a = this.armed.get(id);
    if (a === undefined) {
      return;
    }
    this.armed.delete(id);
    if (a.timer !== undefined) {
      this.deps.clearTimer(a.timer);
    }
    try {
      a.watcher.close();
    } catch {
      // already closed
    }
  }

  closeAll(): void {
    for (const id of [...this.armed.keys()]) {
      this.disarm(id);
    }
  }

  /**
   * Is the watch still on the directory it was armed on? A directory that was deleted and
   * recreated is a different inode and delivers nothing to the old watch: re-arm it. Returns
   * false when the directory is gone (nothing to re-arm on), true otherwise.
   */
  check(id: number, onError: (message: string) => void = () => {}): boolean {
    const a = this.armed.get(id);
    if (a === undefined) {
      return false;
    }
    const ino = this.deps.inode(a.dir);
    if (ino === undefined) {
      return false;
    }
    if (ino !== a.ino) {
      this.arm(id, a.spec, a.onChange, onError);
    }
    return true;
  }

  private onEvent(id: number, event: string, filename: string | Buffer | null): void {
    const a = this.armed.get(id);
    if (a === undefined) {
      return;
    }
    const name = filename === null ? undefined : filename.toString();
    if (!a.spec.dir && name !== undefined && name !== path.basename(a.spec.path)) {
      return; // another file in the same directory
    }
    if (!this.relevant(a, event, name)) {
      return;
    }
    const now = this.deps.now();
    a.burstAt ??= now;
    if (a.timer !== undefined) {
      this.deps.clearTimer(a.timer);
    }
    const wait = Math.max(0, Math.min(a.spec.cooldownMs, a.burstAt + MAX_WAIT_MS - now));
    a.timer = this.deps.setTimer(() => {
      a.timer = undefined;
      a.burstAt = undefined;
      if (this.armed.get(id) === a) {
        a.onChange();
      }
    }, wait);
  }

  /** A write or creation always counts; a deletion or rename away only for events "any". */
  private relevant(a: Armed, event: string, name: string | undefined): boolean {
    if (event === "change") {
      return true;
    }
    const target = a.spec.dir ? (name === undefined ? undefined : path.join(a.dir, name)) : a.spec.path;
    const present = target === undefined ? true : this.deps.exists(target);
    return present || a.spec.events === "any";
  }
}
