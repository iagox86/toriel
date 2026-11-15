// pi's /mcp command prints its status as plain text; this reads it back into
// records toriel can list and complete from.
import * as fs from "node:fs";
import { mcpYamlFile } from "./config-dir.ts";

export interface McpServer {
  name: string;
  /** Everything after "name: " on its line, e.g. "connected, 12 tools (direct)". */
  detail: string;
}

/** Lines of the /mcp status that are about the configuration, not about one server. */
const NOT_SERVERS = new Set(["config error", "overridden"]);

/** One unindented "name: state ..." line per server; indented lines continue the one above (e.g. an error's stderr tail). */
const SERVER_LINE = /^([^\s:][^:]*?): (.+)$/;

/**
 * Parse /mcp's status text: one unindented "name: state ..." line per server
 * (indented lines continue the one above, e.g. an error's stderr tail).
 */
export function parseMcpStatus(text: string): McpServer[] {
  const servers: McpServer[] = [];
  for (const line of text.split("\n")) {
    const m = SERVER_LINE.exec(line);
    if (m && !NOT_SERVERS.has(m[1] as string)) {
      servers.push({ name: m[1] as string, detail: m[2] as string });
    }
  }
  return servers;
}

export const MCP_ACTIONS = ["list", "status", "explore", "add", "remove", "reconnect", "login", "logout"] as const;
export type McpAction = (typeof MCP_ACTIONS)[number];

export interface Completion {
  value: string;
  description?: string;
}

/**
 * What to offer after "/mcp ": the actions while the first word is being typed,
 * then (for actions that take one) the servers whose name starts with the
 * second word. A value replaces the whole text typed after the command, the way
 * pi's own completer builds them.
 */
export function mcpCompletions(typed: string, servers: readonly McpServer[]): Completion[] {
  const hasSpace = /\s/.test(typed.trimStart());
  const [action = "", prefix = ""] = typed.trimStart().split(/\s+/);
  if (!hasSpace) {
    return MCP_ACTIONS.filter((a) => a.startsWith(action.toLowerCase())).map((a) => ({
      value: a === "list" ? a : `${a} `,
      description:
        a === "list"
          ? "show every server with its state"
          : a === "status"
            ? "troubleshoot: state, error, configuration and checks for each server"
          : a === "add"
            ? "add a server: add <name> <url | command args...>"
            : a === "remove"
              ? "remove a server from mcp.yaml (tab completes its name)"
              : a === "explore"
                ? "have the agent introspect a server and write a skill for it (tab completes its name)"
                : `${a} a server (tab completes its name)`,
    }));
  }
  if (!(MCP_ACTIONS as readonly string[]).includes(action) || action === "list" || action === "add") {
    return [];
  }
  return servers
    .filter((s) => s.name.toLowerCase().startsWith(prefix.toLowerCase()))
    .map((s) => ({ value: `${action} ${s.name}`, description: s.detail }));
}

/**
 * pi's `/mcp login` reports a failed sign-in as "Sign-in failed: <the error's text>", and the text is often a
 * parser's complaint ("Unexpected token '<', "<!DOCTYPE "... is not valid JSON") that says nothing about the
 * cause. For the failures people actually hit, say what probably happened and what to check; undefined for any
 * other message, which is shown as pi wrote it.
 */
export function explainMcpFailure(text: string): string | undefined {
  const m = /^Sign-in failed:\s*([\s\S]*)$/.exec(text.trim());
  if (!m) {
    return undefined;
  }
  const reason = (m[1] ?? "").trim();
  const wrap = (what: string, checks: string[]) => [`MCP sign-in failed: ${what}`, "", ...checks.map((c) => `  - ${c}`), "", `pi's own message: ${reason}`].join("\n");
  if (/Unexpected token '?<|<!DOCTYPE|<html|is not valid JSON/i.test(reason)) {
    return wrap("the server answered with a web page where it should have sent JSON.", [
      "a reverse proxy or a single-sign-on page in front of the server is probably answering instead of it",
      "or the URL in mcp.yaml is a website's front page rather than the MCP endpoint",
      "sign-in asks the server for /.well-known/oauth-* documents: the proxy has to pass those through unchanged",
      "/mcp status <server> shows what the URL answers",
    ]);
  }
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET/i.test(reason)) {
    return wrap("the server could not be reached.", ["the URL in mcp.yaml, and that the server is up", "/mcp status <server> checks whether the URL answers"]);
  }
  if (/certificate|self[- ]signed|CERT_|UNABLE_TO_VERIFY/i.test(reason)) {
    return wrap("the server's TLS certificate was not accepted.", ["a self-signed or expired certificate, or one for another host name", "node uses its own CA list: NODE_EXTRA_CA_CERTS adds yours"]);
  }
  return undefined;
}

export interface McpEntry {
  url?: string;
  command?: string;
  args?: string[];
}

/** An mcp.yaml entry from /mcp add's arguments: a URL means a remote server, anything else is a command to run over stdio. */
export function mcpEntry(target: readonly string[]): McpEntry {
  const [first, ...rest] = target;
  if (!first) {
    throw new Error("give a URL or a command to run");
  }
  if (/^https?:\/\//i.test(first)) {
    if (rest.length > 0) {
      throw new Error("a URL takes no further arguments");
    }
    return { url: first };
  }
  return rest.length > 0 ? { command: first, args: rest } : { command: first };
}

/** Where the MCP servers are configured: toriel's mcp.yaml (ticket 216). */
export function mcpConfigFile(): string {
  return mcpYamlFile();
}

/**
 * The name of a skill for `name` under any of the skills dirs `dirs` (the
 * agent dir's own skills/ plus any extension-provided skills roots like
 * <extension>/skills): a skill directory whose name contains it
 * (case-insensitive). A missing dir means no skills at all.
 * Earlier dirs win, and within a dir the first matching entry.
 */
export function skillForServer(dirs: string[], name: string): string | undefined {
  for (const dir of dirs) {
    const skill = skillInDir(dir, name);
    if (skill !== undefined) {
      return skill;
    }
  }
  return undefined;
}

function skillInDir(dir: string, name: string): string | undefined {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  const needle = name.toLowerCase();
  for (const entry of entries) {
    if (entry.toLowerCase().includes(needle)) {
      return entry;
    }
  }
  return undefined;
}

/**
 * The /mcp list panel's lines: pi's status text with every server line
 * extended by that server's skill presence ("skill: <name>" or "no matching
 * skill (/mcp explore <name>)"; the state text is kept whole). Lines that are
 * not about one server (indented error tails, "config error", "overridden",
 * the none-configured message) pass through unchanged.
 */
export function mcpListLines(text: string, skillsDirs: string[]): string[] {
  // pi's own none-configured text sends people to its mcp.json, which toriel does not use (ticket 216)
  if (/^No MCP servers configured\./.test(text.trim())) {
    return [`No MCP servers are configured. /mcp add <name> <url | command args...> adds one to ${mcpConfigFile()}.`];
  }
  return text.split("\n").map((line) => {
    const m = SERVER_LINE.exec(line);
    if (!m || NOT_SERVERS.has(m[1] as string)) {
      return line;
    }
    const skill = skillForServer(skillsDirs, m[1] as string);
    return `${line} - ${skill ? `skill: ${skill}` : `no matching skill (/mcp explore ${m[1]})`}`;
  });
}

/** Whether `name` is listed as connected in /mcp's status text (as parsed by parseMcpStatus). */
export function mcpServerConnected(text: string, name: string): boolean {
  const server = parseMcpStatus(text).find((s) => s.name === name);
  return server !== undefined && /^connected/i.test(server.detail);
}
