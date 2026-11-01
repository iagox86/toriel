// toriel doctor: every setup requirement in one place, graded by how much it matters, with the
// exact fix for each and (for the safe ones) a `--fix`. `toriel doctor` and /doctor print it; the
// daemon logs its findings at start and the controller's notice line shows the required and
// recommended ones, with a count of the rest.
//
// KEEP THIS CURRENT (AGENTS.md): anything a user has to install, configure or set for a feature to
// work needs an entry in CATALOG below and a finding from collectFindings (or from the resource
// audit in resources.ts), a test, and a line in docs/reference.md "Doctor". When a requirement
// changes or goes away, change or remove its check. test/doctor.test.ts fails when a finding
// carries an id the catalog does not list.
import { accessSync, constants, copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { piAgentDir } from "./pi-dir.ts";
import { startupProblems } from "./preflight.ts";
import { type AuditOptions, auditFindings, type Finding, type Fix, type Level, PI_RESOURCES_DIR } from "./resources.ts";
import { loadSettings, resolveChildConfig } from "./settings.ts";
import { writeFileAtomic } from "./util.ts";

export interface CatalogEntry {
  /** The id findings carry. */
  id: string;
  level: Level;
  /** What passing means, shown on an OK line. */
  title: string;
  /** Only checkable when the permission package is set up; otherwise shown as skipped. */
  needsPermissionPackage?: boolean;
}

/** Every check doctor makes, in the order it prints them within a level. */
export const CATALOG: readonly CatalogEntry[] = [
  { id: "startup", level: "required", title: "node, dependencies and the socket directory" },
  { id: "pi-setup", level: "required", title: "pi is set up (a config directory and a readable settings.json)" },
  { id: "pi-cli", level: "required", title: "pi's cli.js is where toriel expects it" },
  { id: "toriel-files", level: "required", title: "toriel's own extensions and skills are all present" },
  { id: "stale-links", level: "required", title: "no old toriel links in pi's agent directory" },
  { id: "settings", level: "recommended", title: "the toriel settings file is valid" },
  { id: "permission-package", level: "recommended", title: "pi-permission-system is installed and has a usable config" },
  { id: "grants-chain", level: "feature", title: 'permission grants are switched on ("toriel-grants" in authorizerChain)', needsPermissionPackage: true },
  { id: "sleep-lock", level: "feature", title: "the machine is kept awake for scheduled runs (systemd-inhibit)" },
  { id: "grants-path-rule", level: "hardening", title: "an agent cannot edit the permission grants file unasked (a path rule)", needsPermissionPackage: true },
];

const LEVELS: ReadonlyArray<{ level: Level; heading: string }> = [
  { level: "required", heading: "Required (toriel does not work without these)" },
  { level: "recommended", heading: "Recommended (without these sessions run unguarded, or ask about everything)" },
  { level: "feature", heading: "Optional features (only matter if you use them)" },
  { level: "hardening", heading: "Hardening (makes tampering harder; no feature needs it)" },
];

export interface DoctorOptions extends AuditOptions {
  agentDir?: string;
  /** The pi/ resources directory (default: this checkout's). */
  root?: string;
  env?: NodeJS.ProcessEnv;
  settingsFile?: string;
  nodeVersion?: string;
  platform?: NodeJS.Platform;
  /** pi's cli.js (default: the settings, environment and built-in default, as the daemon resolves it). */
  piCli?: string;
  /** Directories searched for executables (default: PATH). */
  pathDirs?: readonly string[];
  /** Start-up problems already known, instead of running the preflight checks (the running daemon and controller pass []). */
  startup?: readonly string[];
}

function onPath(name: string, dirs: readonly string[]): boolean {
  return dirs.some((dir) => {
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** Everything wrong that doctor can see, graded; the resource audit's findings plus the ones that need settings and the environment. */
export function collectFindings(opts: DoctorOptions = {}): Finding[] {
  const env = opts.env ?? process.env;
  const out: Finding[] = [];
  for (const message of opts.startup ?? startupProblems(env, opts.nodeVersion)) {
    out.push({ id: "startup", level: "required", message });
  }
  out.push(...auditFindings(opts.agentDir ?? piAgentDir(), opts.root ?? PI_RESOURCES_DIR, opts));
  const loaded = loadSettings(opts.settingsFile);
  for (const problem of loaded.problems) {
    out.push({ id: "settings", level: "recommended", message: `toriel settings: ${problem}` });
  }
  const piCli = opts.piCli ?? resolveChildConfig(loaded.settings, env).piCli;
  if (!existsSync(piCli)) {
    out.push({ id: "pi-cli", level: "required", message: `pi's cli.js is not at ${piCli}: run npm install in the toriel checkout, or set piCli in the toriel settings` });
  }
  const dirs = opts.pathDirs ?? (env.PATH ?? "").split(delimiter).filter(Boolean);
  if ((opts.platform ?? process.platform) === "linux" && loaded.settings.preventSleep !== false && !onPath("systemd-inhibit", dirs)) {
    out.push({ id: "sleep-lock", level: "feature", message: 'systemd-inhibit is not on PATH, so the machine can sleep through a scheduled run (install systemd, or set "preventSleep": false in the toriel settings to stop asking)' });
  }
  return out;
}

export interface Check extends CatalogEntry {
  state: "ok" | "problem" | "skipped";
  findings: Finding[];
  note?: string;
}

/** Run every check. A finding whose id the catalog lacks still shows (as its own check), so nothing is ever dropped. */
export function runDoctor(opts: DoctorOptions = {}): Check[] {
  const findings = collectFindings({ ...opts, permissionSystem: opts.permissionSystem ?? true });
  const noPackage = findings.some((f) => f.id === "permission-package");
  const known = new Set(CATALOG.map((c) => c.id));
  const checks: Check[] = CATALOG.map((entry) => {
    const mine = findings.filter((f) => f.id === entry.id);
    if (mine.length > 0) {
      return { ...entry, state: "problem", findings: mine };
    }
    if (noPackage && entry.needsPermissionPackage) {
      return { ...entry, state: "skipped", findings: [], note: "needs pi-permission-system (see above)" };
    }
    return { ...entry, state: "ok", findings: [] };
  });
  for (const f of findings.filter((x) => !known.has(x.id))) {
    checks.push({ id: f.id, level: f.level, title: f.id, state: "problem", findings: [f] });
  }
  return checks;
}

/**
 * The report: a section per level, an OK or PROBLEM line per check, the fix under each problem.
 * `compact` (the in-app panel, which cannot scroll) leaves the passing checks out and counts them.
 */
export function renderDoctor(checks: readonly Check[], opts: { compact?: boolean } = {}): string {
  const lines = ["toriel doctor"];
  for (const { level, heading } of LEVELS) {
    const inLevel = checks.filter((c) => c.level === level);
    if (inLevel.length === 0) {
      continue;
    }
    const passing = inLevel.filter((c) => c.state === "ok").length;
    if (opts.compact && passing === inLevel.length) {
      lines.push("", `${heading.split(" (")[0]}: all ${passing} ok`);
      continue;
    }
    lines.push("", heading);
    for (const c of opts.compact ? inLevel.filter((x) => x.state !== "ok") : inLevel) {
      const tag = c.state === "ok" ? "ok     " : c.state === "skipped" ? "skipped" : "PROBLEM";
      lines.push(`  ${tag}  ${c.title}`);
      if (c.state === "skipped" && c.note) {
        lines.push(`           ${c.note}`);
      }
      for (const f of c.findings) {
        lines.push(`           ${f.message}${f.fix ? `  [fixable: ${f.fix.summary}]` : ""}`);
      }
    }
    if (opts.compact && passing > 0) {
      lines.push(`  (${passing} ok)`);
    }
  }
  const problems = checks.reduce((n, c) => n + c.findings.length, 0);
  const fixable = plannedFixes(checks).reduce((n, g) => n + g.fixes.length, 0);
  lines.push("");
  if (problems === 0) {
    lines.push("Everything checks out.");
  } else {
    lines.push(`${problems} problem${problems === 1 ? "" : "s"}${fixable > 0 ? `, ${fixable} fixable automatically (toriel doctor --fix, or /doctor --fix)` : ""}.`);
  }
  return lines.join("\n");
}

/** 1 when something required is wrong (toriel will not work), else 0: recommendations never fail a script. */
export function exitCode(checks: readonly Check[]): 0 | 1 {
  return checks.some((c) => c.level === "required" && c.state === "problem") ? 1 : 0;
}

/** The automatic fixes on offer, grouped by the file they edit. */
export function plannedFixes(checks: readonly Check[]): Array<{ file: string; fixes: Fix[] }> {
  const byFile = new Map<string, Fix[]>();
  for (const f of checks.flatMap((c) => c.findings)) {
    if (f.fix) {
      byFile.set(f.fix.file, [...(byFile.get(f.fix.file) ?? []), f.fix]);
    }
  }
  return [...byFile].map(([file, fixes]) => ({ file, fixes }));
}

function readConfig(file: string): Record<string, unknown> {
  const json: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new Error(`${file} is not a JSON object`);
  }
  return json as Record<string, unknown>;
}

function edited(file: string, fixes: readonly Fix[]): { before: string; after: string } {
  const config = readConfig(file);
  const result = fixes.reduce<Record<string, unknown>>((c, fix) => fix.edit(structuredClone(c)), config);
  return { before: JSON.stringify(config, null, 2), after: JSON.stringify(result, null, 2) };
}

/** A line diff with two lines of context; empty when nothing would change. The file is compared as two-space JSON, which is also how it is written back. */
export function lineDiff(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? (lcs[i + 1]![j + 1] as number) + 1 : Math.max(lcs[i + 1]![j] as number, lcs[i]![j + 1] as number);
    }
  }
  const ops: Array<{ op: " " | "+" | "-"; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ op: " ", text: a[i] as string });
      i++;
      j++;
    } else if (j < b.length && (i === a.length || (lcs[i]![j + 1] as number) > (lcs[i + 1]![j] as number))) {
      ops.push({ op: "+", text: b[j] as string });
      j++;
    } else {
      ops.push({ op: "-", text: a[i] as string });
      i++;
    }
  }
  const keep = ops.map((o, k) => o.op !== " " || ops.slice(Math.max(0, k - 2), k + 3).some((n) => n.op !== " "));
  if (!ops.some((o) => o.op !== " ")) {
    return "";
  }
  const out: string[] = [];
  ops.forEach((o, k) => {
    if (keep[k]) {
      out.push(`${o.op} ${o.text}`);
    } else if (keep[k - 1]) {
      out.push("  ...");
    }
  });
  return out.join("\n");
}

/** What applying `fixes` to `file` would change, as a diff. Throws when the file cannot be read as a JSON object. */
export function previewFixes(file: string, fixes: readonly Fix[]): string {
  const { before, after } = edited(file, fixes);
  return lineDiff(before, after);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Apply `fixes` to `file`: the original is copied to `<file>.bak-<time>` first, then the file is replaced in one step (same mode). Returns the backup's path. */
export function applyFixes(file: string, fixes: readonly Fix[], now: Date = new Date()): string {
  const { after } = edited(file, fixes);
  const backup = `${file}.bak-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  copyFileSync(file, backup);
  writeFileAtomic(file, `${after}\n`, statSync(file).mode & 0o777);
  return backup;
}
