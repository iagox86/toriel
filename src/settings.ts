// toriel's own settings file (~/.config/toriel/settings.yaml; a settings.json left
// from before the YAML switch is still read until `toriel doctor --fix` converts
// it). Layers, lowest first: built-in defaults, this file, TORIEL_* environment variables (which
// tests and smoke runs use to isolate a daemon). The daemon reads it each time
// it starts a child, so a change applies to new and respawned sessions without
// a restart; its mtime tells the switcher which running sessions are behind.
import * as fs from "node:fs";
import * as path from "node:path";
import { parseDocument } from "yaml";
import { DEFAULT_PI_CLI } from "./config.ts";
import { errText } from "./util.ts";
import { parseDurationText } from "./when.ts";

export type SteeringMode = "all" | "one-at-a-time";

export interface TorielSettings {
  /** How messages sent mid-run are delivered (default "all"). */
  steeringMode?: SteeringMode;
  /** Default provider / model / thinking level for sessions toriel starts. */
  provider?: string;
  model?: string;
  thinking?: string;
  /** Path of pi's cli.js. */
  piCli?: string;
  /** Model /summarize uses (provider/id); default litellm/local-model. */
  summaryModel?: string;
  /** Name an unnamed session from its first message with the summary model once its first turn ends (default true; a failure leaves it unnamed). */
  autoName?: boolean;
  /** Re-summarize changed sessions this often while toriel is open (default 60; 0 = never). */
  summaryIntervalMinutes?: number;
  /** A summary is refreshed once its session has this many new messages (default 6). */
  summaryMinNewMessages?: number;
  /** Scheduled runs pause while a usage window of the session's provider is at or above this percent (default 95; 0 = never pause). */
  scheduleUsagePause?: number;
  /** Most scheduled runs per 24 hours across all sessions (default 200; read when the daemon starts). */
  scheduleDailyLimit?: number;
  /** Keep the machine from sleeping while a session is working or a scheduled run is near (default true; needs systemd-inhibit). */
  preventSleep?: boolean;
  /** List sessions toriel has never run (plain pi, other instances) in the switcher (default false; /external toggles it for one run). */
  showExternalSessions?: boolean;
  /** Most permission grants one session may hold (default 100; read when the daemon starts). */
  permissionGrantLimit?: number;
  /** Lifetimes the permission dialog offers as "allow for ..." rows: durations, or "session" for until revoked (default ["1h", "session"]; [] = none). */
  permissionGrantDurations?: string[];
  /** Config allows the scope-guard doctor check treats as deliberate and does not flag: {surface, pattern} entries (surface "external_directory_write", "external_directory" or "*"; pattern a config glob). */
  scopeGuardAcceptedAllows?: Array<{ surface: string; pattern: string }>;
  /** Warn when pi-permission-system is not installed or has no usable config (default true). */
  warnNoPermissionSystem?: boolean;
  /** "bwrap" runs each bash command of a directory-scoped session in a bubblewrap sandbox whose only writable places are the scope root and a few others (default "off"; read when a session starts). */
  sandbox?: "off" | "bwrap";
  /** Extra places a sandboxed command may write, absolute or ~/ paths, mainly package caches (default ~/.npm and ~/.cache; [] = none). */
  sandboxWritable?: string[];
  /** Deleted sessions (and rewind/clear backups) stay in the trash this many days (default 90; 0 = keep forever; read daily by the daemon). */
  trashRetentionDays?: number;
  /** Subagents running at once, daemon-wide (default 3; read when the daemon starts). */
  subagentMaxConcurrent?: number;
  /** How many subagent links may sit above a session that spawns (default 1: only your own sessions spawn; at most 2; read when the daemon starts). */
  subagentMaxDepth?: number;
  /** Subagents one session may start over its lifetime in this daemon (default 20; read when the daemon starts). */
  subagentMaxSpawns?: number;
  /** Token budget of one subagent whose profile sets none (default 150000; read when the daemon starts). */
  subagentBudgetTokens?: number;
  /** A finished subagent stays in the switcher this many minutes before it is deleted to the trash (default 30; 0 = at once; read when the daemon starts; TORIEL_SUBAGENT_KEEP_MS wins). */
  subagentKeepMinutes?: number;
}

/** How long the trash keeps a deleted session unless the settings say otherwise. */
export const DEFAULT_TRASH_RETENTION_DAYS = 90;

/** The caches sandboxed commands may write when the settings do not say. */
export const DEFAULT_SANDBOX_WRITABLE: readonly string[] = ["~/.npm", "~/.cache"];

export interface LoadedSettings {
  settings: TorielSettings;
  /** Problems found (unreadable JSON, wrong types, unknown keys); the rest still applies. */
  problems: string[];
}

function configDir(env: NodeJS.ProcessEnv): string {
  return path.join(env.XDG_CONFIG_HOME ?? path.join(env.HOME ?? "", ".config"), "toriel");
}

/** Where the settings file lives (settings.yaml), whether or not it exists yet. TORIEL_SETTINGS names a file of any name. */
export function yamlSettingsFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.TORIEL_SETTINGS || path.join(configDir(env), "settings.yaml");
}

/** The settings.json of before the YAML switch; undefined when TORIEL_SETTINGS names the file (nothing to convert). */
export function legacySettingsFile(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.TORIEL_SETTINGS ? undefined : path.join(configDir(env), "settings.json");
}

/** The file settings are read from: settings.yaml, or a not-yet-converted settings.json when that is all there is. */
export function settingsFile(env: NodeJS.ProcessEnv = process.env): string {
  const yaml = yamlSettingsFile(env);
  const legacy = legacySettingsFile(env);
  return legacy !== undefined && !fs.existsSync(yaml) && fs.existsSync(legacy) ? legacy : yaml;
}

/** Modification time of the settings file; null when it does not exist. */
export function settingsMtime(file: string = settingsFile()): number | null {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

const NUMBER_KEYS = ["summaryIntervalMinutes", "summaryMinNewMessages", "scheduleUsagePause", "scheduleDailyLimit", "permissionGrantLimit", "trashRetentionDays", "subagentMaxConcurrent", "subagentMaxDepth", "subagentMaxSpawns", "subagentBudgetTokens", "subagentKeepMinutes"] as const;
const BOOLEAN_KEYS = ["warnNoPermissionSystem", "preventSleep", "showExternalSessions", "autoName"] as const;
/** Number settings where 0 is a meaningful "off". */
const ZERO_OK: readonly string[] = ["summaryIntervalMinutes", "scheduleUsagePause", "trashRetentionDays", "subagentKeepMinutes"];
const STRING_KEYS = ["provider", "model", "thinking", "piCli", "summaryModel"] as const;
/** Every key the file may hold; the commented template (settings-file.ts) must cover all of them. */
export const SETTING_KEYS: readonly string[] = ["steeringMode", "permissionGrantDurations", "sandbox", "sandboxWritable", "scopeGuardAcceptedAllows", ...BOOLEAN_KEYS, ...STRING_KEYS, ...NUMBER_KEYS];
/** The surfaces a scopeGuardAcceptedAllows entry may name ("*" is the config fallback). */
const SCOPE_GUARD_SURFACES = ["external_directory_write", "external_directory", "*"] as const;

/** Valid when it is a list of at most 20 objects, each with a known surface and a non-empty pattern. */
function validAcceptedAllows(value: unknown): value is Array<{ surface: string; pattern: string }> {
  return (
    Array.isArray(value) &&
    value.length <= 20 &&
    value.every((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        return false;
      }
      const { surface, pattern } = entry as { surface?: unknown; pattern?: unknown };
      return typeof surface === "string" && (SCOPE_GUARD_SURFACES as readonly string[]).includes(surface) && typeof pattern === "string" && pattern.length > 0;
    })
  );
}

const loadCache = new Map<string, { stamp: string; loaded: LoadedSettings }>();

/** Read and validate the settings file. The daemon asks every few seconds, so an unchanged file (same mtime and size) is served from a cache; callers get their own copy. */
export function loadSettings(file: string = settingsFile()): LoadedSettings {
  let stamp = "";
  try {
    const st = fs.statSync(file);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    loadCache.delete(file);
    return { settings: {}, problems: [] };
  }
  const hit = loadCache.get(file);
  if (hit?.stamp === stamp) {
    return structuredClone(hit.loaded);
  }
  const loaded = parseSettingsFile(file);
  loadCache.set(file, { stamp, loaded });
  return structuredClone(loaded);
}

function parseSettingsFile(file: string): LoadedSettings {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { settings: {}, problems: [] }; // no file is normal
  }
  // YAML, of which JSON is a subset, so a settings.json (or a TORIEL_SETTINGS file written as JSON) still reads
  const doc = parseDocument(raw);
  if (doc.errors.length > 0) {
    return { settings: {}, problems: [`${file}: ${errText(doc.errors[0])}`] };
  }
  const json: unknown = doc.toJS();
  if (json === null || json === undefined) {
    return { settings: {}, problems: [] }; // an empty file, or one that is all comments
  }
  if (typeof json !== "object" || Array.isArray(json)) {
    return { settings: {}, problems: [`${file}: expected a mapping of setting names to values`] };
  }
  const obj = json as Record<string, unknown>;
  const settings: TorielSettings = {};
  const problems: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (key === "steeringMode") {
      if (value === "all" || value === "one-at-a-time") {
        settings.steeringMode = value;
      } else {
        problems.push(`steeringMode must be "all" or "one-at-a-time"`);
      }
    } else if (key === "permissionGrantDurations") {
      if (Array.isArray(value) && value.length <= 5 && value.every((d) => typeof d === "string" && (d === "session" || parseDurationText(d).ok))) {
        settings.permissionGrantDurations = value as string[];
      } else {
        problems.push(`permissionGrantDurations must be a list of at most 5 durations such as ["1h", "8h", "session"]`);
      }
    } else if (key === "sandbox") {
      if (value === "off" || value === "bwrap") {
        settings.sandbox = value;
      } else {
        problems.push(`sandbox must be "off" or "bwrap"`);
      }
    } else if (key === "sandboxWritable") {
      if (Array.isArray(value) && value.length <= 20 && value.every((p) => typeof p === "string" && (p.startsWith("/") || p.startsWith("~/")) && p.length > 2)) {
        settings.sandboxWritable = value as string[];
      } else {
        problems.push(`sandboxWritable must be a list of at most 20 absolute or ~/ paths such as ["~/.npm", "~/.cache"]`);
      }
    } else if (key === "scopeGuardAcceptedAllows") {
      if (validAcceptedAllows(value)) {
        settings.scopeGuardAcceptedAllows = value;
      } else {
        problems.push(`scopeGuardAcceptedAllows must be a list of {surface, pattern} entries (surface: "external_directory_write", "external_directory" or "*")`);
      }
    } else if ((BOOLEAN_KEYS as readonly string[]).includes(key)) {
      if (typeof value === "boolean") {
        settings[key as (typeof BOOLEAN_KEYS)[number]] = value;
      } else {
        problems.push(`${key} must be true or false`);
      }
    } else if ((STRING_KEYS as readonly string[]).includes(key)) {
      if (typeof value === "string" && value.length > 0) {
        settings[key as (typeof STRING_KEYS)[number]] = value;
      } else {
        problems.push(`${key} must be a non-empty string`);
      }
    } else if ((NUMBER_KEYS as readonly string[]).includes(key)) {
      // some may be 0 (off); the other counts must be positive
      const min = ZERO_OK.includes(key) ? 0 : 1;
      if (typeof value === "number" && Number.isFinite(value) && value >= min) {
        settings[key as (typeof NUMBER_KEYS)[number]] = value;
      } else {
        problems.push(`${key} must be a number${min === 0 ? " (0 turns it off)" : " of at least 1"}`);
      }
    } else {
      problems.push(`unknown setting "${key}"`);
    }
  }
  return { settings, problems };
}

export interface ChildConfig {
  steeringMode: SteeringMode;
  provider?: string;
  model?: string;
  thinking?: string;
  piCli: string;
}

/** Defaults < file < environment. */
export function resolveChildConfig(s: TorielSettings, env: NodeJS.ProcessEnv = process.env): ChildConfig {
  const mode = env.TORIEL_STEERING_MODE ?? s.steeringMode;
  return {
    steeringMode: mode === "one-at-a-time" ? "one-at-a-time" : "all",
    provider: env.TORIEL_PROVIDER ?? s.provider,
    model: env.TORIEL_MODEL ?? s.model,
    thinking: env.TORIEL_THINKING ?? s.thinking,
    piCli: env.TORIEL_PI_CLI ?? s.piCli ?? DEFAULT_PI_CLI,
  };
}
