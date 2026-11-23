// `toriel feedback list | prune | export` (ticket 240): looking after the bundle folders /feedback writes (feedback-bundle.ts, ticket 239).
// A bundle is one folder per note, named `<time>-<id>` (the time with ":" and "." as "-"), holding a full unredacted copy of the session,
// so nothing prunes them by itself: deleting feedback on a timer would be a surprise. These are the explicit tools. The notes file
// (feedback.jsonl) is never touched here; a note whose bundle is pruned keeps its text and its `bundle` path (now gone).
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface BundleInfo {
  /** The folder name. */
  name: string;
  dir: string;
  /** When the note was written: from the name, else the folder's mtime. */
  at: number;
  bytes: number;
}

const NAME = /^(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)-(\d+)Z-/;

/** The time a bundle folder's name says (`2026-11-22T22-45-23-015Z-ab12cd34`), if it has one. */
export function bundleTime(name: string): number | undefined {
  const m = NAME.exec(name);
  if (!m) {
    return undefined;
  }
  const t = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isNaN(t) ? undefined : t;
}

function folderBytes(dir: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    try {
      total += entry.isDirectory() ? folderBytes(file) : fs.lstatSync(file).size;
    } catch {
      // vanished while counting
    }
  }
  return total;
}

/** The bundle folders in `feedbackDir`, newest first. Anything that is not a directory (the notes file may live nearby) is not one. */
export function listBundles(feedbackDir: string): BundleInfo[] {
  if (!fs.existsSync(feedbackDir)) {
    return [];
  }
  const out: BundleInfo[] = [];
  for (const entry of fs.readdirSync(feedbackDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dir = path.join(feedbackDir, entry.name);
    let at = bundleTime(entry.name);
    try {
      at ??= fs.statSync(dir).mtimeMs;
      out.push({ name: entry.name, dir, at, bytes: folderBytes(dir) });
    } catch {
      // gone between the listing and the stat
    }
  }
  return out.sort((a, b) => b.at - a.at || b.name.localeCompare(a.name));
}

export function fmtBytes(n: number): string {
  if (n < 1024) {
    return `${n} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** `30d`, `12h`, `90m`, `2w` as milliseconds; undefined for anything else. */
export function parseAge(text: string): number | undefined {
  const m = /^(\d+)\s*([mhdw])$/i.exec(text.trim());
  if (!m) {
    return undefined;
  }
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[(m[2] as string).toLowerCase() as "m" | "h" | "d" | "w"];
  return Number(m[1]) * unit;
}

export interface PruneOptions {
  /** Keep this many of the newest bundles. */
  keep?: number;
  /** Delete bundles older than this many ms. */
  olderThanMs?: number;
  dryRun?: boolean;
  now?: number;
}

export interface PruneResult {
  removed: BundleInfo[];
  kept: BundleInfo[];
  /** Bundles that could not be removed, with the reason. */
  failed: Array<{ bundle: BundleInfo; reason: string }>;
}

/**
 * Delete whole bundle folders: the ones beyond the newest `keep`, and/or older than `olderThanMs` (both given: a bundle goes if either says
 * so). Needs at least one rule; with none nothing is deleted, since "prune everything" is not something to reach by leaving out a flag.
 */
export function pruneBundles(feedbackDir: string, opts: PruneOptions): PruneResult {
  const all = listBundles(feedbackDir);
  const now = opts.now ?? Date.now();
  const doomed = new Set<string>();
  if (opts.keep !== undefined) {
    for (const b of all.slice(opts.keep)) {
      doomed.add(b.name);
    }
  }
  if (opts.olderThanMs !== undefined) {
    for (const b of all) {
      if (now - b.at > opts.olderThanMs) {
        doomed.add(b.name);
      }
    }
  }
  const result: PruneResult = { removed: [], kept: [], failed: [] };
  for (const b of all) {
    if (!doomed.has(b.name)) {
      result.kept.push(b);
      continue;
    }
    if (opts.dryRun) {
      result.removed.push(b);
      continue;
    }
    try {
      fs.rmSync(b.dir, { recursive: true, force: true });
      result.removed.push(b);
    } catch (err) {
      result.failed.push({ bundle: b, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

/** The one bundle `ref` names: a whole folder name, or any part of it (the id prefix `/feedback` printed). Undefined with the reason when it is none or several. */
export function findBundle(feedbackDir: string, ref: string): { bundle: BundleInfo } | { error: string } {
  const all = listBundles(feedbackDir);
  const exact = all.filter((b) => b.name === ref);
  const hits = exact.length === 1 ? exact : all.filter((b) => b.name.includes(ref));
  if (ref === "" || hits.length === 0) {
    return { error: `no bundle matches "${ref}" (toriel feedback list shows them)` };
  }
  if (hits.length > 1) {
    return { error: `"${ref}" matches ${hits.length} bundles (${hits.map((b) => b.name).join(", ")}); give more of the name` };
  }
  return { bundle: hits[0] as BundleInfo };
}

/** Pack one bundle into `<outDir>/feedback-<name>.tar.gz` (mode 0600) with the system tar. Resolves with the file's path. */
export function exportBundle(bundle: BundleInfo, outDir: string, tar: (args: string[]) => Promise<void> = runTar): Promise<string> {
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.resolve(outDir, `feedback-${bundle.name}.tar.gz`);
  return (async () => {
    const previous = process.umask(0o177);
    try {
      await tar(["-czf", out, "-C", path.dirname(bundle.dir), bundle.name]);
    } finally {
      process.umask(previous);
    }
    fs.chmodSync(out, 0o600);
    return out;
  })();
}

function runTar(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("tar", args, (err, _out, stderr) => (err ? reject(new Error(`tar failed: ${String(stderr).trim() || err.message}`)) : resolve()));
  });
}

/** Total size of the bundle folders, for the doctor line. */
export function bundlesBytes(feedbackDir: string): number {
  return listBundles(feedbackDir).reduce((n, b) => n + b.bytes, 0);
}
