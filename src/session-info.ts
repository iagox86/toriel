// /info (ticket 255): a copy/pasteable markdown card of one session - where its
// file lives, which model and context it runs on, and the settings toriel
// knows about it - for handing to another agent working on that session so it
// does not have to hunt for them. Pure: it renders from what the caller gives
// it (the daemon's cached session entry and the MCP server NAMES), so nothing
// secret (mcp.yaml entries can hold tokens) can reach the card.
import * as fs from "node:fs";
import * as path from "node:path";
import { fmtTokens, oneLineFlat } from "./format.ts";
import type { SessionMeta } from "./shared.ts";

/** What /info draws from: the daemon's cached session entry, the first message toriel read from the file, and the MCP server names. */
export interface SessionInfo {
  meta: Pick<SessionMeta, "id" | "sessionName" | "sessionId" | "sessionFile" | "cwd" | "model" | "provider" | "thinkingLevel" | "ctxTokens" | "ctxMax" | "agent" | "plan" | "auto" | "grants" | "grantsSaved">;
  firstMessage?: string;
  /** Names and enabled state only, from mcp.yaml - never the entries, which can hold tokens and headers. */
  mcpServers?: readonly { name: string; enabled: boolean }[];
  /** How many mcp.yaml entries could not be read; only the count ever reaches the card. */
  mcpProblems?: number;
}

/** The panel text: a markdown card of the session; absent fields are omitted, and the staleness note says the values are the last known state. */
export function sessionInfo(info: SessionInfo): string {
  const meta = info.meta;
  const lines: string[] = [
    `# Session: ${meta.sessionName ?? "(unnamed)"} (toriel id ${meta.id})`,
    "",
    "_Values are the last known state from the daemon's session list; if the session is sleeping, the model and context values may be stale._",
    "",
  ];
  const field = (label: string, value: string | undefined): void => {
    if (value !== undefined) {
      lines.push(`- **${label}** ${value}`);
    }
  };
  field("session file", meta.sessionFile ? `\`${meta.sessionFile}\`` : undefined);
  field("pi session id", meta.sessionId ? `\`${meta.sessionId}\`` : undefined);
  field("first message", info.firstMessage ? oneLineFlat(info.firstMessage, 200) : undefined);
  field("model", meta.model ? `\`${meta.model}\`` : undefined);
  field("provider", meta.provider);
  field("thinking level", meta.thinkingLevel);
  field("context", contextText(meta.ctxTokens, meta.ctxMax));
  field("directory", meta.cwd ? `\`${meta.cwd}\`` : undefined);
  field("agent profile", meta.agent);
  field("plan mode", meta.plan === true ? "on" : "off");
  field("auto mode", meta.auto === true ? "on" : "off");
  field("permission grants", grantsText(meta.grants, meta.grantsSaved));
  const mcp = mcpLine(info.mcpServers, info.mcpProblems);
  if (mcp !== undefined) {
    lines.push(mcp);
  }
  return lines.join("\n");
}

function mcpLine(servers: readonly { name: string; enabled: boolean }[] | undefined, problems: number | undefined): string | undefined {
  const n = problems ?? 0;
  if (!servers?.length && n <= 0) {
    return undefined;
  }
  const parts: string[] = [];
  if (servers && servers.length > 0) {
    parts.push(servers.map((s) => (s.enabled ? `\`${s.name}\`` : `\`${s.name}\` (disabled)`)).join(", "));
  }
  if (n > 0) {
    parts.push(`(mcp.yaml has ${n} ${n === 1 ? "problem" : "problems"}; see /mcp status)`);
  }
  return `- **MCP servers (configured)** ${parts.join(" ")}`;
}

function contextText(ctxTokens: number | null | undefined, ctxMax: number | undefined): string | undefined {
  if (ctxTokens === null) {
    // just compacted: the true value comes with the next reply; the max is not a bound on it, so it is not mentioned
    return "unknown until the next reply (just compacted)";
  }
  if (ctxTokens !== undefined && ctxMax !== undefined) {
    return `${fmtTokens(ctxTokens)} of ${fmtTokens(ctxMax)} tokens`;
  }
  if (ctxTokens !== undefined) {
    return `${fmtTokens(ctxTokens)} tokens`;
  }
  if (ctxMax !== undefined) {
    return `${fmtTokens(ctxMax)} tokens max`;
  }
  return undefined;
}

function grantsText(grants: number | undefined, saved: number | undefined): string {
  if (grants === undefined && saved === undefined) {
    return "none";
  }
  const parts: string[] = [];
  if (grants !== undefined) {
    parts.push(`${grants} active`);
  }
  if (saved !== undefined) {
    parts.push(`${saved} saved`);
  }
  return parts.join(", ");
}

/** Where /info cards are saved: one markdown file per card. */
export function infoDir(env: NodeJS.ProcessEnv = process.env): string {
  const data = env.XDG_DATA_HOME ?? path.join(env.HOME ?? "", ".local", "share");
  return path.join(data, "toriel", "info");
}

export function saveInfo(text: string, dir = infoDir(), now = new Date()): string {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `info-${stamp}.md`);
  fs.writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`);
  return file;
}
