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
import { delimiter, dirname, join } from "node:path";
import { mcpWarnings, mergeMcpServers, loadAgents } from "./agents.ts";
import { piAgentDir } from "./pi-dir.ts";
import { startupProblems } from "./preflight.ts";
import { type AuditOptions, auditFindings, type Finding, type Fix, type Level, PI_RESOURCES_DIR, piPackageListed } from "./resources.ts";
import { loadSettings, resolveChildConfig } from "./settings.ts";
import { writeFileAtomic } from "./util.ts";

const WEB_PACKAGE = "pi-web-access";
/** "a", "a and b", "a, b and c". */
function nameList(names: readonly string[]): string {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** MCP servers the shipped agent profiles use, with how to set each up (one doctor check per server). */
const MCP_AGENT_SERVERS: ReadonlyArray<{ name: string; hint: string }> = [
  { name: "git", hint: "toriel-git-mcp, started without --repository" },
  { name: "gdb", hint: "gdb-mcp, e.g. uv run gdb-mcp" },
  { name: "ghidra", hint: "a Ghidra MCP server" },
];

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
  { id: "mcp-git-direct", level: "feature", title: 'the git MCP server is configured with "exposure": "direct" (the code-review, git-archaeology and advisory-diff agents need it)' },
  { id: "web-package", level: "feature", title: "pi-web-access is installed (the research-web and advisory-diff agents need its web tools)" },
  { id: "mcp-gdb-direct", level: "feature", title: 'the gdb MCP server is configured with "exposure": "direct" (the debug and crash-analysis agents need it)' },
  { id: "mcp-ghidra-direct", level: "feature", title: 'the ghidra MCP server is configured with "exposure": "direct" (the re-explain, re-find, re-trace and binary-diff agents need it)' },
  { id: "sleep-lock", level: "feature", title: "the machine is kept awake for scheduled runs (systemd-inhibit)" },
  { id: "clipboard", level: "feature", title: "clipboard tools for paste and copy (wl-clipboard on Wayland, xclip on X11)" },
  { id: "truecolor", level: "feature", title: "the terminal shows toriel's theme as intended (truecolor)" },
  { id: "grants-path-rule", level: "hardening", title: "an agent cannot edit the permission grants file unasked (a path rule)", needsPermissionPackage: true },
  { id: "permission-package-scope-patch", level: "hardening", title: "the installed pi-permission-system carries the toriel scope patch (a trusted project config cannot override a scope root)", needsPermissionPackage: true },
  { id: "scope-guard-short-circuit", level: "hardening", title: 'no config allow short-circuits the scope guard for directory-scoped sessions (path, path_write, external_directory, write, edit, the "*" fallback)', needsPermissionPackage: true },
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
  /** Whether the report goes to a real terminal; the terminal checks only run then (the CLI passes stdout.isTTY). */
  tty?: boolean;
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

/**
 * Locate the installed @gotgenes/pi-permission-system package (the copy pi loads raw src
 * from): the tree pi's cli.js lives in, then the running node's global modules (an nvm
 * layout). Undefined when none of the candidates has the package's source tree.
 */
export function locatePermissionPackageSrc(piCli: string, execPath: string): string | undefined {
  const roots = [dirname(piCli), join(dirname(execPath), "..", "lib", "node_modules")];
  for (const root of roots) {
    for (const candidate of [join(root, "@gotgenes", "pi-permission-system"), join(root, "node_modules", "@gotgenes", "pi-permission-system")]) {
      if (existsSync(join(candidate, "src", "session", "permission-session.ts"))) {
        return candidate;
      }
    }
  }
  return undefined;
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
  // the scope patch: a trusted project config inside a scoped session's directory can
  // re-allow outside-scope writes (project policy outranks global and lives INSIDE the
  // scope root, writable by the agent), so the installed package must carry the two-site
  // patch that withholds project policy under TORIEL_SCOPE_ROOT (pi/patches/scope-config-patch.md)
  const pkgSrc = locatePermissionPackageSrc(piCli, env.TORIEL_NODE ?? process.execPath);
  if (pkgSrc !== undefined && !readFileSync(join(pkgSrc, "src", "session", "permission-session.ts"), "utf8").includes("toriel-scope-patch")) {
    out.push({
      id: "permission-package-scope-patch",
      level: "hardening",
      message: `the installed pi-permission-system at ${pkgSrc} lacks the toriel scope patch: a trusted project config inside a scoped session's directory could re-allow outside-scope writes; apply the two-site patch from pi/patches/scope-config-patch.md in the toriel checkout (package updates overwrite it; this check flags it again then)`,
    });
  }
  // shipped agents that name mcp__<server>__* tools: pi gives an agent an MCP tool only when its server is exposed directly
  const shipped = loadAgents(process.cwd(), env).agents.filter((a) => a.source === "built-in");
  const mcpFile = join(opts.agentDir ?? piAgentDir(env), "mcp.json");
  const servers = mergeMcpServers([mcpFile]);
  for (const server of MCP_AGENT_SERVERS) {
    const users = shipped.filter((a) => (a.tools ?? []).some((t) => t.startsWith(`mcp__${server.name}__`)));
    const problems = users.flatMap((a) => mcpWarnings(a, servers));
    if (users.length > 0 && problems.length > 0) {
      out.push({
        id: `mcp-${server.name}-direct`,
        level: "feature",
        message: `the ${nameList(users.map((a) => a.name))} ${users.length > 1 ? "agents need" : "agent needs"} an MCP server named "${server.name}" (${server.hint}) with "exposure": "direct" in ${mcpFile}; without it ${users.length > 1 ? "they have" : "it has"} no ${server.name} tool (${problems[0]})`,
      });
    }
  }
  // the shipped research-web agent names pi-web-access's tools; without the package it has nothing to search with
  const webAgents = shipped.filter((a) => (a.tools ?? []).some((t) => t === "web_search" || t === "fetch_content"));
  if (webAgents.length > 0 && piPackageListed(opts.agentDir ?? piAgentDir(env), WEB_PACKAGE) === false) {
    out.push({
      id: "web-package",
      level: "feature",
      message: `the ${nameList(webAgents.map((a) => a.name))} ${webAgents.length > 1 ? "agents need" : "agent needs"} ${WEB_PACKAGE} in the packages of ${join(opts.agentDir ?? piAgentDir(env), "settings.json")} (pi install npm:${WEB_PACKAGE}) and a search provider set up for it; without it the agent has no web tools`,
    });
  }
  const dirs = opts.pathDirs ?? (env.PATH ?? "").split(delimiter).filter(Boolean);
  if ((opts.platform ?? process.platform) === "linux" && loaded.settings.preventSleep !== false && !onPath("systemd-inhibit", dirs)) {
    out.push({ id: "sleep-lock", level: "feature", message: 'systemd-inhibit is not on PATH, so the machine can sleep through a scheduled run (install systemd, or set "preventSleep": false in the toriel settings to stop asking)' });
  }
  const display = env.WAYLAND_DISPLAY ? "wayland" : env.DISPLAY ? "x11" : undefined;
  if (display === "wayland" && !(onPath("wl-paste", dirs) && onPath("wl-copy", dirs))) {
    out.push({ id: "clipboard", level: "feature", message: "wl-clipboard is not on PATH, so paste and /btw's copy have no clipboard (install wl-clipboard; copying may still work through the terminal)" });
  } else if (display === "x11" && !onPath("xclip", dirs)) {
    out.push({ id: "clipboard", level: "feature", message: "xclip is not on PATH, so paste and /btw's copy have no clipboard (install xclip; copying may still work through the terminal)" });
  }
  if (opts.tty === true) {
    const term = `${env.COLORTERM ?? ""} ${env.TERM ?? ""}`;
    if (!/truecolor|24bit/i.test(term) && !/kitty|ghostty|wezterm|contour|foot/i.test(term)) {
      out.push({ id: "truecolor", level: "feature", message: "the terminal does not advertise truecolor (COLORTERM/TERM), so toriel's theme colors are approximated; a terminal with truecolor support shows them as intended" });
    }
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

/** How the report is coloured; the default adds nothing. */
export interface DoctorStyle {
  heading(text: string): string;
  ok(text: string): string;
  problem(text: string): string;
  skipped(text: string): string;
  dim(text: string): string;
}

const identity = (text: string): string => text;
export const PLAIN_STYLE: DoctorStyle = { heading: identity, ok: identity, problem: identity, skipped: identity, dim: identity };

/** Plain ANSI for a terminal (the command line has no theme): green ok, red problem, dim skipped, bold headings. */
export const ANSI_STYLE: DoctorStyle = {
  heading: (t) => `\x1b[1m${t}\x1b[22m`,
  ok: (t) => `\x1b[32m${t}\x1b[39m`,
  problem: (t) => `\x1b[31m${t}\x1b[39m`,
  skipped: (t) => `\x1b[2m${t}\x1b[22m`,
  dim: (t) => `\x1b[2m${t}\x1b[22m`,
};

/**
 * The report: a section per level, an OK or PROBLEM line per check, the fix under each problem.
 * `compact` (the in-app panel, which cannot scroll) leaves the passing checks out and counts them.
 */
export function renderDoctor(checks: readonly Check[], opts: { compact?: boolean; style?: DoctorStyle } = {}): string {
  const st = opts.style ?? PLAIN_STYLE;
  const lines = [st.heading("toriel doctor")];
  for (const { level, heading } of LEVELS) {
    const inLevel = checks.filter((c) => c.level === level);
    if (inLevel.length === 0) {
      continue;
    }
    const passing = inLevel.filter((c) => c.state === "ok").length;
    if (opts.compact && passing === inLevel.length) {
      lines.push("", `${st.heading(heading.split(" (")[0] as string)}: ${st.ok(`all ${passing} ok`)}`);
      continue;
    }
    lines.push("", st.heading(heading));
    for (const c of opts.compact ? inLevel.filter((x) => x.state !== "ok") : inLevel) {
      const tag = c.state === "ok" ? st.ok("ok     ") : c.state === "skipped" ? st.skipped("skipped") : st.problem("PROBLEM");
      lines.push(`  ${tag}  ${c.title}`);
      if (c.state === "skipped" && c.note) {
        lines.push(`           ${c.note}`);
      }
      for (const f of c.findings) {
        lines.push(`           ${f.message}${f.fix ? `  [fixable: ${f.fix.summary}]` : ""}`);
      }
    }
    if (opts.compact && passing > 0) {
      lines.push(st.dim(`  (${passing} ok)`));
    }
  }
  const problems = checks.reduce((n, c) => n + c.findings.length, 0);
  const fixable = plannedFixes(checks).reduce((n, g) => n + g.fixes.length, 0);
  lines.push("");
  if (problems === 0) {
    lines.push(st.ok("Everything checks out."));
  } else {
    lines.push(`${st.problem(`${problems} problem${problems === 1 ? "" : "s"}`)}${fixable > 0 ? `, ${fixable} fixable automatically (toriel doctor --fix, or /doctor --fix)` : ""}.`);
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
