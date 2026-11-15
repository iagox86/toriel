// Agent profiles: a markdown file with frontmatter that decides how a session
// is launched (tools, model, system prompt). The format follows Claude Code's
// agent files so they can be pasted in; toriel never reads Claude's own folders.
//
//   ---
//   name: explore
//   description: Read-only look around the codebase.
//   tools: read, grep, find, ls, mcp__ghidra__*
//   model: cheap            (a tier from the settings' agentLanes) or provider/id
//   thinking: low
//   ---
//   System prompt text...
//
// This module is pure (strings in, values out) except `loadAgents`, which reads
// the three agent directories.
import * as fs from "node:fs";
import * as path from "node:path";
import { parseMcpYaml } from "../pi/extensions/lib/mcp-config.ts";
import { mcpYamlFile } from "./config-dir.ts";
import { errText } from "./util.ts";

/** The model tiers a profile may name instead of a provider/id; the settings' `agentLanes` say which model each one is (ticket 208). */
export const MODEL_TIERS = ["cheap", "medium", "expensive"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];
export type AgentLanes = Partial<Record<ModelTier, string>>;

export function isModelTier(v: string): v is ModelTier {
  return (MODEL_TIERS as readonly string[]).includes(v);
}

/**
 * The provider/id a profile's `model` stands for. A value with a `/` is a literal id; a tier is looked up in
 * the settings; a tier the settings do not set gives no model at all (the session's default) and a notice,
 * never a refused launch: a shipped profile must still run on a machine that has no cheap model.
 */
export function resolveModel(model: string | undefined, lanes: AgentLanes | undefined): { model?: string; notice?: string } {
  if (model === undefined || model.includes("/")) {
    return { model };
  }
  const lane = isModelTier(model) ? lanes?.[model] : undefined;
  if (lane !== undefined) {
    return { model: lane };
  }
  return { notice: `the model tier "${model}" is not set in agentLanes in the toriel settings, so the default model is used` };
}

/** `profile` with its model tier resolved; `onNotice` hears the fallback, if any. */
export function withResolvedModel(profile: AgentProfile, lanes: AgentLanes | undefined, onNotice?: (notice: string) => void): AgentProfile {
  const r = resolveModel(profile.model, lanes);
  if (r.notice !== undefined) {
    onNotice?.(`agent ${profile.name}: ${r.notice}`);
  }
  return r.model === profile.model ? profile : { ...profile, model: r.model };
}

export interface AgentProfile {
  name: string;
  description: string;
  /** Tool allowlist handed to pi's --tools (patterns allowed, e.g. mcp__ghidra__*). Unset = pi's defaults. */
  tools?: string[];
  /** provider/id, or a tier (cheap, medium, expensive) resolved through the settings' agentLanes at launch; unset = whatever the settings say. */
  model?: string;
  /** Opt out of the daemon's directory scoping for worktree spawns; unset = scoped when the spawn qualifies. */
  scope?: "none";
  thinking?: string;
  /** Appended to pi's system prompt. */
  prompt: string;
  /** Turn limit, enforced once subagents exist. */
  maxTurns?: number;
  /** Token budget, enforced once subagents exist. */
  budget?: number;
  /** May this agent start subagents of its own (default false). */
  canSpawn: boolean;
  /** Skip AGENTS.md/CLAUDE.md, skills and prompt templates (default true: small prompts for small models). */
  minimal: boolean;
  /** Load pi's extensions (default true; the permission system is one). */
  extensions: boolean;
  /** Where it came from: "built-in", "user" or "project". */
  source: string;
  file: string;
}

export interface LoadedAgents {
  agents: AgentProfile[];
  /** Files that could not be used, one line each. */
  problems: string[];
}

const KEYS = new Set(["name", "description", "tools", "model", "scope", "thinking", "maxturns", "budget", "canspawn", "minimal", "extensions"]);
const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** Claude-style capitalized tool names mapped to pi's lowercase ones. */
const TOOL_ALIASES: Record<string, string> = { glob: "find", webfetch: "fetch_content", websearch: "web_search" };

export function normalizeTool(t: string): string {
  const name = t.trim();
  if (name.startsWith("mcp__")) {
    // pi's --tools never matches an exact MCP tool name (measured on pi 1.4.0: `mcp__git__git_read` yields no tool, `mcp__git__git_read*` yields exactly it), so an exact name gets a trailing *
    return name.includes("*") ? name : `${name}*`;
  }
  if (name.includes("*")) {
    return name;
  }
  const lower = name.toLowerCase();
  return TOOL_ALIASES[lower] ?? lower;
}

function unquote(v: string): string {
  const m = /^(["'])(.*)\1$/.exec(v);
  return m ? (m[2] as string) : v;
}

/** `key: value` lines with `|`/`>` block scalars and ` #` comments; no nesting. */
function parseFrontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (!line.trim() || line.trimStart().startsWith("#")) {
      continue;
    }
    const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!m) {
      throw new Error(`cannot read frontmatter line: ${line.trim()}`);
    }
    const key = (m[1] as string).toLowerCase();
    let value = (m[2] as string).trim();
    if (value === "|" || value === ">") {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s/.test(lines[i + 1] as string)) {
        block.push((lines[++i] as string).trim());
      }
      value = block.join(value === "|" ? "\n" : " ");
    } else if (!/^["']/.test(value)) {
      value = value.replace(/\s+#.*$/, "");
    }
    out[key] = unquote(value.trim());
  }
  return out;
}

function asBool(key: string, v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) {
    return fallback;
  }
  if (v === "true" || v === "false") {
    return v === "true";
  }
  throw new Error(`${key} must be true or false`);
}

function asCount(key: string, v: string | undefined): number | undefined {
  if (v === undefined) {
    return undefined;
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${key} must be a positive whole number`);
  }
  return n;
}

/** Parse one agent file. Throws an Error with a user-readable message. */
export function parseAgent(text: string, source: string, file: string): AgentProfile {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(text);
  if (!m) {
    throw new Error("no frontmatter (the file must start with a --- block)");
  }
  const fm = parseFrontmatter(m[1] as string);
  const unknown = Object.keys(fm).filter((k) => !KEYS.has(k));
  if (unknown.length > 0) {
    throw new Error(`unknown key${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`);
  }
  const name = fm.name;
  if (!name || !/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    throw new Error("name is required: lowercase letters, digits, - and _");
  }
  if (!fm.description) {
    throw new Error("description is required (it is what picks the agent)");
  }
  if (fm.thinking !== undefined && !THINKING.has(fm.thinking)) {
    throw new Error(`thinking must be one of ${[...THINKING].join(", ")}`);
  }
  if (fm.model !== undefined && !fm.model.includes("/") && !isModelTier(fm.model)) {
    throw new Error(`model must be provider/id or one of ${MODEL_TIERS.join(", ")}`);
  }
  if (fm.scope !== undefined && fm.scope !== "none") {
    throw new Error('scope must be "none"');
  }
  const tools = fm.tools === undefined ? undefined : fm.tools.split(",").map(normalizeTool).filter(Boolean);
  if (tools !== undefined && tools.length === 0) {
    throw new Error("tools is empty (leave it out for pi's defaults)");
  }
  const extensions = asBool("extensions", fm.extensions, true);
  if (!extensions && tools?.some((t) => t.startsWith("mcp__"))) {
    // pi's MCP support is one of its built-in extensions, so --no-extensions removes every MCP tool
    throw new Error("tools names MCP tools (mcp__...) but extensions is false, which turns pi's MCP support off: set extensions: true (the permission system then guards them)");
  }
  return {
    name,
    description: fm.description,
    tools,
    model: fm.model,
    scope: fm.scope === "none" ? "none" : undefined,
    thinking: fm.thinking,
    prompt: (m[2] ?? "").trim(),
    maxTurns: asCount("maxTurns", fm.maxturns),
    budget: asCount("budget", fm.budget),
    canSpawn: asBool("canSpawn", fm.canspawn, false),
    minimal: asBool("minimal", fm.minimal, true),
    extensions,
    source,
    file,
  };
}

/** Whether a session launched as `profile` has pi's MCP support at all (none = a plain session, which does). Matches `profileArgs`: --no-extensions and --no-mcp take it away. */
export function profileHasMcp(profile: AgentProfile | undefined): boolean {
  return profile === undefined || (profile.extensions && (profile.tools === undefined || profile.tools.some((t) => t.startsWith("mcp__"))));
}

/** The pi arguments that launch a session as `profile`. Model and thinking are for new sessions only (see `profileArgs`). */
export function profileArgs(profile: AgentProfile, opts: { isNew: boolean }): string[] {
  const args: string[] = [];
  if (profile.tools) {
    args.push("--tools", profile.tools.join(","));
    // --tools leaves MCP tools alone unless an entry names one, so say "none" outright
    if (!profile.tools.some((t) => t.startsWith("mcp__"))) {
      args.push("--no-mcp");
    }
  }
  if (profile.minimal) {
    args.push("--no-context-files", "--no-skills", "--no-prompt-templates");
  }
  if (!profile.extensions) {
    args.push("--no-extensions");
  }
  if (profile.prompt) {
    args.push("--append-system-prompt", profile.prompt);
  }
  if (opts.isNew) {
    if (profile.thinking) {
      args.push("--thinking", profile.thinking);
    }
    if (profile.model) {
      args.push("--model", profile.model);
    }
  }
  return args;
}

/** Names of the MCP servers a tool list reaches (`mcp__ghidra__*` -> ghidra). */
export function mcpServersOf(tools: readonly string[]): string[] {
  const servers = new Set<string>();
  for (const t of tools) {
    const m = /^mcp__([^_*][^*]*?)(?:__|\*|$)/.exec(t);
    if (m) {
      servers.add(m[1] as string);
    }
  }
  return [...servers];
}

/** One warning per MCP server the profile names that mcp.yaml does not configure. */
export function mcpWarnings(profile: AgentProfile, servers: Readonly<Record<string, McpServerInfo>>): string[] {
  const byName = new Map(Object.entries(servers).map(([name, info]) => [name.replace(/-/g, "_"), info]));
  return mcpServersOf(profile.tools ?? []).flatMap((server) => {
    const info = byName.get(server.replace(/-/g, "_"));
    if (!info) {
      return [`${profile.name}: MCP server "${server}" is not configured in mcp.yaml`];
    }
    if (info.exposure !== "direct") {
      // pi's default (codemode) never declares the tools to the model, so an agent limited to them has none
      return [`${profile.name}: MCP server "${server}" has exposure ${info.exposure ?? "codemode (the default)"} in mcp.yaml, so the agent is never given its tools: set "exposure": "direct"`];
    }
    return [];
  });
}

/** What a profile needs to know about an MCP server entry. */
export interface McpServerInfo {
  /** pi's `exposure` for the server; undefined = its default, codemode. */
  exposure?: string;
}

/** The servers of toriel's mcp.yaml; empty when it is missing or unreadable (the doctor reports that). An entry with a problem is left out. */
export function readMcpServers(file: string): Record<string, McpServerInfo> {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return {};
  }
  return Object.fromEntries(Object.entries(parseMcpYaml(text).servers).map(([name, entry]) => [name, { exposure: entry.exposure }]));
}

/** Several mcp.yaml files, lowest priority first (there is one now; the list stays so a caller need not change): a later entry of the same name overrides the keys it sets. */
export function mergeMcpServers(files: readonly string[]): Record<string, McpServerInfo> {
  const out: Record<string, McpServerInfo> = {};
  for (const file of files) {
    for (const [name, info] of Object.entries(readMcpServers(file))) {
      out[name] = { ...out[name], ...(info.exposure !== undefined ? info : {}) };
    }
  }
  return out;
}

export interface AgentDirs {
  /** [directory, source label], lowest priority first; a later directory's agent replaces an earlier one of the same name. */
  dirs: Array<[string, string]>;
}

/** Shipped agents, the user's, then the project's. `TORIEL_AGENTS_DIR` replaces the user directory (tests). */
export function agentDirs(cwd: string, env: NodeJS.ProcessEnv = process.env): AgentDirs {
  const config = env.XDG_CONFIG_HOME ?? path.join(env.HOME ?? "", ".config");
  return {
    dirs: [
      [path.join(import.meta.dirname, "..", "agents"), "built-in"],
      [env.TORIEL_AGENTS_DIR ?? path.join(config, "toriel", "agents"), "user"],
      [path.join(cwd, ".toriel", "agents"), "project"],
    ],
  };
}

/** Read every agent file. A bad file is reported, never fatal; later directories win on a name clash. */
export function loadAgents(cwd: string, env: NodeJS.ProcessEnv = process.env): LoadedAgents {
  const byName = new Map<string, AgentProfile>();
  const problems: string[] = [];
  for (const [dir, source] of agentDirs(cwd, env).dirs) {
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md").sort();
    } catch {
      continue; // a missing directory is normal
    }
    for (const f of files) {
      const file = path.join(dir, f);
      try {
        const profile = parseAgent(fs.readFileSync(file, "utf8"), source, file);
        byName.set(profile.name, profile);
      } catch (err) {
        problems.push(`${file}: ${errText(err)}`);
      }
    }
  }
  return { agents: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), problems };
}

/** The MCP config files that apply to sessions in a directory: toriel's mcp.yaml (ticket 216; pi's own mcp.json is not used, and neither is a project's .pi/mcp.json). */
export function mcpConfigFiles(_cwd: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return [mcpYamlFile(env)];
}

/** Load agents and add the MCP warnings. */
export function loadAgentsChecked(cwd: string, env: NodeJS.ProcessEnv = process.env): LoadedAgents {
  const loaded = loadAgents(cwd, env);
  const servers = mergeMcpServers(mcpConfigFiles(cwd, env));
  return { agents: loaded.agents, problems: [...loaded.problems, ...loaded.agents.flatMap((a) => mcpWarnings(a, servers))] };
}

/** The agent called `name` for sessions in `cwd`; throws a message listing the choices when there is none. */
export function findAgent(name: string, cwd: string, env: NodeJS.ProcessEnv = process.env): AgentProfile {
  const { agents } = loadAgents(cwd, env);
  const found = agents.find((a) => a.name === name);
  if (!found) {
    const names = agents.map((a) => a.name).join(", ");
    throw new Error(`no agent called "${name}"${names ? ` (have: ${names})` : " (none defined; see agents/ in the toriel repo)"}`);
  }
  return found;
}
