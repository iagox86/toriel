// How much each MCP server is used (ticket 304): the doctor compares it with each server's exposure. A deferred server's tools are
// loaded by tool_search, and every load changes the declared tools, so the next call re-sends the whole conversation uncached; a
// server whose tools are declared from the start costs only cached tokens per call. So a server most sessions use is cheaper
// declared (`direct`), and one few sessions use is cheaper deferred. The answer comes from pi's own session files.
import * as fs from "node:fs";
import * as path from "node:path";
import { toolServerName } from "../pi/extensions/lib/mcp-config.ts";
import { uuidOfFileName } from "./state-prune.ts";

/** Sessions looked at: the ones written in this window. */
export const USAGE_WINDOW_DAYS = 30;
/** Fewer sessions than this say too little to recommend anything. */
export const MIN_SESSIONS = 10;
/** A server called in at least this share of the sessions is worth declaring at once. */
export const DIRECT_SHARE = 0.25;
/** A server declared at once but called in less than this share of the sessions is worth deferring. */
export const DEFERRED_SHARE = 0.05;
/** At most this many session files are read (the newest), so a large history cannot make the doctor slow. */
export const MAX_FILES = 400;
/** Longest prefix of a session file read, for the same reason: a multi-MB file cannot make the doctor slow either. A session's tool declarations sit at its top (they go into the leading system message), so capping the head keeps what the advice needs; a truncated final line fails to parse and is skipped. */
export const MAX_FILE_BYTES = 2_000_000;

/** What the doctor compares each server's exposure against (ticket 304): `sessions` counts the plain sessions that made at least one model call - agent-profile sessions are left out, since theirs declare their own servers whatever mcp.yaml says, and forks too, whose files repeat their parent's calls. */
export interface McpUsage {
  /** Plain sessions in the window that made at least one model call. */
  sessions: number;
  /** Per server, in tool-name form (`claude_code`), the sessions that called at least one of its tools. */
  byServer: Record<string, number>;
  /** Per server, in tool-name form, the sessions whose system messages declared its tools. In the session file the leading system message carries the tools declared at the first call (a direct server's among them) and a later delta system message each tool_search load or mid-session connect; pi folds the declarations into one leading system message only in the request, not in the file. The honest denominator for the deferred advice, since only these pay the declaration. */
  declared: Record<string, number>;
}

/** The server of an MCP tool name (`mcp__claude_code__claude_start` -> `claude_code`), or undefined for any other tool. */
export function serverOfTool(name: string): string | undefined {
  return /^mcp__(.+?)__./.exec(name)?.[1];
}

/** The servers whose tools one session file's assistant messages called, which its system messages declared, and whether it made a model call at all. */
export function sessionUsage(text: string): { called: boolean; servers: Set<string>; declared: Set<string> } {
  const servers = new Set<string>();
  const declared = new Set<string>();
  let called = false;
  for (const line of text.split("\n")) {
    // only assistant and system messages matter; the cheap test skips the rest without parsing them
    if (!line.includes('"assistant"') && !line.includes('"system"')) {
      continue;
    }
    let entry: { type?: string; message?: { role?: string; content?: unknown; toolsAdded?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "message") {
      continue;
    }
    if (entry.message?.role === "system") {
      // Every system entry's toolsAdded names what pi declared into the model's tool list: the leading system message (the file's
      // top) carries the tools the first call carried, a direct server's among them, and a later delta carries a tool_search load's
      // or a mid-session connect's - both real declarations. A server named in the rendered sections is not declared: the
      // mcp_servers section lists only the servers whose tools pi has NOT declared, suffixed with how they are reached
      // ("(codemode)", "(tool_search)"), and pi leaves a direct server out of it entirely.
      for (const part of Array.isArray(entry.message.toolsAdded) ? entry.message.toolsAdded : []) {
        const name = (part as { name?: unknown }).name;
        const server = typeof name === "string" ? serverOfTool(name) : undefined;
        if (server) {
          declared.add(server);
        }
      }
      continue;
    }
    if (entry.message?.role !== "assistant") {
      continue;
    }
    called = true;
    for (const part of Array.isArray(entry.message.content) ? entry.message.content : []) {
      const p = part as { type?: string; name?: string };
      const server = p.type === "toolCall" && typeof p.name === "string" ? serverOfTool(p.name) : undefined;
      if (server) {
        servers.add(server);
      }
    }
  }
  return { called, servers, declared };
}

/** The first max bytes of a file as text; undefined when it cannot be read. Reads instead of whole-file `readFileSync`, so a multi-MB session file does not make the doctor slow. */
export function readHead(file: string, max = MAX_FILE_BYTES): string | undefined {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return undefined;
  }
  try {
    const buf = Buffer.alloc(Math.min(fs.fstatSync(fd).size, max));
    let got = 0;
    while (got < buf.length) {
      const n = fs.readSync(fd, buf, got, buf.length - got, got);
      if (n <= 0) {
        break;
      }
      got += n;
    }
    return buf.toString("utf8", 0, got);
  } catch {
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
}

/** Every .jsonl under `dir` changed since `since`, newest first. A missing directory is none. */
export function sessionFiles(dir: string, since: number): string[] {
  const found: Array<{ file: string; mtime: number }> = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (e.isFile() && e.name.endsWith(".jsonl")) {
        try {
          const mtime = fs.statSync(p).mtimeMs;
          if (mtime >= since) {
            found.push({ file: p, mtime });
          }
        } catch {
          // gone meanwhile
        }
      }
    }
  };
  walk(dir);
  return found.sort((a, b) => b.mtime - a.mtime).map((f) => f.file);
}

/** Scan pi's session directory for the plain sessions of the last USAGE_WINDOW_DAYS days (`agents`: the session ids launched through an agent profile; `forks`: copies the user made - both left out, since the former declare their own servers whatever mcp.yaml says and the latter repeat their parent's calls). Never throws: an unreadable file is skipped. */
export function scanMcpUsage(sessionsDir: string, opts: { now?: number; agents?: ReadonlySet<string>; forks?: ReadonlySet<string> } = {}): McpUsage {
  const usage: McpUsage = { sessions: 0, byServer: {}, declared: {} };
  for (const file of sessionFiles(sessionsDir, (opts.now ?? Date.now()) - USAGE_WINDOW_DAYS * 86_400_000).slice(0, MAX_FILES)) {
    // session files are named `<timestamp>_<uuid>.jsonl`; the states are keyed by the bare UUID, so pull it out of the name
    const sessionId = uuidOfFileName(file);
    if (sessionId !== undefined && (opts.agents?.has(sessionId) || opts.forks?.has(sessionId))) {
      continue;
    }
    const text = readHead(file);
    if (text === undefined) {
      continue;
    }
    const one = sessionUsage(text);
    if (!one.called) {
      continue;
    }
    usage.sessions++;
    for (const server of one.servers) {
      usage.byServer[server] = (usage.byServer[server] ?? 0) + 1;
    }
    for (const server of one.declared) {
      usage.declared[server] = (usage.declared[server] ?? 0) + 1;
    }
  }
  return usage;
}

export interface ExposureAdvice {
  server: string;
  /** What the entry should say. */
  exposure: "direct" | "deferred";
  /** Sessions that called it, out of `sessions` (which is the sessions that declared it, for the deferred advice). */
  used: number;
  sessions: number;
}

/**
 * What to change, per mcp.yaml entry: `direct` for an enabled server most plain sessions call that is not declared yet, `deferred` for a
 * `direct` one few sessions call. The deferred share is judged against the sessions whose system message declared the server's tools,
 * not against every session in the window: a server added mid-window, usually down (`whenUp`) or run by plain pi sessions outside
 * toriel would otherwise be judged by sessions that never saw it. `hidden` and `codemode` entries and per-tool `toolExposure` are the
 * owner's choice and are left alone (a codemode server's tools reach `tool_search` exactly like a deferred one's, and the exposure
 * decides what pi offers on top). Nothing is said without MIN_SESSIONS sessions to judge from - of the window for the direct advice,
 * and of the ones that declared the server for the deferred one.
 */
export function exposureAdvice(entries: Readonly<Record<string, { exposure?: string; enabled?: boolean; toolExposure?: unknown }>>, usage: McpUsage): ExposureAdvice[] {
  if (usage.sessions < MIN_SESSIONS) {
    return [];
  }
  const out: ExposureAdvice[] = [];
  for (const [name, entry] of Object.entries(entries)) {
    if (entry.enabled === false || entry.exposure === "hidden" || entry.exposure === "codemode" || entry.toolExposure !== undefined) {
      continue;
    }
    const server = toolServerName(name);
    const used = usage.byServer[server] ?? 0;
    if (entry.exposure !== "direct" && used / usage.sessions >= DIRECT_SHARE) {
      out.push({ server: name, exposure: "direct", used, sessions: usage.sessions });
    } else if (entry.exposure === "direct") {
      const declared = usage.declared[server] ?? 0;
      if (declared >= MIN_SESSIONS && used / declared < DEFERRED_SHARE) {
        out.push({ server: name, exposure: "deferred", used, sessions: declared });
      }
    }
  }
  return out;
}
