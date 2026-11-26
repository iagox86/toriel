// toriel's MCP config (tickets 209 and 216): the servers live in toriel's own mcp.yaml, not in pi's mcp.json, and the
// toriel-mcp extension registers them into pi with pi.registerMcpServer at session start. This is the pure half, shared by the
// daemon (which edits the file for /mcp add and the doctor) and the extension (which reads it inside pi): one definition of what an
// entry may hold and how it is read, so the two cannot drift.
import * as net from "node:net";
import { parse } from "yaml";

/** The environment variable that tells a pi child where mcp.yaml is (a path, never the contents: an entry's env may hold a secret, and a child's environment is readable by the agent's own commands). */
export const MCP_FILE_ENV = "TORIEL_MCP_FILE";

/** How long the reachability check waits for a connection before calling a server down. */
export const PROBE_TIMEOUT_MS = 800;

/** A server name as pi uses it in `mcp__<name>__<tool>`. */
export const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;

/** What pi's own mcp.json entries may hold, plus `whenUp` and `readOnly`, which are toriel's. */
export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  type?: string;
  exposure?: string;
  toolExposure?: Record<string, string>;
  enabled?: boolean;
  timeout?: number;
  description?: string;
  /** Register the server only when something listens at its URL when a session starts (an app that is not always running); /mcp-up looks again. URL servers only. */
  whenUp?: boolean;
  /** The server's tools change nothing outside their own process, so plan mode (ticket 229) lets them run. Only the owner of the file can say so; the default is that they may change things. */
  readOnly?: boolean;
}

const EXPOSURES = ["codemode", "deferred", "direct", "hidden"];
const KEYS = ["command", "args", "env", "cwd", "url", "headers", "type", "exposure", "toolExposure", "enabled", "timeout", "description", "whenUp", "readOnly"];

/** The http(s) URL a server is reached at, or undefined when `value` is not one. */
export function serverUrl(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    const u = new URL(value);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname !== "" ? value : undefined;
  } catch {
    return undefined;
  }
}

const isStringMap = (v: unknown): v is Record<string, string> => typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string" || typeof x === "number" || typeof x === "boolean");

/** A URL for display: any user:password@ part, and the query string (tokens ride there too), replaced by marks. Never throws; a string that is not a URL comes back as "(a URL)". */
export function redactUrl(url: string | undefined): string {
  if (url === undefined) {
    return "(no url)";
  }
  try {
    const u = new URL(url);
    const auth = u.username !== "" || u.password !== "" ? "***@" : "";
    return `${u.protocol}//${auth}${u.host}${u.pathname === "/" && !url.endsWith("/") ? "" : u.pathname}${u.search !== "" ? "?..." : ""}`;
  } catch {
    return "(a URL)";
  }
}

/** One entry as written, or why it is not usable. */
export function checkEntry(name: string, raw: unknown): { entry: McpServerConfig } | { problem: string } {
  if (!SERVER_NAME.test(name)) {
    return { problem: `server name "${name}" must be letters, digits, "_", "." or "-" (it becomes part of the tool names)` };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { problem: `"${name}": the entry must be a mapping (command or url, and options)` };
  }
  const e = raw as Record<string, unknown>;
  const unknown = Object.keys(e).filter((k) => !KEYS.includes(k));
  if (unknown.length > 0) {
    return { problem: `"${name}": unknown key${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => `"${k}"`).join(", ")} (known: ${KEYS.join(", ")})` };
  }
  const hasUrl = e.url !== undefined;
  const hasCommand = e.command !== undefined;
  if (hasUrl === hasCommand) {
    return { problem: `"${name}": give exactly one of url (a remote server) or command (run over stdio)` };
  }
  if (hasUrl && serverUrl(e.url) === undefined) {
    return { problem: `"${name}": url must be an http(s) URL` };
  }
  if (hasCommand && (typeof e.command !== "string" || e.command === "")) {
    return { problem: `"${name}": command must be a program name or path` };
  }
  if (e.args !== undefined && !(Array.isArray(e.args) && e.args.every((a) => typeof a === "string" || typeof a === "number"))) {
    return { problem: `"${name}": args must be a list` };
  }
  for (const key of ["env", "headers"]) {
    if (e[key] !== undefined && !isStringMap(e[key])) {
      return { problem: `"${name}": ${key} must map names to values` };
    }
  }
  if (e.exposure !== undefined && !EXPOSURES.includes(e.exposure as string)) {
    return { problem: `"${name}": exposure must be one of ${EXPOSURES.join(", ")}` };
  }
  if (e.enabled !== undefined && typeof e.enabled !== "boolean") {
    return { problem: `"${name}": enabled must be true or false` };
  }
  if (e.whenUp !== undefined && typeof e.whenUp !== "boolean") {
    return { problem: `"${name}": whenUp must be true or false` };
  }
  if (e.readOnly !== undefined && typeof e.readOnly !== "boolean") {
    return { problem: `"${name}": readOnly must be true or false` };
  }
  if (e.whenUp === true && !hasUrl) {
    return { problem: `"${name}": whenUp needs a url (there is nothing to check for a command server)` };
  }
  if (e.timeout !== undefined && !(typeof e.timeout === "number" && e.timeout > 0 && e.timeout <= 86_400)) {
    return { problem: `"${name}": timeout must be a number of seconds, more than 0 and at most a day` };
  }
  if (e.type !== undefined && typeof e.type !== "string") {
    return { problem: `"${name}": type must be a word such as http` };
  }
  if (e.cwd !== undefined && (typeof e.cwd !== "string" || e.cwd === "")) {
    return { problem: `"${name}": cwd must be a directory path` };
  }
  if (e.toolExposure !== undefined && !(typeof e.toolExposure === "object" && e.toolExposure !== null && !Array.isArray(e.toolExposure) && Object.values(e.toolExposure).every((x) => EXPOSURES.includes(x as string)))) {
    return { problem: `"${name}": toolExposure must map tool names to one of ${EXPOSURES.join(", ")}` };
  }
  const entry: McpServerConfig = { ...(e as McpServerConfig) };
  if (entry.args) {
    entry.args = entry.args.map(String);
  }
  for (const key of ["env", "headers"] as const) {
    if (entry[key]) {
      entry[key] = Object.fromEntries(Object.entries(entry[key] as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
    }
  }
  return { entry };
}

/** The servers of an mcp.yaml's text and the problems found; never throws. An entry with a problem is left out, the rest still load. */
export function parseMcpYaml(text: string): { servers: Record<string, McpServerConfig>; problems: string[] } {
  const servers: Record<string, McpServerConfig> = {};
  const problems: string[] = [];
  let data: unknown;
  try {
    data = parse(text);
  } catch (err) {
    return { servers, problems: [`not valid YAML: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`] };
  }
  if (data === null || data === undefined) {
    return { servers, problems };
  }
  const list = (data as { servers?: unknown }).servers;
  if (typeof data !== "object" || Array.isArray(data) || (list !== undefined && list !== null && (typeof list !== "object" || Array.isArray(list)))) {
    return { servers, problems: ['the file must be a mapping with a "servers" mapping: server name -> its entry'] };
  }
  for (const key of Object.keys(data as object)) {
    if (key !== "servers") {
      problems.push(`unknown top-level key "${key}" (only "servers")`);
    }
  }
  for (const [name, raw] of Object.entries((list ?? {}) as Record<string, unknown>)) {
    const checked = checkEntry(name, raw);
    if ("problem" in checked) {
      problems.push(checked.problem);
    } else {
      servers[name] = checked.entry;
    }
  }
  return { servers, problems };
}

/**
 * The environment variable that names, comma-separated, the servers whose tools an agent profile lists (ticket 298): the session
 * gets them declared at once (`direct`) whatever the entry says, since the profile's prompt expects them.
 */
export const MCP_DIRECT_ENV = "TORIEL_MCP_DIRECT";

/** The exposure a server gets when its entry sets none: pi's own default is codemode; toriel's is deferred (found with tool_search). */
export const DEFAULT_EXPOSURE = "deferred";

/** A server name as tool names spell it (pi turns `-` into `_` in `mcp__<server>__<tool>`), for matching the two forms. */
export function toolServerName(name: string): string {
  return name.replace(/-/g, "_");
}

/** The server names of a comma-separated MCP_DIRECT_ENV value, in tool-name form. */
export function parseDirectServers(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((s) => toolServerName(s.trim()))
      .filter(Boolean),
  );
}

/**
 * What pi's registerMcpServer takes: the entry without toriel's own `whenUp` and `readOnly`, with `deferred` exposure when the
 * entry sets none (ticket 298), or `direct` when the session's profile needs the server's tools declared.
 *
 * `summary` (ticket 303) is the server's one-line summary from an earlier session. A server whose tools are not declared is listed
 * in the system prompt's `mcp_servers` section with its entry's `description`, or with its instructions once it connects; the second
 * changes the top of the prompt mid-session, which makes the next call re-send the whole conversation uncached. Passing the remembered
 * summary as the description keeps the section the same from the first prompt on. The entry's own `description` wins.
 */
export function piConfig(entry: McpServerConfig, opts: { direct?: boolean; summary?: string } = {}): Record<string, unknown> {
  const { whenUp: _whenUp, readOnly: _readOnly, ...rest } = entry;
  if (opts.direct) {
    return { ...rest, exposure: "direct" };
  }
  const config: Record<string, unknown> = { ...rest, exposure: rest.exposure ?? DEFAULT_EXPOSURE };
  if (!rest.description?.trim() && opts.summary) {
    config.description = opts.summary;
  }
  return config;
}

/** The environment variable naming the file of remembered server summaries (ticket 303); the daemon sets it, the toriel-mcp extension reads and updates it. */
export const MCP_SUMMARIES_ENV = "TORIEL_MCP_SUMMARIES";

/** Longest summary kept: pi shows at most 250 characters of one in the section. */
const SUMMARY_MAX = 250;

/** The line pi would show for a server's instructions: the first line, trimmed (pi's `serverSummary`), capped. Empty for none. */
export function summaryLine(instructions: string | undefined): string {
  return ((instructions ?? "").split("\n", 1)[0] ?? "").trim().slice(0, SUMMARY_MAX);
}

/** What the extension sees of a tool: its name and, for an MCP tool of a connected server, the server's namespace. */
export interface ToolNamespaceInfo {
  name: string;
  namespace?: { aliases?: readonly string[]; instructions?: string };
}

/**
 * The summaries to remember after a run: `known` updated with the instructions of the connected servers among `tools`, for the
 * servers of mcp.yaml that set no `description` of their own. Returns undefined when nothing changed, so the file is written only
 * when it has to be.
 */
export function learnSummaries(known: Readonly<Record<string, string>>, tools: readonly ToolNamespaceInfo[], servers: Readonly<Record<string, McpServerConfig>>): Record<string, string> | undefined {
  const next = { ...known };
  let changed = false;
  for (const tool of tools) {
    const server = tool.namespace?.aliases?.[0];
    if (!server || !tool.name.startsWith("mcp__") || !(server in servers) || servers[server]?.description?.trim()) {
      continue;
    }
    const line = summaryLine(tool.namespace?.instructions);
    if (line && next[server] !== line) {
      next[server] = line;
      changed = true;
    }
  }
  return changed ? next : undefined;
}

/** Whether something accepts a TCP connection at the URL's host and port within `timeoutMs`. A refused or silent port is down; the check never throws. */
export function probeUrl(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      resolve(false);
      return;
    }
    const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
    const socket = net.connect({ host: u.hostname.replace(/^\[|\]$/g, ""), port });
    const done = (up: boolean): void => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}
