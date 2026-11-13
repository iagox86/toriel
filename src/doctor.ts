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
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { mcpWarnings, mergeMcpServers, loadAgents } from "./agents.ts";
import { piAgentDir } from "./pi-dir.ts";
import { startupProblems } from "./preflight.ts";
import { type AuditOptions, auditFindings, type Finding, type Fix, type Level, PI_RESOURCES_DIR, piPackageListed, resolution } from "./resources.ts";
import { legacySettingsFile, loadSettings, resolveChildConfig, settingsFile, yamlSettingsFile } from "./settings.ts";
import { convertLegacySettings, renderSettings } from "./settings-file.ts";
import { onPathDirs as onPath, writeFileAtomic } from "./util.ts";

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
  { id: "settings-file", level: "recommended", title: "toriel has a settings file (the defaults, written out with a comment each, to edit)" },
  { id: "settings-yaml", level: "feature", title: "the toriel settings are in settings.yaml (an old settings.json is converted, comments added)" },
  { id: "permission-package", level: "recommended", title: "pi-permission-system is installed and has a usable config" },
  { id: "grants-chain", level: "feature", title: 'permission grants are switched on ("toriel-grants" in authorizerChain)', needsPermissionPackage: true },
  { id: "mcp-git-direct", level: "feature", title: 'the git MCP server is configured with "exposure": "direct" (the code-review, git-archaeology and advisory-diff agents need it)' },
  { id: "web-package", level: "feature", title: "pi-web-access is installed (the research-web and advisory-diff agents need its web tools)" },
  { id: "mcp-gdb-direct", level: "feature", title: 'the gdb MCP server is configured with "exposure": "direct" (the debug and crash-analysis agents need it)' },
  { id: "mcp-ghidra-direct", level: "feature", title: 'the ghidra MCP server is configured with "exposure": "direct" (the re-explain, re-find, re-trace and binary-diff agents need it)' },
  { id: "sandbox-bwrap", level: "feature", title: 'bubblewrap works (needed only when the "sandbox" setting is "bwrap": scoped sessions run each bash command sandboxed)' },
  { id: "sleep-lock", level: "feature", title: "the machine is kept awake for scheduled runs (systemd-inhibit)" },
  { id: "clipboard", level: "feature", title: "clipboard tools for paste and copy (wl-clipboard on Wayland, xclip on X11)" },
  { id: "truecolor", level: "feature", title: "the terminal shows toriel's theme as intended (truecolor)" },
  { id: "grants-path-rule", level: "hardening", title: "an agent cannot edit the permission grants file unasked (a path rule)", needsPermissionPackage: true },
  { id: "permission-package-scope-patch", level: "hardening", title: "the installed pi-permission-system carries the toriel scope patch (a trusted project config cannot override a scope root)", needsPermissionPackage: true },
  { id: "scope-guard-short-circuit", level: "hardening", title: 'no config allow short-circuits the scope guard for directory-scoped sessions (external_directory_write, the bare external_directory, the "*" fallback)', needsPermissionPackage: true },
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
  /** Runs bwrap once and says why it cannot, or undefined when it works (default: really runs it; tests inject). */
  probeBwrap?: () => string | undefined;
}

/**
 * Run bubblewrap once. `which bwrap` is not enough: it also needs unprivileged user namespaces,
 * which some systems disable, and then every sandboxed command would fail.
 */
export function probeBwrap(): string | undefined {
  const r = spawnSync("bwrap", ["--ro-bind", "/", "/", "true"], { encoding: "utf8", timeout: 5000 });
  if (r.error !== undefined) {
    return (r.error as NodeJS.ErrnoException).code === "ENOENT" ? "bwrap is not installed (the bubblewrap package)" : `bwrap could not run: ${r.error.message}`;
  }
  if (r.status !== 0) {
    return `bwrap runs but cannot start a sandbox (${(r.stderr ?? "").trim().split("\n")[0] || `exit ${r.status}`}); unprivileged user namespaces may be disabled`;
  }
  return undefined;
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

/** The text a fix would write, shown as added lines. */
function asAddition(text: string): string {
  return text.trimEnd().split("\n").map((line) => `+ ${line}`).join("\n");
}

/** No settings file at all, or an old settings.json beside no settings.yaml: each with the fix that writes the new file. */
function settingsFileFindings(explicit: string | undefined, env: NodeJS.ProcessEnv): Finding[] {
  const yaml = explicit ?? yamlSettingsFile(env);
  const legacy = explicit === undefined ? legacySettingsFile(env) : undefined;
  if (existsSync(yaml)) {
    return [];
  }
  if (legacy !== undefined && existsSync(legacy)) {
    const from = legacy;
    return [{
      id: "settings-yaml",
      level: "feature",
      message: `the toriel settings are still in ${from}; they now live in ${yaml}, a YAML file that can carry comments (the old file is still read until it is converted)`,
      fix: {
        file: yaml,
        summary: `write ${yaml} from ${from}, with a comment above each setting, and set ${from} aside`,
        edit: (c) => c,
        custom: {
          preview: () => `${yaml} would hold:\n${asAddition(convertLegacySettings(readFileSync(from, "utf8")))}\n${from} would be renamed (kept as a backup).`,
          apply: (now) => {
            // converted first, so a file that cannot be read leaves both untouched
            const text = convertLegacySettings(readFileSync(from, "utf8"));
            writeFileAtomic(yaml, text);
            const backup = backupPath(from, now);
            renameSync(from, backup);
            return backup;
          },
        },
      },
    }];
  }
  return [{
    id: "settings-file",
    level: "recommended",
    message: `there is no toriel settings file (${yaml}): everything runs on built-in defaults, and nothing shows which of them you can change`,
    fix: {
      file: yaml,
      summary: `create ${yaml} holding the defaults, a comment above each`,
      edit: (c) => c,
      custom: {
        preview: () => `${yaml} would hold:\n${asAddition(renderSettings())}`,
        apply: () => {
          writeFileAtomic(yaml, renderSettings());
          return undefined;
        },
      },
    },
  }];
}

/** Everything wrong that doctor can see, graded; the resource audit's findings plus the ones that need settings and the environment. */
export function collectFindings(opts: DoctorOptions = {}): Finding[] {
  const env = opts.env ?? process.env;
  const out: Finding[] = [];
  for (const message of opts.startup ?? startupProblems(env, opts.nodeVersion)) {
    out.push({ id: "startup", level: "required", message, manual: "node, the dependencies and the runtime directory belong to the machine, not to a config file doctor edits" });
  }
  const settingsPath = opts.settingsFile ?? settingsFile(env);
  const loaded = loadSettings(settingsPath);
  out.push(...auditFindings(opts.agentDir ?? piAgentDir(), opts.root ?? PI_RESOURCES_DIR, { ...opts, scopeGuardAcceptedAllows: loaded.settings.scopeGuardAcceptedAllows }));
  for (const problem of loaded.problems) {
    out.push({ id: "settings", level: "recommended", message: `toriel settings: ${problem}`, manual: "the settings file is yours; doctor will not guess which value you meant" });
  }
  out.push(...settingsFileFindings(opts.settingsFile, env));
  const piCli = opts.piCli ?? resolveChildConfig(loaded.settings, env).piCli;
  if (!existsSync(piCli)) {
    out.push({ id: "pi-cli", level: "required", message: `pi's cli.js is not at ${piCli}: run npm install in the toriel checkout, or set piCli in the toriel settings`, manual: "needs npm install in the checkout (a package install) or a piCli path only you know" });
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
      manual: "the patch edits the installed package's source, which a package update overwrites; apply it by hand from pi/patches/scope-config-patch.md",
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
      // fixable only when the entry is here with the wrong exposure; a missing entry needs the
      // server's own command/args, which are machine-specific (where it is installed, which runner),
      // so doctor does not invent them and says so
      const info = servers[server.name];
      out.push({
        id: `mcp-${server.name}-direct`,
        level: "feature",
        message:
          info === undefined
            ? `the "${server.name}" MCP server is missing from ${mcpFile}: the ${nameList(users.map((a) => a.name))} ${users.length > 1 ? "agents need" : "agent needs"} it (${server.hint}) with "exposure": "direct"; without it ${users.length > 1 ? "they have" : "it has"} no ${server.name} tool`
            : `the ${nameList(users.map((a) => a.name))} ${users.length > 1 ? "agents need" : "agent needs"} the "${server.name}" MCP server (${server.hint}) with "exposure": "direct" in ${mcpFile}; without it ${users.length > 1 ? "they have" : "it has"} no ${server.name} tool (${problems[0]})`,
        ...resolution(
          info !== undefined && info.exposure !== "direct"
            ? {
                file: mcpFile,
                summary: `set "exposure": "direct" on the "${server.name}" entry`,
                edit: (c) => {
                  const entries = isJsonObject(c.mcpServers) ? c.mcpServers : {};
                  const raw = entries[server.name];
                  const entry = isJsonObject(raw) ? raw : {};
                  return { ...c, mcpServers: { ...entries, [server.name]: { ...entry, exposure: "direct" } } };
                },
              }
            : undefined,
          `there is no "${server.name}" entry to fix, and its command depends on where the server is installed on this machine, so add it by hand (${server.hint}) with "exposure": "direct"`,
        ),
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
      manual: "installing a pi package and choosing a search provider are yours to do; doctor does not run installs",
    });
  }
  // the per-command sandbox (board 190) refuses to run a command rather than run it unsandboxed, so a setting that asks for bwrap without a working bwrap would stop every scoped session's bash
  if (loaded.settings.sandbox === "bwrap") {
    const why = (opts.probeBwrap ?? probeBwrap)();
    if (why !== undefined) {
      out.push({ id: "sandbox-bwrap", level: "feature", message: `the toriel setting "sandbox" is "bwrap" but ${why}; scoped sessions would refuse every bash command (install bubblewrap and enable user namespaces, or set "sandbox": "off")`, manual: 'installing bubblewrap is a system package install, and switching the sandbox off would drop protection you asked for' });
    }
  }
  const dirs = opts.pathDirs ?? (env.PATH ?? "").split(delimiter).filter(Boolean);
  if ((opts.platform ?? process.platform) === "linux" && loaded.settings.preventSleep !== false && !onPath("systemd-inhibit", dirs)) {
    out.push({ id: "sleep-lock", level: "feature", message: 'systemd-inhibit is not on PATH, so the machine can sleep through a scheduled run (install systemd, or set "preventSleep": false in the toriel settings to stop asking)', manual: "installing systemd is a system package install; the alternative setting turns off a feature you may want" });
  }
  const display = env.WAYLAND_DISPLAY ? "wayland" : env.DISPLAY ? "x11" : undefined;
  if (display === "wayland" && !(onPath("wl-paste", dirs) && onPath("wl-copy", dirs))) {
    out.push({ id: "clipboard", level: "feature", message: "wl-clipboard is not on PATH, so paste and /btw's copy have no clipboard (install wl-clipboard; copying may still work through the terminal)", manual: "installing wl-clipboard is a system package install" });
  } else if (display === "x11" && !onPath("xclip", dirs)) {
    out.push({ id: "clipboard", level: "feature", message: "xclip is not on PATH, so paste and /btw's copy have no clipboard (install xclip; copying may still work through the terminal)", manual: "installing xclip is a system package install" });
  }
  if (opts.tty === true) {
    const term = `${env.COLORTERM ?? ""} ${env.TERM ?? ""}`;
    if (!/truecolor|24bit/i.test(term) && !/kitty|ghostty|wezterm|contour|foot/i.test(term)) {
      out.push({ id: "truecolor", level: "feature", message: "the terminal does not advertise truecolor (COLORTERM/TERM), so toriel's theme colors are approximated; a terminal with truecolor support shows them as intended", manual: "the terminal emulator's capability, not a config file" });
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
        lines.push(`           ${f.message}  ${f.fix ? `[fixable: ${f.fix.summary}]` : `[manual: ${f.manual}]`}`);
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
    const manual = problems - fixable;
    const parts = [
      fixable > 0 ? `${fixable} fixable automatically (toriel doctor --fix, or /doctor --fix)` : "",
      manual > 0 ? `${manual} need${manual === 1 ? "s" : ""} you (see "manual" above)` : "",
    ].filter(Boolean);
    lines.push(`${st.problem(`${problems} problem${problems === 1 ? "" : "s"}`)}${parts.length > 0 ? `, ${parts.join(", ")}` : ""}.`);
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

/** A JSON object value; the exposure fix spreads only entries it can spread and rebuilds anything else. */
function isJsonObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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
  if (fixes.some((f) => f.custom)) {
    return fixes.map((f) => f.custom?.preview() ?? "").join("\n");
  }
  const { before, after } = edited(file, fixes);
  return lineDiff(before, after);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `<file>.bak-<time>`: where the original of a changed file is kept. */
function backupPath(file: string, now: Date): string {
  return `${file}.bak-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** Apply `fixes` to `file`: the original is copied to `<file>.bak-<time>` first, then the file is replaced in one step (same mode). Returns the backup's path, or undefined when a fix created a file and there was no original. */
export function applyFixes(file: string, fixes: readonly Fix[], now: Date = new Date()): string | undefined {
  if (fixes.some((f) => f.custom)) {
    return fixes.map((f) => f.custom?.apply(now)).find((b) => b !== undefined);
  }
  const { after } = edited(file, fixes);
  const backup = backupPath(file, now);
  copyFileSync(file, backup);
  writeFileAtomic(file, `${after}\n`, statSync(file).mode & 0o777);
  return backup;
}
