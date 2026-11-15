// File history (ticket 11): what a session's write and edit tools changed, so a rewind can offer to undo the code as well as the
// conversation. The toriel-filehistory extension records, before each write/edit call, what the file held (and after it, what it holds
// now); the controller reads the same journal to show "3 files changed +12 -4" in the rewind list, and the daemon uses it to put the
// files back. Shared by both halves, so the format has one definition. Pure fs: nothing here talks to pi.
//
// Layout, per session: <root>/<session id>/journal.jsonl (one JSON line per record) and blobs/<sha256> (file contents, written once).
// Everything is owner-only: the blobs are copies of the user's files.
//
// What it does NOT see: changes a command makes (sed -i, a build, git checkout) - only the write and edit tools, including when a
// codemode script calls them. A file changed by something else after the agent's last edit is left alone by a restore.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** Where the daemon tells a child to keep its sessions' journals (a directory; each session gets a subdirectory of its own). */
export const FILE_HISTORY_ENV = "TORIEL_FILE_HISTORY";

/** A file this big is not kept (the journal says so, and a restore leaves the file alone). */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;

export type FileState = { kind: "file"; sha: string; size: number } | { kind: "absent" } | { kind: "big"; size: number };

interface BeforeRecord {
  k: "before";
  ts: number;
  call: string;
  path: string;
  tool: string;
  state: FileState;
}
interface AfterRecord {
  k: "after";
  ts: number;
  call: string;
  state: FileState;
}
type Record_ = BeforeRecord | AfterRecord;

/** One recorded call: what the file held before it, and (when the call finished) after it. */
export interface Change {
  call: string;
  path: string;
  tool: string;
  ts: number;
  before: FileState;
  after?: FileState;
}

export const journalFile = (dir: string): string => path.join(dir, "journal.jsonl");
const blobFile = (dir: string, sha: string): string => path.join(dir, "blobs", sha);

/** What the file at `file` holds now (following symlinks, as the tools do). A directory or an unreadable file is undefined: not recorded. */
export function stateOf(dir: string, file: string, keep: boolean): FileState | undefined {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" || (err as NodeJS.ErrnoException).code === "ENOTDIR" ? { kind: "absent" } : undefined;
  }
  if (!st.isFile()) {
    return undefined;
  }
  if (st.size > MAX_FILE_BYTES) {
    return { kind: "big", size: st.size };
  }
  try {
    const data = fs.readFileSync(file);
    const sha = crypto.createHash("sha256").update(data).digest("hex");
    if (keep) {
      const blob = blobFile(dir, sha);
      if (!fs.existsSync(blob)) {
        fs.mkdirSync(path.dirname(blob), { recursive: true, mode: 0o700 });
        fs.writeFileSync(blob, data, { mode: 0o600 });
      }
    }
    return { kind: "file", sha, size: data.length };
  } catch {
    return undefined;
  }
}

function append(dir: string, record: Record_): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(journalFile(dir), `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

/** Before a write/edit of `file` runs: keep what it holds. Never throws (a journal that cannot be written must not stop the edit). */
export function recordBefore(dir: string, call: string, tool: string, file: string, now: number = Date.now()): void {
  try {
    const state = stateOf(dir, file, true);
    if (state !== undefined) {
      append(dir, { k: "before", ts: now, call, path: file, tool, state });
    }
  } catch {
    // best effort
  }
}

/** After the call finished: what the file holds now, so a later restore can tell whether something else changed it since. Never throws. */
export function recordAfter(dir: string, call: string, file: string, now: number = Date.now()): void {
  try {
    const state = stateOf(dir, file, false);
    if (state !== undefined) {
      append(dir, { k: "after", ts: now, call, state });
    }
  } catch {
    // best effort
  }
}

/** The recorded calls, oldest first. A line that does not parse (a torn write) is skipped. */
export function readChanges(dir: string): Change[] {
  let text: string;
  try {
    text = fs.readFileSync(journalFile(dir), "utf8");
  } catch {
    return [];
  }
  const byCall = new Map<string, Change>();
  const afters: AfterRecord[] = [];
  for (const line of text.split("\n")) {
    if (line === "") {
      continue;
    }
    try {
      const r = JSON.parse(line) as Record_;
      if (r.k === "before") {
        byCall.set(r.call, { call: r.call, path: r.path, tool: r.tool, ts: r.ts, before: r.state });
      } else if (r.k === "after") {
        afters.push(r);
      }
    } catch {
      // skipped
    }
  }
  for (const a of afters) {
    const c = byCall.get(a.call);
    if (c) {
      c.after = a.state;
    }
  }
  return [...byCall.values()].sort((a, b) => a.ts - b.ts);
}

const sameState = (a: FileState, b: FileState): boolean => a.kind === b.kind && (a.kind !== "file" || a.sha === (b as typeof a).sha) && (a.kind !== "big" || a.size === (b as typeof a).size);

/** The shortest edit script length between two line lists (Myers), or undefined when it exceeds `limit`. */
function editDistance(a: readonly string[], b: readonly string[], limit: number): number | undefined {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, limit);
  const v = new Int32Array(2 * max + 2);
  const off = max;
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (v[off + k - 1] as number) < (v[off + k + 1] as number)) ? (v[off + k + 1] as number) : (v[off + k - 1] as number) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        return d;
      }
    }
  }
  return undefined;
}

/** Lines added and removed going from text `a` to text `b` (what a diff would count). A change too large to compare exactly counts every differing line once each way. */
export function lineDiff(a: string, b: string): { added: number; removed: number } {
  if (a === b) {
    return { added: 0, removed: 0 };
  }
  const split = (s: string): string[] => (s === "" ? [] : s.replace(/\n$/, "").split("\n"));
  const x = split(a);
  const y = split(b);
  let head = 0;
  while (head < x.length && head < y.length && x[head] === y[head]) {
    head++;
  }
  let tail = 0;
  while (tail < x.length - head && tail < y.length - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) {
    tail++;
  }
  const xs = x.slice(head, x.length - tail);
  const ys = y.slice(head, y.length - tail);
  const d = editDistance(xs, ys, 4000);
  if (d === undefined) {
    return { added: ys.length, removed: xs.length };
  }
  // d = added + removed, and added - removed = ys.length - xs.length
  const added = (d + ys.length - xs.length) / 2;
  return { added, removed: d - added };
}

export type FileStatus = "restore" | "same" | "changed-since" | "too-big";

/** What undoing the code back to a moment would do to one file. */
export interface FilePlan {
  path: string;
  status: FileStatus;
  /** What the file held then (what a restore puts back). */
  then: FileState;
  /** Lines the agent's edits since then added and removed (counted from the file as it was then to the file as it is now). */
  added: number;
  removed: number;
}

export interface CodePlan {
  files: FilePlan[];
  /** Files a restore would change. */
  restorable: number;
  /** Totals over the restorable files. */
  added: number;
  removed: number;
}

const textOf = (dir: string, s: FileState): string => (s.kind === "file" ? fs.readFileSync(blobFile(dir, s.sha), "utf8") : "");

/**
 * What the agent's edits since `sinceMs` (the time of the message rewound to) did, file by file: the state each file had at that moment is
 * the "before" of its first recorded call since then. A file that holds that state already is `same`; one whose content is not what the
 * agent last wrote is `changed-since` (something else touched it: a restore leaves it alone); one that was too big to keep is `too-big`.
 */
export function planRestore(dir: string, sinceMs: number): CodePlan {
  const since = readChanges(dir).filter((c) => c.ts >= sinceMs);
  const byPath = new Map<string, Change[]>();
  for (const c of since) {
    byPath.set(c.path, [...(byPath.get(c.path) ?? []), c]);
  }
  const files: FilePlan[] = [];
  for (const [file, calls] of byPath) {
    const first = calls[0] as Change;
    const last = calls[calls.length - 1] as Change;
    const then = first.before;
    const now = stateOf(dir, file, false) ?? { kind: "absent" as const };
    let status: FileStatus;
    let counts = { added: 0, removed: 0 };
    if (then.kind === "big" || now.kind === "big") {
      status = "too-big";
    } else if (sameState(now, then)) {
      status = "same";
    } else if (last.after !== undefined && !sameState(now, last.after)) {
      status = "changed-since";
    } else {
      status = "restore";
    }
    if (status === "restore" || status === "changed-since") {
      try {
        counts = lineDiff(textOf(dir, then), now.kind === "file" ? fs.readFileSync(file, "utf8") : "");
      } catch {
        // the blob is gone: the counts stay 0 and the restore will say so
      }
    }
    files.push({ path: file, status, then, ...counts });
  }
  const restorable = files.filter((f) => f.status === "restore");
  return { files, restorable: restorable.length, added: restorable.reduce((n, f) => n + f.added, 0), removed: restorable.reduce((n, f) => n + f.removed, 0) };
}

export interface RestoreResult {
  restored: string[];
  /** Files left alone, each with why. */
  left: Array<{ path: string; why: string }>;
}

/** Put the files of `plan` back as they were: restorable ones only, each checked again just before it is written. */
export function applyRestore(dir: string, plan: CodePlan): RestoreResult {
  const restored: string[] = [];
  const left: RestoreResult["left"] = [];
  for (const f of plan.files) {
    if (f.status === "same") {
      continue;
    }
    if (f.status === "changed-since") {
      left.push({ path: f.path, why: "it was changed after the agent's last edit (by you or a command), so it was not overwritten" });
      continue;
    }
    if (f.status === "too-big") {
      left.push({ path: f.path, why: "it is too big for the history to keep" });
      continue;
    }
    try {
      if (f.then.kind === "absent") {
        fs.rmSync(f.path, { force: true });
      } else if (f.then.kind === "file") {
        fs.mkdirSync(path.dirname(f.path), { recursive: true });
        fs.writeFileSync(f.path, fs.readFileSync(blobFile(dir, f.then.sha)));
      }
      restored.push(f.path);
    } catch (err) {
      left.push({ path: f.path, why: `could not be written (${err instanceof Error ? err.message : String(err)})` });
    }
  }
  return { restored, left };
}

/** Forget the records from `sinceMs` on (the conversation they belong to was cut away) and delete the blobs nothing refers to any more. */
export function pruneFrom(dir: string, sinceMs: number): void {
  const keep = readChanges(dir).filter((c) => c.ts < sinceMs);
  const lines: string[] = [];
  const used = new Set<string>();
  for (const c of keep) {
    lines.push(JSON.stringify({ k: "before", ts: c.ts, call: c.call, path: c.path, tool: c.tool, state: c.before } satisfies BeforeRecord));
    if (c.before.kind === "file") {
      used.add(c.before.sha);
    }
    if (c.after !== undefined) {
      lines.push(JSON.stringify({ k: "after", ts: c.ts, call: c.call, state: c.after } satisfies AfterRecord));
    }
  }
  const tmp = `${journalFile(dir)}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, lines.length > 0 ? `${lines.join("\n")}\n` : "", { mode: 0o600 });
  fs.renameSync(tmp, journalFile(dir));
  try {
    for (const name of fs.readdirSync(path.join(dir, "blobs"))) {
      if (!used.has(name)) {
        fs.rmSync(path.join(dir, "blobs", name), { force: true });
      }
    }
  } catch {
    // no blobs directory: nothing to collect
  }
}
