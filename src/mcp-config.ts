// toriel's MCP config file (tickets 209 and 216): ~/.config/toriel/mcp.yaml holds every MCP server, and the toriel-mcp extension
// registers them into pi. This is the daemon/controller half: where the file is, reading it, and the edits `/mcp add`, `/mcp remove`
// and the doctor make to it. Edits go through the yaml Document so a person's comments and ordering survive. What an entry may
// hold, and how a file is parsed, is pi/extensions/lib/mcp-config.ts (shared with the extension).
import * as fs from "node:fs";
import { isMap, parseDocument } from "yaml";
import { checkEntry, type McpServerConfig, parseMcpYaml, redactUrl } from "../pi/extensions/lib/mcp-config.ts";
import { mcpYamlFile } from "./config-dir.ts";
import { errText, writeFileAtomic } from "./util.ts";

export { mcpYamlFile };

/** What a new file starts with: what the file is and one commented example, so there is something to copy. */
export const MCP_YAML_HEADER = `# MCP servers for toriel. Every server a session can use is configured here (pi's own mcp.json is not used):
# the toriel-mcp extension registers each one into pi when a session starts. /mcp add and /mcp remove edit this
# file; comments and ordering are kept. A change applies to sessions started after it (or /reload).
#
# servers:
#   some-bridge:                              # the name; tools become mcp__some-bridge__<tool>
#     url: http://127.0.0.1:39280/mcp         # a remote server... (or command/args for one run over stdio)
#     whenUp: true                            # only when something listens at the URL as a session starts; /mcp-up looks again
#   some-tool:
#     command: uvx
#     args: [some-tool-mcp]
#     env: { SOME_API_KEY: "..." }
#     exposure: direct                        # direct = the agent gets the tools at once; codemode (default) = through a script
#     timeout: 60                             # seconds
#     enabled: true
`;

/** The servers of the file and what was wrong with it; a missing file is no servers and no problems. */
export function readMcpYaml(file: string = mcpYamlFile()): { servers: Record<string, McpServerConfig>; problems: string[] } {
  try {
    return parseMcpYaml(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { servers: {}, problems: [] };
    }
    return { servers: {}, problems: [`${file} could not be read: ${errText(err)}`] };
  }
}

/** The file's text as a yaml Document, or a new one with the header when there is no file. Throws a message that names the file when it is not valid YAML. */
function loadDocument(file: string) {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`${file} could not be read (${errText(err)})`);
    }
    text = MCP_YAML_HEADER;
  }
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    throw new Error(`${file} is not valid YAML (${doc.errors[0]?.message.split("\n")[0]}); fix it by hand first`);
  }
  if (!isMap(doc.get("servers")) && doc.get("servers") !== null && doc.get("servers") !== undefined) {
    throw new Error(`${file}: "servers" must be a mapping; fix it by hand first`);
  }
  return doc;
}

function save(file: string, doc: { toString(): string }): void {
  writeFileAtomic(file, doc.toString(), 0o600);
}

/** Add `name` to the file, keeping everything else as it was. Refuses to replace an existing server or to touch a file that is not valid YAML. */
export function addMcpServer(file: string, name: string, entry: McpServerConfig): void {
  const checked = checkEntry(name, entry);
  if ("problem" in checked) {
    throw new Error(checked.problem);
  }
  const doc = loadDocument(file);
  if (doc.hasIn(["servers", name])) {
    throw new Error(`server "${name}" already exists in ${file}`);
  }
  if (!isMap(doc.get("servers"))) {
    doc.set("servers", doc.createNode({}));
  }
  doc.setIn(["servers", name], doc.createNode(checked.entry));
  save(file, doc);
}

/** Remove `name` from the file, keeping the rest. Throws a message that says so when it is not there. */
export function removeMcpServer(file: string, name: string): void {
  const doc = loadDocument(file);
  if (!doc.hasIn(["servers", name])) {
    throw new Error(`"${name}" is not in ${file}`);
  }
  doc.deleteIn(["servers", name]);
  save(file, doc);
}

/** Set one key of one server's entry (the doctor's `exposure: direct` fix). Throws when the server is not there. */
export function setMcpServerKey(file: string, name: string, key: string, value: unknown): void {
  const doc = loadDocument(file);
  if (!doc.hasIn(["servers", name])) {
    throw new Error(`"${name}" is not in ${file}`);
  }
  doc.setIn(["servers", name, key], value);
  save(file, doc);
}

/**
 * The servers of a pi mcp.json, as mcp.yaml entries, for the one-time move (ticket 216). Keys mcp.yaml does not know are listed in
 * `dropped` (as `name.key`) so the move can say what it did not carry over. A file that is missing or not JSON is no servers.
 */
export function importMcpJson(jsonFile: string): { servers: Record<string, McpServerConfig>; dropped: string[]; skipped: string[] } {
  const servers: Record<string, McpServerConfig> = {};
  const dropped: string[] = [];
  const skipped: string[] = [];
  let raw: { mcpServers?: Record<string, Record<string, unknown>> };
  try {
    raw = JSON.parse(fs.readFileSync(jsonFile, "utf8"));
  } catch {
    return { servers, dropped, skipped };
  }
  for (const [name, entry] of Object.entries(raw.mcpServers ?? {})) {
    if (typeof entry !== "object" || entry === null) {
      skipped.push(name);
      continue;
    }
    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(entry)) {
      if (["command", "args", "env", "cwd", "url", "headers", "type", "exposure", "toolExposure", "enabled", "timeout", "description"].includes(key)) {
        kept[key] = value;
      } else {
        dropped.push(`${name}.${key}`);
      }
    }
    const checked = checkEntry(name, kept);
    if ("problem" in checked) {
      skipped.push(name);
    } else {
      servers[name] = checked.entry;
    }
  }
  return { servers, dropped, skipped };
}

/** An entry safe to show: the values of env and headers (secrets) replaced by `***`, a URL's credentials and query hidden. The names stay, so it is still clear what is set. */
export function redactEntry(entry: McpServerConfig): McpServerConfig {
  const hide = (m: Record<string, string> | undefined) => (m === undefined ? undefined : Object.fromEntries(Object.keys(m).map((k) => [k, "***"])));
  const out: McpServerConfig = { ...entry };
  if (entry.env) {
    out.env = hide(entry.env);
  }
  if (entry.headers) {
    out.headers = hide(entry.headers);
  }
  if (entry.url !== undefined) {
    out.url = redactUrl(entry.url);
  }
  return out;
}

/** mcp.yaml's text for `servers`, after the header (for a first import into a file that does not exist yet). */
export function renderMcpYaml(servers: Record<string, McpServerConfig>): string {
  const doc = parseDocument(MCP_YAML_HEADER);
  doc.set("servers", doc.createNode(servers));
  return doc.toString();
}
