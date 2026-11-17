// What /feedback packs up with a note (ticket 239), so the problem can be looked at from another machine or another day: a full copy of
// the session, the logs around the note, the permission rules, the toriel config (secrets masked), the doctor report and a snapshot of
// the daemon's state. One folder per note, readable only by the user (a session holds everything the model saw). Nothing leaves the
// machine: sharing the folder is the user's call. Each part is gathered on its own, so one that fails is named in the manifest and the
// rest are still kept.
import * as fs from "node:fs";
import * as path from "node:path";
import type { FeedbackRecord } from "./feedback.ts";

export interface BundleSources {
  /** The notes file (feedback.jsonl) the record is appended to; a parameter so a test never touches the real one. */
  noteFile: string;
  /** Where the bundle folders live. */
  feedbackDir: string;
  daemonLog: string;
  decisionsFile: string;
  /** pi's agent dir: the permission package's global config and its review log are under it. */
  agentDir: string;
  /** toriel's own config files, copied with secrets masked (settings.yaml, mcp.yaml). */
  configFiles: string[];
  /** The doctor report text, produced by the caller (it needs the controller's modules). */
  doctor?: () => string;
}

export interface BundleInput {
  id: string;
  at: string;
  record: FeedbackRecord;
  snapshot: unknown;
  sessionFile?: string;
  /** The session's working directory: its project's permission config is copied too, when there is one. */
  cwd?: string;
  /** How far back the logs go from the note (default 30 minutes); the note's own minute is always included. */
  windowMs?: number;
}

export interface BundleResult {
  dir: string;
  /** One line per file, or the reason it is missing. */
  manifest: string;
}

const WINDOW_MS = 30 * 60 * 1000;
/** A log is read from its tail only: the window is recent, and a log can be large. */
const TAIL_BYTES = 32 * 1024 * 1024;

/** The key names whose values are secrets, in YAML or JSON config. */
const SECRET_KEY = /(token|secret|password|passwd|api[_-]?key|apikey|authorization|bearer|credential|private[_-]?key)/i;
/** A block whose children are all values (an HTTP header map, an environment): masked whatever the names. */
const VALUE_BLOCK = /^(\s*)(headers|env|environment)\s*:\s*$/i;

/**
 * Mask secrets in a config file's text, line by line: the value of a key that names a secret, every value inside a `headers:` or `env:`
 * block, a `Bearer` token, and `--token x` style arguments. Keys and structure stay, so the file still shows how things are set up.
 */
export function redactText(text: string): string {
  const out: string[] = [];
  let blockIndent: number | undefined;
  for (const line of text.split("\n")) {
    const indent = line.length - line.trimStart().length;
    if (blockIndent !== undefined) {
      if (line.trim() === "" || indent > blockIndent) {
        out.push(line.replace(/^(\s*[^\s:#][^:]*:\s*)(\S.*)$/, "$1<redacted>").replace(/^(\s*-\s+)(\S.*)$/, "$1<redacted>"));
        continue;
      }
      blockIndent = undefined;
    }
    const open = VALUE_BLOCK.exec(line);
    if (open) {
      blockIndent = (open[1] ?? "").length;
      out.push(line);
      continue;
    }
    let masked = line.replace(/^(\s*(?:-\s+)?["']?[\w.-]*["']?\s*:\s*)(\S.*)$/, (whole, head: string, value: string) => (SECRET_KEY.test(head) && !/^[{[]?\s*$/.test(value) ? `${head}<redacted>` : whole));
    masked = masked.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1<redacted>").replace(/(--?(?:token|api-key|apikey|password|secret)[= ]+)\S+/gi, "$1<redacted>");
    out.push(masked);
  }
  return out.join("\n");
}

/** The tail of a file, up to `max` bytes, as text; undefined when it cannot be read. */
function tailText(file: string, max = TAIL_BYTES): string | undefined {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - max);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const text = buf.toString("utf8");
      return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

const STAMP = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s/;

/** The lines of a daemon-style log (each starts with an ISO time; a line without one belongs to the one above) between two times. */
export function windowLog(text: string, from: string, to: string): string {
  const out: string[] = [];
  let inside = false;
  for (const line of text.split("\n")) {
    const stamp = STAMP.exec(line)?.[1];
    if (stamp !== undefined) {
      inside = stamp >= from && stamp <= to;
    }
    if (inside) {
      out.push(line);
    }
  }
  return out.join("\n");
}

/** The JSON lines of a log whose records carry a time under `key`, between two times. */
export function windowJsonl(text: string, key: string, from: string, to: string): string {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    try {
      const at = (JSON.parse(line) as Record<string, unknown>)[key];
      if (typeof at === "string" && at >= from && at <= to) {
        out.push(line);
      }
    } catch {
      // blank or torn
    }
  }
  return out.join("\n");
}

function stamp(iso: string): string {
  return iso.replace(/[:.]/g, "-");
}

/** Write the bundle for one note. Never throws for a missing or unreadable source: the manifest says what could not be gathered. */
export async function writeBundle(input: BundleInput, src: BundleSources): Promise<BundleResult> {
  const dir = path.join(src.feedbackDir, `${stamp(input.at)}-${input.id.slice(0, 8)}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const from = new Date(Date.parse(input.at) - (input.windowMs ?? WINDOW_MS)).toISOString();
  const to = new Date(Date.parse(input.at) + 60_000).toISOString();
  const lines: string[] = [];
  const put = (name: string, content: string | Buffer, note = ""): void => {
    fs.writeFileSync(path.join(dir, name), content, { mode: 0o600 });
    lines.push(`${name}  ${Buffer.byteLength(content)} bytes${note ? `  ${note}` : ""}`);
  };
  const part = async (name: string, gather: () => Promise<void> | void): Promise<void> => {
    try {
      await gather();
    } catch (err) {
      lines.push(`${name}  NOT GATHERED: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const window = `${from} .. ${to}`;
  const fromLog = (name: string, file: string, keep: (text: string) => string, note: string): void => {
    const text = tailText(file);
    if (text === undefined) {
      lines.push(`${name}  not there (${file})`);
      return;
    }
    put(name, keep(text), `${note}, ${window}`);
  };

  await part("record.json", () => put("record.json", `${JSON.stringify(input.record, null, 2)}\n`));
  await part("snapshot.json", () => put("snapshot.json", `${JSON.stringify(input.snapshot, null, 2)}\n`));
  await part("session.jsonl", async () => {
    if (!input.sessionFile || !fs.existsSync(input.sessionFile)) {
      lines.push(`session.jsonl  no session file${input.sessionFile ? ` (${input.sessionFile} is gone)` : ""}`);
      return;
    }
    await fs.promises.copyFile(input.sessionFile, path.join(dir, "session.jsonl"));
    fs.chmodSync(path.join(dir, "session.jsonl"), 0o600);
    lines.push(`session.jsonl  ${fs.statSync(path.join(dir, "session.jsonl")).size} bytes  full copy of ${input.sessionFile}`);
  });
  await part("daemon-log.txt", () => fromLog("daemon-log.txt", src.daemonLog, (t) => windowLog(t, from, to), "daemon log"));
  await part("permission-decisions.jsonl", () => fromLog("permission-decisions.jsonl", src.decisionsFile, (t) => windowJsonl(t, "at", from, to), "who answered each prompt, all sessions"));
  await part("permission-review.jsonl", () => {
    const logs = path.join(src.agentDir, "extensions", "pi-permission-system", "logs");
    const files = fs.existsSync(logs) ? fs.readdirSync(logs).filter((f) => /review.*\.jsonl$/.test(f)) : [];
    if (files.length === 0) {
      lines.push(`permission-review.jsonl  not there (${logs})`);
      return;
    }
    for (const f of files) {
      fromLog("permission-review.jsonl", path.join(logs, f), (t) => windowJsonl(t, "timestamp", from, to), "pi-permission-system's own review log, all sessions");
    }
  });
  await part("permission-config.json", () => {
    const global = path.join(src.agentDir, "extensions", "pi-permission-system", "config.json");
    const project = input.cwd ? path.join(input.cwd, ".pi", "extensions", "pi-permission-system", "config.json") : undefined;
    for (const [name, file] of [["permission-config.json", global], ["project-permission-config.json", project]] as const) {
      if (file !== undefined && fs.existsSync(file)) {
        put(name, fs.readFileSync(file, "utf8"), `the rules in ${file}`);
      }
    }
  });
  await part("config files", () => {
    for (const file of src.configFiles) {
      if (fs.existsSync(file)) {
        put(path.basename(file), redactText(fs.readFileSync(file, "utf8")), `${file}, secrets masked`);
      }
    }
  });
  await part("doctor.txt", () => {
    if (src.doctor) {
      put("doctor.txt", `${src.doctor()}\n`);
    }
  });

  const manifest = `feedback bundle ${input.id}\nnote written ${input.at}\nlog window ${window}\n\n${lines.join("\n")}\n\nEverything here stays on this machine. The session copy is complete and not redacted; config files have secret values masked.\n`;
  fs.writeFileSync(path.join(dir, "manifest.txt"), manifest, { mode: 0o600 });
  return { dir, manifest };
}
