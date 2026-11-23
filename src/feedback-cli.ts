// `toriel feedback list | prune | export` (ticket 240): the command line over feedback-admin.ts.
import * as path from "node:path";
import { type BundleInfo, exportBundle, findBundle, fmtBytes, listBundles, parseAge, pruneBundles } from "./feedback-admin.ts";

export const FEEDBACK_USAGE = `usage: toriel feedback <list | prune | export>

  list                          the bundles /feedback wrote, newest first, with size
  prune [--keep N] [--older-than 30d] [--dry-run]
                                delete whole bundle folders: all but the newest N, and/or older than an age
                                (m, h, d, w). Needs at least one rule. --dry-run prints what would go.
                                The notes (feedback.jsonl) are never touched; nothing is deleted automatically.
  export <bundle> [--to DIR]    pack one bundle into DIR/feedback-<bundle>.tar.gz (default: the current directory);
                                <bundle> is its folder name or any part of it, e.g. the id /feedback printed

A bundle holds a full copy of the session, not redacted (config files in it have secrets masked), and is readable
only by you. Look at what is in the archive before you hand it to anyone; the archive is also readable only by you.`;

export interface FeedbackIo {
  write(text: string): void;
}

export interface FeedbackEnv {
  feedbackDir: string;
  cwd: string;
  now?: number;
  /** Replaces the system tar (tests). */
  tar?: (args: string[]) => Promise<void>;
}

const age = (now: number, at: number): string => {
  const d = Math.max(0, now - at);
  const days = Math.floor(d / 86_400_000);
  return days >= 1 ? `${days}d` : `${Math.floor(d / 3_600_000)}h`;
};

const line = (b: BundleInfo, now: number): string => `${b.name}  ${fmtBytes(b.bytes).padStart(8)}  ${age(now, b.at)} old`;

export async function feedbackMain(args: readonly string[], io: FeedbackIo, env: FeedbackEnv): Promise<number> {
  const now = env.now ?? Date.now();
  const [cmd, ...rest] = args;
  if (cmd === undefined || cmd === "--help" || cmd === "-h" || cmd === "help") {
    io.write(`${FEEDBACK_USAGE}\n`);
    return cmd === undefined ? 2 : 0;
  }
  // options of the form `--name value` or `--name=value`, and bare flags
  const opt = (name: string): string | true | undefined => {
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i] as string;
      if (a === name) {
        const next = rest[i + 1];
        return next !== undefined && !next.startsWith("--") ? next : true;
      }
      if (a.startsWith(`${name}=`)) {
        return a.slice(name.length + 1);
      }
    }
    return undefined;
  };
  const known = cmd === "prune" ? ["--keep", "--older-than", "--dry-run"] : cmd === "export" ? ["--to"] : [];
  const valued = new Set(["--keep", "--older-than", "--to"]);
  const words: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string;
    if (a.startsWith("--")) {
      const name = a.split("=")[0] as string;
      if (!known.includes(name)) {
        io.write(`toriel feedback ${cmd}: unknown option "${name}"\n${FEEDBACK_USAGE}\n`);
        return 2;
      }
      if (valued.has(name) && !a.includes("=")) {
        i++;
      }
      continue;
    }
    words.push(a);
  }

  if (cmd === "list") {
    const all = listBundles(env.feedbackDir);
    if (all.length === 0) {
      io.write(`no bundles in ${env.feedbackDir}\n`);
      return 0;
    }
    io.write(`${all.map((b) => line(b, now)).join("\n")}\n${all.length} bundles, ${fmtBytes(all.reduce((n, b) => n + b.bytes, 0))} in ${env.feedbackDir}\n`);
    return 0;
  }

  if (cmd === "prune") {
    const keepRaw = opt("--keep");
    const olderRaw = opt("--older-than");
    const keep = typeof keepRaw === "string" ? Number(keepRaw) : undefined;
    const olderThanMs = typeof olderRaw === "string" ? parseAge(olderRaw) : undefined;
    if ((keepRaw !== undefined && (keep === undefined || !Number.isInteger(keep) || keep < 0)) || (olderRaw !== undefined && olderThanMs === undefined)) {
      io.write(`toriel feedback prune: --keep wants a count (3), --older-than an age (30d, 12h, 2w)\n`);
      return 2;
    }
    if (keep === undefined && olderThanMs === undefined) {
      io.write(`toriel feedback prune: say what to delete (--keep N and/or --older-than 30d); nothing is deleted without a rule\n`);
      return 2;
    }
    const dryRun = opt("--dry-run") !== undefined;
    const r = pruneBundles(env.feedbackDir, { keep, olderThanMs, dryRun, now });
    for (const b of r.removed) {
      io.write(`${dryRun ? "would remove" : "removed"}  ${line(b, now)}\n`);
    }
    for (const f of r.failed) {
      io.write(`could not remove ${f.bundle.name}: ${f.reason}\n`);
    }
    const freed = fmtBytes(r.removed.reduce((n, b) => n + b.bytes, 0));
    io.write(`${dryRun ? "would remove" : "removed"} ${r.removed.length} bundles (${freed}); ${r.kept.length} kept${dryRun ? " (dry run: nothing was deleted)" : ""}\n`);
    return r.failed.length > 0 ? 1 : 0;
  }

  if (cmd === "export") {
    if (words.length !== 1) {
      io.write(`toriel feedback export: name one bundle (toriel feedback list)\n`);
      return 2;
    }
    const found = findBundle(env.feedbackDir, words[0] as string);
    if ("error" in found) {
      io.write(`toriel feedback export: ${found.error}\n`);
      return 1;
    }
    const to = opt("--to");
    try {
      const out = await exportBundle(found.bundle, path.resolve(env.cwd, typeof to === "string" ? to : "."), env.tar);
      io.write(`${out}\nThe archive holds the session's full text, not redacted (config files in it have secrets masked); it is readable only by you. Check it before you share it.\n`);
      return 0;
    } catch (err) {
      io.write(`toriel feedback export: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }

  io.write(`toriel feedback: unknown command "${cmd}"\n${FEEDBACK_USAGE}\n`);
  return 2;
}
