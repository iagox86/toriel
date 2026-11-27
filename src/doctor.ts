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
import { bundlesBytes, fmtBytes } from "./feedback-admin.ts";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { applyDrift, cachedFor, diffRoutes, type GatewayKind, type LitellmProbe, readGateways, readRoutesCache } from "./litellm-models.ts";
import { fmtClock } from "./when.ts";
import { mcpWarnings, mergeMcpServers, loadAgents } from "./agents.ts";
import { piAgentDir } from "./pi-dir.ts";
import { startupProblems } from "./preflight.ts";
import { type AuditOptions, auditFindings, type Finding, type Fix, type Level, PI_RESOURCES_DIR } from "./resources.ts";
import { legacySettingsFile, loadSettings, resolveChildConfig, settingsFile, yamlSettingsFile } from "./settings.ts";
import { addMcpServer, importMcpJson, readMcpYaml, redactEntry, renderMcpYaml, setMcpServerKey } from "./mcp-config.ts";
import { DIRECT_SHARE, exposureAdvice, type McpUsage, USAGE_WINDOW_DAYS } from "./mcp-usage.ts";
import { convertLegacySettings, renderSettings } from "./settings-file.ts";
import { mcpYamlFile } from "./config-dir.ts";
import type { ChatProbe } from "./bridge/probe-sync.ts";
import { chatClientInstalled, readToken } from "./bridge/token.ts";
import { onPathDirs as onPath, writeFileAtomic } from "./util.ts";

import { type BundledPackage, BUNDLED_PACKAGES, NODE_MODULES_DIR, packageState } from "./bundled-packages.ts";

const WEB_PACKAGE = "pi-web-access";
const webPackage = BUNDLED_PACKAGES.find((p) => p.name === WEB_PACKAGE) as BundledPackage;
const PERMISSION_PKG = "@gotgenes/pi-permission-system";
/** "a", "a and b", "a, b and c". */
function nameList(names: readonly string[]): string {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** MCP servers the shipped agent profiles use, with how to set each up (one doctor check per server). */
const MCP_AGENT_SERVERS: ReadonlyArray<{ name: string; hint: string }> = [
  { name: "git", hint: "toriel-git-mcp, started without --repository" },
  { name: "gdb", hint: "gdb-mcp, e.g. uv run gdb-mcp" },
  { name: "ghidra", hint: "a Ghidra MCP server" },
  { name: "vikunja", hint: "a Vikunja MCP server (an entry whose URL or command reaches your Vikunja instance)" },
];

export interface CatalogEntry {
  /** The id findings carry. */
  id: string;
  level: Level;
  /** What passing means, shown on an OK line. */
  title: string;
  /** Only checkable when the permission package is set up; otherwise shown as skipped. */
  needsPermissionPackage?: boolean;
  /** Only checked when the caller supplies a probe that asks the network (`toriel doctor` does; the in-app /doctor does not, because it would block the screen). */
  needsProbe?: GatewayKind;
  /** Only checked when the caller supplies the chat-server probe (`toriel doctor` does; the in-app /doctor does not, it would block the screen). */
  needsChatProbe?: boolean;
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
  { id: "mcp-git-server", level: "feature", title: "the git MCP server is configured in mcp.yaml (the code-review, git-archaeology and advisory-diff agents need it)" },
  { id: "web-package", level: "feature", title: "pi-web-access is installed (the research-web and advisory-diff agents need its web tools)" },
  { id: "bundled-packages", level: "feature", title: "the pi packages toriel carries are installed with it (ask_user_question, web search, the permission gate, memory; ticket 230)" },
  { id: "mcp-gdb-server", level: "feature", title: "the gdb MCP server is configured in mcp.yaml (the debug and crash-analysis agents need it)" },
  { id: "mcp-ghidra-server", level: "feature", title: "the ghidra MCP server is configured in mcp.yaml (the re-explain, re-find, re-trace and binary-diff agents need it)" },
  { id: "mcp-vikunja-server", level: "feature", title: "the vikunja MCP server is configured in mcp.yaml (the ticket-brief agent needs it)" },
  { id: "agent-lanes", level: "feature", title: "every model tier in agentLanes (cheap, medium, expensive) names a provider pi knows (models.json or a login)" },
  { id: "litellm-models", level: "feature", title: "pi's models.json matches what the litellm proxy says about each route (context window, output limit, cost)", needsProbe: "litellm" },
  { id: "bifrost-models", level: "feature", title: "pi's models.json matches what the bifrost gateway says about each route (context window, output limit)", needsProbe: "bifrost" },
  { id: "mcp-yaml", level: "recommended", title: "toriel's mcp.yaml (the MCP servers) is valid" },
  { id: "mcp-exposure", level: "recommended", title: "each MCP server's exposure fits how often sessions use it (declared at once when most do, found with tool_search otherwise; ticket 304)" },
  { id: "mcp-json", level: "recommended", title: "pi's own mcp.json holds no servers (toriel keeps them in mcp.yaml and pi would start the old ones itself)" },
  { id: "chat-bridge-token", level: "feature", title: "the chat bridge's token (the chatto setting's tokenFile or tokenEnv) can be read, and a token file is owner-only" },
  { id: "chat-bridge-package", level: "feature", title: "the chat bridge's package (@chatto/client) is installed, when the chatto setting is on" },
  { id: "chat-bridge-server", level: "feature", title: "the chat server answers and takes the bridge's token, the room group is visible to the bot, and the inbox channel is there or is made (its create is the bridge's own first call, so a room the bot cannot see holding the name is refused and said; rooms are otherwise not joined or posted)", needsChatProbe: true },
  { id: "sandbox-bwrap", level: "feature", title: 'bubblewrap works (needed only when the "sandbox" setting is "bwrap": scoped sessions run each bash command sandboxed)' },
  { id: "sleep-lock", level: "feature", title: "the machine is kept awake for scheduled runs (systemd-inhibit)" },
  { id: "notify-send", level: "feature", title: "desktop notifications for prompts in background sessions (notify-send)" },
  { id: "clipboard", level: "feature", title: "clipboard tools for paste and copy (wl-clipboard on Wayland, xclip on X11)" },
  { id: "tmux-keys", level: "feature", title: "tmux passes Shift+Enter through (extended-keys)" },
  { id: "tmux-hyperlinks", level: "feature", title: "tmux passes clickable links (OSC 8 hyperlinks) through to the terminal (terminal-features)" },
  { id: "kitty-shift-enter", level: "feature", title: "kitty sends Shift+Enter distinctly under tmux (kitty.conf mapping)" },
  { id: "truecolor", level: "feature", title: "the terminal shows toriel's theme as intended (truecolor)" },
  { id: "feedback-size", level: "feature", title: "the /feedback bundles do not take much disk (toriel feedback prune clears them)" },
  { id: "grants-path-rule", level: "hardening", title: "an agent cannot edit the permission grants file unasked (a path rule)", needsPermissionPackage: true },
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
  /** Where the bundled pi packages are installed (default: toriel's node_modules). */
  bundledRoot?: string;
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
  /** Whether the chat bridge's package loads (tests say it does not). */
  chatClientInstalled?: () => boolean;
  /** What tmux says about keys (default: asks the server this process runs under; tests inject). */
  probeTmux?: () => TmuxKeys;
  /** Asks the chat server what the bridge needs, without changing anything (ticket 293). Not set: the check is skipped ("run toriel doctor"). `toriel doctor` passes the real one. */
  probeChat?: ChatProbe;
  /** Asks the litellm proxy about its routes (ticket 215). Not set: the check is skipped ("run toriel doctor"). `toriel doctor` passes the real one. */
  probeLitellm?: LitellmProbe;
  /** What the daemon learned from litellm at start (ticket 221); read when `probeLitellm` is not set. The running daemon and controller pass theirs. */
  litellmCacheFile?: string;
  /** toriel's mcp.yaml (default: beside the settings file; tests inject). */
  mcpFile?: string;
  /** The text of kitty's config, including what it includes (default: read from kitty's config directory; tests inject). */
  kittyConfig?: string;
  /** The /feedback bundle folders (ticket 240). Not set: the size check is skipped (`toriel doctor` passes the real one). */
  feedbackDir?: string;
  /** How much recent sessions used each MCP server (ticket 304; reads pi's session files, so only `toriel doctor` passes it). Not set: the exposure check is skipped. */
  mcpUsage?: () => McpUsage;
}

/** Past this much disk, the bundle folders are worth a word (each holds a full copy of a session). */
export const FEEDBACK_SIZE_WARN_BYTES = 2 * 1024 ** 3;

/** What `probeTmux` learned; a field is undefined when tmux could not be asked. */
export interface TmuxKeys {
  /** The `extended-keys` option: "off", "on" or "always". */
  extendedKeys?: string;
  /** The TERM of the terminal tmux is attached to (not the pane's own TERM, which tmux sets). */
  clientTerm?: string;
  /** The terminal features tmux has switched on for that client (`#{client_termfeatures}`, "RGB,hyperlinks,..."); undefined when tmux is too old to say. */
  clientFeatures?: string;
}

function tmuxValue(args: string[]): string | undefined {
  const r = spawnSync("tmux", args, { encoding: "utf8", timeout: 2000 });
  return r.error === undefined && r.status === 0 ? r.stdout.trim() || undefined : undefined;
}

export function probeTmux(): TmuxKeys {
  return { extendedKeys: tmuxValue(["show-options", "-gv", "extended-keys"]), clientTerm: tmuxValue(["display-message", "-p", "#{client_termname}"]), clientFeatures: tmuxValue(["display-message", "-p", "#{client_termfeatures}"]) };
}

/** kitty.conf with its `include`d files (plain paths only, up to four files deep), or "" when there is none. kitty also reads /etc/xdg; that is deliberately skipped (a mapping only there would give a false finding). */
export function readKittyConfig(env: NodeJS.ProcessEnv, depth = 0, file?: string): string {
  const dir = env.KITTY_CONFIG_DIRECTORY ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "kitty");
  const path = file ?? join(dir, "kitty.conf");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return "";
  }
  if (depth >= 3) {
    return text;
  }
  const included = [...text.matchAll(/^\s*include\s+(\S+)\s*$/gm)].map((m) => readKittyConfig(env, depth + 1, resolve(dirname(path), (m[1] as string).replace(/^~(?=\/)/, homedir()))));
  return [text, ...included].join("\n");
}

/** Whether kitty is told what to send for Shift+Enter: kitty alone sends a plain Enter inside tmux. */
export const KITTY_SHIFT_ENTER = /^[ \t]*map(?:[ \t]+--\S+)*[ \t]+shift\+enter[ \t]+\S/im;

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

/** The provider names pi can use: the `providers` of models.json and the logins in auth.json (names only; the credentials are never read into anything). Undefined when neither file can be read, so a missing pi config is not reported twice. */
function piProviders(agentDir: string): Set<string> | undefined {
  const names = new Set<string>();
  let read = false;
  for (const [file, pick] of [
    ["models.json", (j: { providers?: unknown }) => j.providers],
    ["auth.json", (j: object) => j],
  ] as const) {
    try {
      const json = JSON.parse(readFileSync(join(agentDir, file), "utf8")) as object;
      const section = pick(json as never);
      if (typeof section === "object" && section !== null) {
        read = true;
        for (const k of Object.keys(section)) {
          names.add(k);
        }
      }
    } catch {
      // absent or unreadable: that source adds nothing
    }
  }
  return read ? names : undefined;
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
  // toriel carries the permission package (ticket 230): it counts as installed when it is bundled, or the user's own in pi's settings
  const permissionPackage = packageState(BUNDLED_PACKAGES.find((p) => p.name === PERMISSION_PKG) as BundledPackage, { agentDir: opts.agentDir ?? piAgentDir(env), off: loaded.settings.bundledPackagesOff, root: opts.bundledRoot });
  out.push(...auditFindings(opts.agentDir ?? piAgentDir(), opts.root ?? PI_RESOURCES_DIR, { ...opts, permissionPackage, scopeGuardAcceptedAllows: loaded.settings.scopeGuardAcceptedAllows }));
  for (const problem of loaded.problems) {
    out.push({ id: "settings", level: "recommended", message: `toriel settings: ${problem}`, manual: "the settings file is yours; doctor will not guess which value you meant" });
  }
  out.push(...settingsFileFindings(opts.settingsFile, env));
  if (loaded.settings.chatto) {
    // the chat bridge (ticket 271): only when it is configured, so a machine that never uses it hears nothing
    const token = readToken(loaded.settings.chatto, env);
    if (!token.ok) {
      out.push({ id: "chat-bridge-token", level: "feature", message: `the chat bridge cannot start: ${token.problem}`, manual: "the token and where it is kept are yours (the bot's token from the chat server's settings; keep the file mode 600)" });
    }
    const installed = (opts.chatClientInstalled ?? chatClientInstalled)();
    if (!installed) {
      out.push({ id: "chat-bridge-package", level: "feature", message: "the chat bridge's package @chatto/client is not installed: run npm install in the toriel checkout", manual: "a package install in the checkout, which doctor does not run" });
    }
    // only with a token and the package: without them the bridge cannot connect, and the checks above already say why
    if (token.ok && installed && opts.probeChat) {
      for (const message of opts.probeChat(loaded.settings.chatto, opts.env ?? process.env)) {
        out.push({ id: "chat-bridge-server", level: "feature", message, manual: "groups, rooms and the bot's roles live on the chat server, and the inbox name is a choice of yours" });
      }
    }
  }
  const piCli = opts.piCli ?? resolveChildConfig(loaded.settings, env).piCli;
  if (!existsSync(piCli)) {
    out.push({ id: "pi-cli", level: "required", message: `pi's cli.js is not at ${piCli}: run npm install in the toriel checkout, or set piCli in the toriel settings`, manual: "needs npm install in the checkout (a package install) or a piCli path only you know" });
  }
  // shipped agents that name mcp__<server>__* tools need the server configured; their sessions get its tools declared at once
  // whatever its exposure (TORIEL_MCP_DIRECT, ticket 298), so only a missing entry is a problem
  const shipped = loadAgents(process.cwd(), env).agents.filter((a) => a.source === "built-in");
  const mcpFile = opts.mcpFile ?? mcpYamlFile(env);
  const servers = mergeMcpServers([mcpFile]);
  for (const server of MCP_AGENT_SERVERS) {
    const users = shipped.filter((a) => (a.tools ?? []).some((t) => t.startsWith(`mcp__${server.name}__`)));
    if (users.length > 0 && users.some((a) => mcpWarnings(a, servers).length > 0)) {
      // a missing entry needs the server's own command/args, which are machine-specific (where it is installed, which runner), so doctor does not invent them and says so
      out.push({
        id: `mcp-${server.name}-server`,
        level: "feature",
        message: `the "${server.name}" MCP server is missing from ${mcpFile}: the ${nameList(users.map((a) => a.name))} ${users.length > 1 ? "agents need" : "agent needs"} it (${server.hint}); without it ${users.length > 1 ? "they have" : "it has"} no ${server.name} tool`,
        manual: `its command depends on where the server is installed on this machine, so add it with /mcp add or by hand (${server.hint})`,
      });
    }
  }
  // a deferred server's every tool_search load re-sends the conversation uncached, a declared one costs cached tokens per call: so the
  // servers most sessions use are cheaper declared, and the rest cheaper deferred (ticket 304)
  if (opts.mcpUsage !== undefined) {
    for (const advice of exposureAdvice(readMcpYaml(mcpFile).servers, opts.mcpUsage())) {
      const { server, exposure, used, sessions } = advice;
      const why =
        exposure === "direct"
          ? `${used} of the last ${sessions} sessions (${USAGE_WINDOW_DAYS} days) called its tools; loading them with tool_search re-sends the whole conversation uncached each time, while declared tools cost only cached tokens per call`
          : `only ${used} of the ${sessions} sessions that declared its tools (${USAGE_WINDOW_DAYS} days) called them, while all of them declare them; tool_search finds them when a session needs them`;
      out.push({
        id: "mcp-exposure",
        level: "recommended",
        message: `the "${server}" MCP server in ${mcpFile} would be cheaper with exposure: ${exposure}: ${why} (declared at once from ${Math.round(DIRECT_SHARE * 100)}% of sessions; agent profiles get their own servers declared either way)`,
        fix: {
          file: mcpFile,
          summary: `set exposure: ${exposure} on the "${server}" entry`,
          edit: (c) => c,
          custom: {
            preview: () => `${mcpFile}: the "${server}" entry would get exposure: ${exposure} (the original is kept as a backup).`,
            apply: (now) => {
              const backup = backupPath(mcpFile, now);
              // several servers can be advised in one run: their applies share the file and the backup's path, so keep the first copy (the original)
              if (!existsSync(backup)) {
                copyFileSync(mcpFile, backup);
              }
              setMcpServerKey(mcpFile, server, "exposure", exposure);
              return backup;
            },
          },
        },
      });
    }
  }
  // an entry set to exposure: codemode needs no check: pi's tool_search searches codemode tools exactly like deferred ones
  // (the server's tools carry tool exposure deferred either way), so they reach every session the same
  // the shipped research-web agent names pi-web-access's tools; without the package it has nothing to search with
  const webAgents = shipped.filter((a) => (a.tools ?? []).some((t) => t === "web_search" || t === "fetch_content"));
  const bundle = { agentDir: opts.agentDir ?? piAgentDir(env), off: loaded.settings.bundledPackagesOff, root: opts.bundledRoot };
  const webState = packageState(webPackage, bundle);
  if (webAgents.length > 0 && (webState === "off" || webState === "missing")) {
    out.push({
      id: "web-package",
      level: "feature",
      message: `the ${nameList(webAgents.map((a) => a.name))} ${webAgents.length > 1 ? "agents need" : "agent needs"} ${WEB_PACKAGE} (and a search provider set up for it), and ${webState === "off" ? `the bundledPackagesOff setting turns toriel's copy off and it is not in the packages of ${join(bundle.agentDir, "settings.json")}` : `toriel's copy is not installed (run npm install in the toriel directory) and it is not in the packages of ${join(bundle.agentDir, "settings.json")}`}; without it the agent has no web tools`,
      manual: "installing the dependencies, or a pi package, and choosing a search provider are yours to do; doctor does not run installs",
    });
  }
  // the third-party packages toriel carries (ticket 230): one that is neither installed in toriel's node_modules, nor the user's own in pi's settings, nor switched off is a broken install
  const notInstalled = BUNDLED_PACKAGES.filter((p) => packageState(p, bundle) === "missing");
  if (notInstalled.length > 0) {
    out.push({
      id: "bundled-packages",
      level: "feature",
      message: `${nameList(notInstalled.map((p) => p.name))} ${notInstalled.length > 1 ? "are" : "is"} bundled with toriel but not installed in ${bundle.root ?? NODE_MODULES_DIR} (run npm install in the toriel directory); sessions start without ${nameList(notInstalled.map((p) => p.gives))}`,
      manual: "installing the dependencies is yours to do; doctor does not run installs",
    });
  }
  // a model tier (agentLanes, ticket 208) that names a provider pi has no config or login for would make every agent on that lane fail at its first request
  const lanes = Object.entries(loaded.settings.agentLanes ?? {});
  if (lanes.length > 0) {
    const known = piProviders(opts.agentDir ?? piAgentDir(env));
    for (const [tier, model] of lanes) {
      const provider = model.slice(0, model.indexOf("/"));
      if (known !== undefined && !known.has(provider)) {
        out.push({
          id: "agent-lanes",
          level: "feature",
          message: `agentLanes.${tier} is ${model}, but pi has no provider "${provider}" (not in the providers of ${join(opts.agentDir ?? piAgentDir(env), "models.json")}, no login in auth.json): agents on the ${tier} lane would fail to start (add the provider, or change agentLanes in the toriel settings; a provider configured by an environment variable is not seen here)`,
          manual: "which model is your cheap or expensive one, and how pi reaches its provider, is yours to say; doctor does not guess",
        });
      }
    }
  }
  // pi's models.json hardcodes the litellm routes' metadata (ticket 215); litellm itself says what it believes, so a stale number is findable
  // the CLI asks the proxy itself; everything else reads what the daemon learned at start (ticket 221) and never asks
  // The same for a bifrost gateway (ticket 221 follow-up); each gateway provider of models.json is asked on its own.
  const cache = opts.probeLitellm === undefined ? readRoutesCache(opts.litellmCacheFile) : undefined;
  for (const gw of readGateways(opts.agentDir ?? piAgentDir(env))) {
    const answer = opts.probeLitellm !== undefined ? opts.probeLitellm({ baseUrl: gw.baseUrl, apiKey: gw.apiKey, kind: gw.kind }) : cache === undefined ? undefined : cachedFor(cache, gw.provider, gw.baseUrl);
    if (answer === undefined || typeof answer === "string") {
      continue; // an unreachable or unauthorised proxy says nothing about the numbers: doctor stays quiet rather than nag when the server is down
    }
    const modelsFile = join(opts.agentDir ?? piAgentDir(env), "models.json");
    const { drift, gone, extra } = diffRoutes(gw.models, answer.routes);
    if (drift.length > 0) {
      const name = gw.kind;
      const lines = drift.map((d) => `${d.id}: ${d.changes.map(([f, was, now]) => `${f} ${was === undefined ? "(unset)" : was} -> ${now}`).join(", ")}`);
      out.push({
        id: gw.kind === "bifrost" ? "bifrost-models" : "litellm-models",
        level: "feature",
        message: `${modelsFile} has stale numbers for the ${name} routes of "${gw.provider}" (pi truncates and compacts by them): ${lines.join("; ")}. ${name} reports its own configured metadata for a route, not the backend's real limits, so this copies ${name}'s belief${gone.length > 0 ? `; ${nameList(gone)} ${gone.length > 1 ? "are" : "is"} in models.json but not served by ${name}` : ""}${extra.length > 0 ? `; ${extra.length} route${extra.length > 1 ? "s" : ""} ${name} serves ${extra.length > 1 ? "are" : "is"} not in models.json (add by hand if you want them)` : ""}`,
        fix: {
          file: modelsFile,
          summary: `update ${drift.length} ${name} model${drift.length > 1 ? "s" : ""} of "${gw.provider}" in models.json to ${name}'s numbers`,
          edit: (c) => {
            const providers = (typeof c.providers === "object" && c.providers !== null ? c.providers : {}) as Record<string, { models?: Array<Record<string, unknown>> }>;
            const entry = providers[gw.provider];
            if (entry === undefined || !Array.isArray(entry.models)) {
              return c;
            }
            return { ...c, providers: { ...providers, [gw.provider]: { ...entry, models: applyDrift(entry.models, drift) } } };
          },
        },
      });
    }
  }
  // toriel's MCP config (tickets 209, 216): a bad entry is left out of the session, so say which and why
  for (const problem of readMcpYaml(mcpFile).problems) {
    out.push({ id: "mcp-yaml", level: "recommended", message: `${mcpFile}: ${problem}`, manual: "the file is yours; doctor will not guess what an entry should be" });
  }
  // pi's own mcp.json still holding servers (ticket 216): toriel reads mcp.yaml, and pi would start these itself as well
  const piJson = join(opts.agentDir ?? piAgentDir(env), "mcp.json");
  const old = importMcpJson(piJson);
  const oldNames = [...Object.keys(old.servers), ...old.skipped];
  if (oldNames.length > 0) {
    const have = readMcpYaml(mcpFile).servers;
    const moving = Object.entries(old.servers).filter(([name]) => !(name in have));
    out.push({
      id: "mcp-json",
      level: "recommended",
      message: `pi's ${piJson} still lists ${nameList(oldNames)}: toriel now keeps its MCP servers in ${mcpFile} (YAML, comments allowed), and pi would also start the old entries itself; move them over (${moving.length} to add${old.dropped.length > 0 ? `; ${nameList(old.dropped)} cannot be carried over` : ""}${old.skipped.length > 0 ? `; ${nameList(old.skipped)} are not usable entries and stay behind in the backup` : ""})`,
      fix: {
        file: mcpFile,
        summary: `add ${moving.length > 0 ? nameList(moving.map(([n]) => n)) : "nothing new"} to ${mcpFile} and set ${piJson} aside`,
        edit: (c) => c,
        custom: {
          // env and header values can be secrets: the preview shows the names only, like /mcp status does
          preview: () => `${mcpFile} would gain:\n${moving.length > 0 ? asAddition(renderMcpYaml(Object.fromEntries(moving.map(([name, entry]) => [name, redactEntry(entry)]))).split("\n").filter((l) => !l.startsWith("#")).join("\n")) : "+ (nothing: every server is already there)"}\n${piJson} would be renamed (kept as a backup).`,
          apply: (now) => {
            for (const [name, entry] of moving) {
              addMcpServer(mcpFile, name, entry);
            }
            const backup = backupPath(piJson, now);
            renameSync(piJson, backup);
            return backup;
          },
        },
      },
    });
  }
  // the per-command sandbox (board 190) refuses to run a command rather than run it unsandboxed, so a setting that asks for bwrap without a working bwrap would stop every scoped session's bash
  if (loaded.settings.sandbox !== "off") {
    const why = (opts.probeBwrap ?? probeBwrap)();
    if (why !== undefined) {
      out.push({ id: "sandbox-bwrap", level: "feature", message: `the command sandbox is on (the toriel setting "sandbox" is "bwrap", which is the default) but ${why}; scoped sessions would refuse every bash command (install bubblewrap and enable user namespaces, or set "sandbox": "off")`, manual: 'installing bubblewrap is a system package install, and switching the sandbox off would drop protection you asked for' });
    }
  }
  const dirs = opts.pathDirs ?? (env.PATH ?? "").split(delimiter).filter(Boolean);
  if ((opts.platform ?? process.platform) === "linux" && loaded.settings.preventSleep !== false && !onPath("systemd-inhibit", dirs)) {
    out.push({ id: "sleep-lock", level: "feature", message: 'systemd-inhibit is not on PATH, so the machine can sleep through a scheduled run (install systemd, or set "preventSleep": false in the toriel settings to stop asking)', manual: "installing systemd is a system package install; the alternative setting turns off a feature you may want" });
  }
  const display = env.WAYLAND_DISPLAY ? "wayland" : env.DISPLAY ? "x11" : undefined;
  if (display !== undefined && loaded.settings.permissionNotifications !== false && !onPath("notify-send", dirs)) {
    out.push({ id: "notify-send", level: "feature", message: 'notify-send is not on PATH, so a permission prompt in a background session cannot ping the desktop (install libnotify, or set "permissionNotifications": false in the toriel settings to stop asking)', manual: "installing libnotify is a system package install (dnf install libnotify); the alternative setting turns off a feature you may want" });
  }
  if (display === "wayland" && !(onPath("wl-paste", dirs) && onPath("wl-copy", dirs))) {
    out.push({ id: "clipboard", level: "feature", message: "wl-clipboard is not on PATH, so paste and /btw's copy have no clipboard (install wl-clipboard; copying may still work through the terminal)", manual: "installing wl-clipboard is a system package install" });
  } else if (display === "x11" && !onPath("xclip", dirs)) {
    out.push({ id: "clipboard", level: "feature", message: "xclip is not on PATH, so paste and /btw's copy have no clipboard (install xclip; copying may still work through the terminal)", manual: "installing xclip is a system package install" });
  }
  if (opts.feedbackDir !== undefined) {
    const bytes = bundlesBytes(opts.feedbackDir);
    if (bytes > FEEDBACK_SIZE_WARN_BYTES) {
      out.push({ id: "feedback-size", level: "feature", message: `the /feedback bundles in ${opts.feedbackDir} use ${fmtBytes(bytes)} (each holds a full copy of a session); \`toriel feedback list\` shows them and \`toriel feedback prune --older-than 30d\` clears the old ones`, manual: "deleting feedback is your call, so prune is explicit (toriel feedback prune); nothing deletes it for you" });
    }
  }
  if (opts.tty === true) {
    const term = `${env.COLORTERM ?? ""} ${env.TERM ?? ""}`;
    if (!/truecolor|24bit/i.test(term) && !/kitty|ghostty|wezterm|contour|foot/i.test(term)) {
      out.push({ id: "truecolor", level: "feature", message: "the terminal does not advertise truecolor (COLORTERM/TERM), so toriel's theme colors are approximated; a terminal with truecolor support shows them as intended", manual: "the terminal emulator's capability, not a config file" });
    }
  }
  // Shift+Enter under tmux (ticket 142) needs two things: tmux encoding extended keys, and the terminal sending a distinct key for it
  if (opts.tty === true && env.TMUX) {
    const tmux = (opts.probeTmux ?? probeTmux)();
    if (tmux.extendedKeys === "off") {
      out.push({ id: "tmux-keys", level: "feature", message: "tmux has extended-keys off, so Shift+Enter sends the message instead of adding a newline (Alt+Enter works either way); add `set -g extended-keys on` to ~/.tmux.conf and reload it (`tmux source-file ~/.tmux.conf`)", manual: "~/.tmux.conf is not toriel's file, and the setting changes how tmux encodes keys for every program in it" });
    }
    // tmux strips OSC 8 links for a terminal whose terminal-features lack `hyperlinks`; nothing says why a click then does nothing (ticket 211). Its own list for the client is the answer, whatever pattern or detection put a feature there
    if (tmux.clientFeatures !== undefined && tmux.clientFeatures !== "" && tmux.clientTerm !== undefined && !tmux.clientFeatures.split(",").includes("hyperlinks")) {
      out.push({ id: "tmux-hyperlinks", level: "feature", message: `tmux does not pass clickable links through to ${tmux.clientTerm}, so URLs in toriel (and everything else in tmux) show as plain text and clicking does nothing; add \`set -as terminal-features ",${tmux.clientTerm}:hyperlinks"\` to ~/.tmux.conf and restart the tmux server (features are worked out when the client attaches, so reloading the file is not enough)`, manual: "~/.tmux.conf is not toriel's file and not JSON that doctor could edit safely, and the setting changes how tmux treats that terminal for every program in it" });
    }
    // kitty does not negotiate with tmux, so it sends a plain Enter for Shift+Enter unless its own config says otherwise
    if (/kitty/i.test(tmux.clientTerm ?? "") && !KITTY_SHIFT_ENTER.test(opts.kittyConfig ?? readKittyConfig(env))) {
      out.push({ id: "kitty-shift-enter", level: "feature", message: "kitty sends a plain Enter for Shift+Enter inside tmux, so Shift+Enter sends the message instead of adding a newline; add `map shift+enter send_text all \\x1b[13;2u` to kitty.conf and reload it (ctrl+shift+f5). With tmux's extended-keys on, tmux turns that into the key toriel reads as Shift+Enter. Outside tmux a plain shell prompt may print the sequence", manual: "kitty.conf is not toriel's file, and the mapping applies to every program in kitty" });
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
  // a machine without the chat bridge has nothing to ask the chat server about: its check is ok, not skipped
  const chatOn = () => loadSettings(opts.settingsFile ?? settingsFile(opts.env ?? process.env)).settings.chatto !== undefined;
  const known = new Set(CATALOG.map((c) => c.id));
  const checks: Check[] = CATALOG.map((entry) => {
    const mine = findings.filter((f) => f.id === entry.id);
    if (mine.length > 0) {
      return { ...entry, state: "problem", findings: mine };
    }
    if (noPackage && entry.needsPermissionPackage) {
      return { ...entry, state: "skipped", findings: [], note: "needs pi-permission-system (see above)" };
    }
    // the bundle folder is a CLI input (ticket 240); without it the size check has not run, so it does not count as ok (like the probe checks)
    if (entry.id === "feedback-size" && opts.feedbackDir === undefined) {
      return { ...entry, state: "skipped", findings: [], note: "run `toriel doctor` in a terminal to check" };
    }
    // reading the session files takes a moment, so only the CLI does it (ticket 304)
    if (entry.id === "mcp-exposure" && opts.mcpUsage === undefined) {
      return { ...entry, state: "skipped", findings: [], note: "reads the recent sessions: run `toriel doctor` in a terminal to check" };
    }
    // the probe is gated on the token and the package in collectFindings, so either problem means it never ran: not ok, then
    if (entry.needsChatProbe && findings.some((f) => f.id === "chat-bridge-token" || f.id === "chat-bridge-package")) {
      return { ...entry, state: "skipped", findings: [], note: "checks the chat server, which needs the token and the package (see the problems above)" };
    }
    if (entry.needsChatProbe && opts.probeChat === undefined && chatOn()) {
      return { ...entry, state: "skipped", findings: [], note: "asks the chat server: run `toriel doctor` in a terminal to check" };
    }
    if (entry.needsProbe !== undefined && opts.probeLitellm === undefined) {
      const kind = entry.needsProbe;
      const cache = readRoutesCache(opts.litellmCacheFile);
      const mine = readGateways(opts.agentDir ?? piAgentDir(opts.env ?? process.env)).filter((g) => g.kind === kind);
      const heard = mine.map((g) => cachedFor(cache, g.provider, g.baseUrl)).filter((c) => c !== undefined);
      if (heard.length === 0) {
        return { ...entry, state: "skipped", findings: [], note: `asks the ${kind} server: run \`toriel doctor\` in a terminal to check` };
      }
      return { ...entry, state: "ok", findings: [], note: `compared with what ${kind} said when the daemon started (${fmtClock(Math.min(...heard.map((c) => c.checkedAt)), new Date())}); \`toriel doctor\` in a terminal asks again` };
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
    requireOnlyCustom(fixes);
    return fixes.map((f) => f.custom?.preview() ?? "").join("\n");
  }
  const { before, after } = edited(file, fixes);
  return lineDiff(before, after);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A file's fixes are all JSON edits or all custom: a mix would silently drop one kind. */
function requireOnlyCustom(fixes: readonly Fix[]): void {
  if (fixes.some((f) => !f.custom)) {
    throw new Error("cannot mix a custom fix with JSON edits for one file");
  }
}

/** `<file>.bak-<time>`: where the original of a changed file is kept. */
export function backupPath(file: string, now: Date): string {
  return `${file}.bak-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** Apply `fixes` to `file`: the original is copied to `<file>.bak-<time>` first, then the file is replaced in one step (same mode). Returns the backup's path, or undefined when a fix created a file and there was no original. */
export function applyFixes(file: string, fixes: readonly Fix[], now: Date = new Date()): string | undefined {
  if (fixes.some((f) => f.custom)) {
    requireOnlyCustom(fixes);
    return fixes.map((f) => f.custom?.apply(now)).find((b) => b !== undefined);
  }
  const { after } = edited(file, fixes);
  const backup = backupPath(file, now);
  copyFileSync(file, backup);
  writeFileAtomic(file, `${after}\n`, statSync(file).mode & 0o777);
  return backup;
}
