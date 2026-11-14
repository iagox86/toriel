// The toriel settings file as a document people read and edit: the commented template written on first
// run, the conversion of an old settings.json, and the one way to change a key without losing the
// comments around it. Reading and validating lives in settings.ts; this is the writing side.
import * as fs from "node:fs";
import * as path from "node:path";
import { Document, isScalar, isSeq, parseDocument } from "yaml";
import { DEFAULT_PI_CLI } from "./config.ts";
import { legacySettingsFile, SETTING_KEYS, yamlSettingsFile } from "./settings.ts";
import { writeFileAtomic } from "./util.ts";

interface Entry {
  key: string;
  /** The value in effect when the key is absent; undefined = no fixed default. Either way the line is written commented: absent means whatever the code's default is today. */
  value?: unknown;
  /** For a key with no default: the example line's value. */
  example?: string;
  /** What the key does, in the voice of the TorielSettings comments. One comment line per element. */
  comment: string[];
}

interface Group {
  heading: string;
  entries: Entry[];
}

/** Every key the settings file accepts, with its default and a comment. test/settings-file.test.ts keeps the defaults equal to the code's and the list equal to what settings.ts accepts. */
export const SETTINGS_TEMPLATE: readonly Group[] = [
  {
    heading: "Models",
    entries: [
      { key: "provider", example: "anthropic", comment: ["Provider of the model new sessions use. Unset = pi's own default."] },
      { key: "model", example: "claude-sonnet-5-5", comment: ["Model new sessions use, and agent profiles inherit unless their frontmatter pins one. Unset = pi's own default."] },
      { key: "thinking", example: "medium", comment: ["Thinking level for new sessions (off, minimal, low, medium, high, xhigh; what a model offers varies)."] },
      { key: "summaryModel", value: "litellm/local-model", comment: ["The cheap model /summarize, /why and the switcher's automatic summaries use (provider/id).", "Its default is a local litellm route: change it to a model you have."] },
      { key: "piCli", example: DEFAULT_PI_CLI, comment: ["Path of pi's cli.js, when it is not where toriel expects it."] },
    ],
  },
  {
    heading: "Sessions",
    entries: [
      { key: "steeringMode", value: "all", comment: ["How messages sent while the agent is working are delivered:", '"all" = together at the next turn boundary, "one-at-a-time" = pi\'s own default of one per turn.'] },
      { key: "autoName", value: true, comment: ["Name a session nobody named from its first message, with the summary model, when its first turn ends.", "A failure only leaves the session unnamed. Names you set yourself are never replaced."] },
      { key: "preventSleep", value: true, comment: ["Keep the machine from sleeping while a session is working or a scheduled run is near (needs systemd-inhibit)."] },
      { key: "showExternalSessions", value: false, comment: ["List sessions toriel never ran (plain pi, other instances) in the switcher. /external flips it for one run."] },
      { key: "trashRetentionDays", value: 90, comment: ["Deleted sessions, and rewind and clear backups, stay in the trash this many days. 0 = keep forever."] },
    ],
  },
  {
    heading: "Summaries",
    entries: [
      { key: "summaryIntervalMinutes", value: 60, comment: ["Re-summarize changed sessions this often while toriel is open. 0 = never."] },
      { key: "summaryMinNewMessages", value: 6, comment: ["A summary is refreshed once its session has this many new messages."] },
    ],
  },
  {
    heading: "Scheduled prompts (/in, /every, /watch, ...)",
    entries: [
      { key: "scheduleUsagePause", value: 95, comment: ["Scheduled runs wait while a usage window of the session's provider is at or above this percent. 0 = never wait."] },
      { key: "scheduleDailyLimit", value: 200, comment: ["Most scheduled runs per 24 hours across all sessions. Read when the daemon starts."] },
    ],
  },
  {
    heading: "Subagents",
    entries: [
      { key: "subagentMaxConcurrent", value: 3, comment: ["Subagents running at once, across all sessions. Read when the daemon starts."] },
      { key: "subagentMaxDepth", value: 1, comment: ["How many subagent links may sit above a session that spawns: 1 = only your own sessions start subagents, 2 = they may start one more level. At most 2."] },
      { key: "subagentMaxSpawns", value: 20, comment: ["Subagents one session may start over its lifetime in this daemon."] },
      { key: "subagentBudgetTokens", value: 150000, comment: ["Token budget of one subagent whose agent profile sets none."] },
      { key: "subagentIdleMinutes", value: 15, comment: ["Stop a running subagent that has produced no event at all for this many minutes (a run wedged inside one tool call).", "A permission prompt waiting for you does not count. 0 = never. TORIEL_SUBAGENT_IDLE_MS, if set, wins."] },
      { key: "subagentMaxMinutes", value: 0, comment: ["Stop a background subagent still running after this many minutes, however busy. 0 = no cap.", "TORIEL_SUBAGENT_MAX_MS, if set, wins."] },
      { key: "subagentKeepMinutes", value: 30, comment: ["A finished subagent stays in the switcher this many minutes, then goes to the trash (/restore brings it back). 0 = at once.", "TORIEL_SUBAGENT_KEEP_MS, if set, wins."] },
    ],
  },
  {
    heading: "Permissions",
    entries: [
      { key: "warnNoPermissionSystem", value: true, comment: ["Warn when pi-permission-system is not installed or has no usable config."] },
      { key: "permissionGrantLimit", value: 100, comment: ["Most permission grants one session may hold. Read when the daemon starts."] },
      { key: "permissionGrantDurations", value: ["1h", "session"], comment: ['The "allow for ..." rows a permission prompt offers: up to 5 durations such as 30m, 1h, 8h,', 'or "session" for until revoked. [] = none.'] },
      { key: "scopeGuardAcceptedAllows", example: '[{ surface: external_directory_write, pattern: "/tmp/*" }]', comment: ["Config allows the scope-guard doctor check treats as deliberate and does not flag.", 'surface is external_directory_write, external_directory or "*"; pattern is matched exactly.'] },
    ],
  },
  {
    heading: "Command sandbox",
    entries: [
      { key: "sandbox", value: "off", comment: ['"bwrap" runs each bash command of a directory-scoped session in a bubblewrap sandbox whose only writable places are', "the scope root and the ones below (needs bwrap; toriel doctor checks it). Read when a session starts."] },
      { key: "sandboxWritable", value: ["~/.npm", "~/.cache"], comment: ["Extra places a sandboxed command may write: absolute or ~/ paths, mostly package caches. [] = none."] },
    ],
  },
];

const HEADER = [
  "# toriel settings. Every setting is shown below with its default, commented out: remove the # to change one.",
  "# A setting left out (or commented) uses toriel's current default, so an upgrade can improve the defaults.",
  "# Environment variables (TORIEL_MODEL, TORIEL_SUMMARY_MODEL, ...) override this file.",
  "# The daemon re-reads it each time it starts a session, so an edit applies to new and restarted sessions;",
  "# the keys marked \"read when the daemon starts\" need a daemon restart.",
];

/** `key: value` as one YAML line (lists of plain values stay on one line); block form for a list of mappings. */
function entryText(key: string, value: unknown): string {
  const doc = new Document({ [key]: value });
  const node = doc.get(key, true);
  if (isSeq(node) && node.items.every((item) => isScalar(item))) {
    node.flow = true;
  }
  // quoted strings: unquoted `off` and `no` are booleans to the YAML 1.1 parsers other tools use
  return doc.toString({ lineWidth: 0, defaultStringType: "QUOTE_DOUBLE", defaultKeyType: "PLAIN", flowCollectionPadding: false }).trimEnd();
}

/** The settings the template shows with a fixed default: what the code uses when the file says nothing. */
export function templateDefaults(): Record<string, unknown> {
  return Object.fromEntries(SETTINGS_TEMPLATE.flatMap((g) => g.entries).flatMap((e) => (e.value === undefined ? [] : [[e.key, e.value] as const])));
}

/**
 * The settings file as text: every key, with a comment, commented out at its default. `values` are the
 * settings a person actually set (the conversion of an old settings.json passes its contents): those lines
 * are active, everything else stays a commented default. A key the template does not know is kept at the
 * end, so nothing a person wrote is lost.
 */
export function renderSettings(values: Record<string, unknown> = {}): string {
  const lines = [...HEADER];
  for (const group of SETTINGS_TEMPLATE) {
    lines.push("", `# ${group.heading}`);
    for (const entry of group.entries) {
      lines.push("", ...entry.comment.map((c) => `# ${c}`));
      if (Object.hasOwn(values, entry.key)) {
        lines.push(entryText(entry.key, values[entry.key]));
      } else if (entry.value !== undefined) {
        lines.push(`# ${entryText(entry.key, entry.value)}`);
      } else {
        lines.push(`# ${entry.key}: ${entry.example}`);
      }
    }
  }
  const extra = Object.keys(values).filter((k) => !SETTING_KEYS.includes(k));
  if (extra.length > 0) {
    lines.push("", "# Kept from the old settings file; toriel does not recognise these (doctor reports them)");
    for (const key of extra) {
      lines.push(entryText(key, values[key]));
    }
  }
  return `${lines.join("\n")}\n`;
}

/** The new file's text for an old settings.json: its values, in the commented template. Throws when the text is not a JSON (or YAML) mapping. */
export function convertLegacySettings(text: string): string {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    throw new Error(doc.errors[0]?.message ?? "not readable");
  }
  const values: unknown = doc.toJS();
  if (values === null || values === undefined) {
    return renderSettings();
  }
  if (typeof values !== "object" || Array.isArray(values)) {
    throw new Error("not a JSON object");
  }
  return renderSettings(values as Record<string, unknown>);
}

/** Whether the person has a settings file of either vintage. */
export function hasSettingsFile(env: NodeJS.ProcessEnv = process.env): boolean {
  const legacy = legacySettingsFile(env);
  return fs.existsSync(yamlSettingsFile(env)) || (legacy !== undefined && fs.existsSync(legacy));
}

/**
 * Write the commented defaults when there is no settings file at all: the file is how a new install
 * finds out which knobs exist, and nothing in it is in effect until someone uncomments it. Never touches an existing file (either vintage). Returns the path it
 * created, or undefined when there was nothing to do.
 */
export function ensureSettingsFile(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (hasSettingsFile(env)) {
    return undefined;
  }
  const file = yamlSettingsFile(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, renderSettings(), { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return undefined;
    }
    throw err;
  }
  return file;
}

/**
 * Set (or, with undefined, remove) keys in a settings file, keeping every comment and the order of what
 * is there. The one way code should write the file: a plain parse-and-stringify would drop the comments.
 */
export function updateSettings(file: string, patch: Record<string, unknown>): void {
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    throw new Error(`${file}: ${doc.errors[0]?.message}`);
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      doc.delete(key);
    } else {
      doc.set(key, value);
    }
  }
  writeFileAtomic(file, doc.toString({ lineWidth: 0 }), fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : undefined);
}
