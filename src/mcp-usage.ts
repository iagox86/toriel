// How much each MCP server is used (ticket 304): the doctor compares it with each server's exposure. A deferred server's tools are
// loaded by tool_search, and every load changes the declared tools, so the next call re-sends the whole conversation uncached; a
// server whose tools are declared from the start costs only cached tokens per call. So a server most sessions use is cheaper
// declared (`direct`), and one few sessions use is cheaper deferred. The answer comes from pi's own session files.
import * as fs from "node:fs";
import * as path from "node:path";

/** Sessions looked at: the ones written in this window. */
export const USAGE_WINDOW_DAYS = 30;
/** Fewer sessions than this say too little to recommend anything. */
export const MIN_SESSIONS = 10;
/** A server called in at least this share of the sessions is worth declaring at once. */
export const DIRECT_SHARE = 0.25;
/** A server declared at once but called in less than this share of the sessions is worth deferring. */
export const DEFERRED_SHARE = 0.05;
/** At most this many session files are read (the newest), so a large history cannot make the doctor slow. */
const MAX_FILES = 400;

export interface McpUsage {
  /** Sessions in the window that made at least one model call. */
  sessions: number;
  /** Per server, in tool-name form (`claude_code`), the sessions that called at least one of its tools. */
  byServer: Record<string, number>;
}

/** The server of an MCP tool name (`mcp__claude_code__claude_start` -> `claude_code`), or undefined for any other tool. */
export function serverOfTool(name: string): string | undefined {
  return /^mcp__(.+?)__./.exec(name)?.[1];
}

/** The servers whose tools one session file's assistant messages called, and whether it made a model call at all. */
export function sessionUsage(text: string): { called: boolean; servers: Set<string> } {
  const servers = new Set<string>();
  let called = false;
  for (const line of text.split("\n")) {
    // only assistant messages matter; the cheap test skips the rest without parsing them
    if (!line.includes('"assistant"')) {
      continue;
    }
    let entry: { type?: string; message?: { role?: string; content?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "message" || entry.message?.role !== "assistant") {
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
  return { called, servers };
}

/** Every .jsonl under `dir` changed since `since`, newest first. A missing directory is none. */
function sessionFiles(dir: string, since: number): string[] {
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

/** Scan pi's session directory for the sessions of the last USAGE_WINDOW_DAYS days. Never throws: an unreadable file is skipped. */
export function scanMcpUsage(sessionsDir: string, now: number = Date.now()): McpUsage {
  const usage: McpUsage = { sessions: 0, byServer: {} };
  for (const file of sessionFiles(sessionsDir, now - USAGE_WINDOW_DAYS * 86_400_000).slice(0, MAX_FILES)) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
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
  }
  return usage;
}

export interface ExposureAdvice {
  server: string;
  /** What the entry should say. */
  exposure: "direct" | "deferred";
  /** Sessions that called it, out of `sessions`. */
  used: number;
  sessions: number;
}

/**
 * What to change, per mcp.yaml entry: `direct` for an enabled server most sessions call that is not declared yet, `deferred` for a
 * `direct` one few sessions call. `hidden` entries and per-tool `toolExposure` are the owner's choice and are left alone. Nothing
 * below MIN_SESSIONS sessions.
 */
export function exposureAdvice(entries: Readonly<Record<string, { exposure?: string; enabled?: boolean; toolExposure?: unknown }>>, usage: McpUsage): ExposureAdvice[] {
  if (usage.sessions < MIN_SESSIONS) {
    return [];
  }
  const out: ExposureAdvice[] = [];
  for (const [name, entry] of Object.entries(entries)) {
    if (entry.enabled === false || entry.exposure === "hidden" || entry.toolExposure !== undefined) {
      continue;
    }
    const used = usage.byServer[name.replace(/-/g, "_")] ?? 0;
    const share = used / usage.sessions;
    if (entry.exposure !== "direct" && share >= DIRECT_SHARE) {
      out.push({ server: name, exposure: "direct", used, sessions: usage.sessions });
    } else if (entry.exposure === "direct" && share < DEFERRED_SHARE) {
      out.push({ server: name, exposure: "deferred", used, sessions: usage.sessions });
    }
  }
  return out;
}
