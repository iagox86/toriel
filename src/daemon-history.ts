// What a controller should show for a session.
import * as fs from "node:fs";
import type * as net from "node:net";
import type { DaemonContext } from "./daemon-context.ts";
import type { DaemonSession } from "./daemon-session.ts";
import type { HistoryTurn } from "./shared.ts";
import { getTiming } from "./timing.ts";
import { messagesFromFile } from "./transcript.ts";

const timing = getTiming("daemon");

/**
 * pi's in-context messages, except that once the session has been compacted the
 * file is used - it keeps the whole conversation, with a marker where the
 * compaction happened (pi's own list starts at the summary and has lost
 * everything before it). Not while a run is in flight: the file lacks the
 * message being written.
 */
export async function historyOf(s: DaemonSession): Promise<unknown[]> {
  const live = await timing.timeAsync("daemon_get_messages", { session: s.id }, () => (s.child as NonNullable<DaemonSession["child"]>).getMessages());
  if (s.streaming || !s.sessionFile) {
    return live;
  }
  const file = s.sessionFile;
  try {
    const fromFile = timing.time("daemon_file_history", { session: s.id }, () => messagesFromFile(file));
    return fromFile.some((m) => (m as { role?: string }).role === "compactionSummary") ? fromFile : live;
  } catch {
    return live;
  }
}

/** A compaction entry anywhere in the file (a cheap text test: no parse). A hit on an abandoned branch only costs the exact count below. */
const COMPACTION_ENTRY = /"type"\s*:\s*"compaction"/;

/**
 * `historyOf(s).length` without moving the conversation: the settle digest only needs the number (ticket 181).
 * pi's own count (`get_state`, a few bytes) is the length of its live list; only a session whose file holds a
 * compaction counts differently (the file keeps everything, plus a marker), and only then is the file parsed.
 */
export async function historyLength(s: DaemonSession): Promise<number> {
  const state = await (s.child as NonNullable<DaemonSession["child"]>).getState();
  if (s.streaming || !s.sessionFile) {
    return state.messageCount;
  }
  try {
    if (COMPACTION_ENTRY.test(fs.readFileSync(s.sessionFile, "utf8"))) {
      const fromFile = messagesFromFile(s.sessionFile);
      if (fromFile.some((m) => (m as { role?: string }).role === "compactionSummary")) {
        return fromFile.length;
      }
    }
  } catch {
    // an unreadable file: pi's count, as historyOf falls back to the live list
  }
  return state.messageCount;
}

/** Replace the controller's view of the session with its current history. */
export async function sendHistory(ctx: DaemonContext, socket: net.Socket, s: DaemonSession): Promise<void> {
  ctx.hub.send(socket, { type: "history", session: s.id, messages: await historyOf(s) });
}

/** The text blocks of a pi message's content (a string is itself), and how many tool calls it holds. */
function textAndTools(content: unknown): { text: string; tools: number } {
  if (typeof content === "string") {
    return { text: content, tools: 0 };
  }
  if (!Array.isArray(content)) {
    return { text: "", tools: 0 };
  }
  const parts: string[] = [];
  let tools = 0;
  for (const b of content as Array<{ type?: string; text?: unknown }>) {
    if (b?.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    } else if (b?.type === "toolCall") {
      tools++;
    }
  }
  return { text: parts.join("\n"), tools };
}

/**
 * A conversation reduced to what a chat needs (ticket 279): user and assistant turns with their text, a count of tool calls and a
 * marker where the context was compacted; tool results, thinking and custom entries are left out. The last `last` turns, with how many
 * there were. A turn with no text, no tool calls and no error is dropped (a bare abort is kept).
 */
export function digestHistory(messages: readonly unknown[], last: number): { turns: HistoryTurn[]; total: number } {
  const turns: HistoryTurn[] = [];
  for (const m of messages as Array<Record<string, unknown>>) {
    const role = m?.role;
    if (role === "compactionSummary") {
      turns.push({ role: "compaction", text: "", ...(typeof m.timestamp === "number" ? { at: m.timestamp } : {}) });
      continue;
    }
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    const { text, tools } = textAndTools(m.content);
    const stopReason = typeof m.stopReason === "string" ? m.stopReason : undefined;
    const errorMessage = typeof m.errorMessage === "string" && m.errorMessage ? m.errorMessage : undefined;
    if (!text.trim() && tools === 0 && !errorMessage && stopReason !== "aborted") {
      continue;
    }
    turns.push({
      role,
      text,
      ...(tools > 0 ? { tools } : {}),
      ...(typeof m.timestamp === "number" ? { at: m.timestamp } : {}),
      ...(stopReason === "aborted" ? { stopReason } : {}),
      ...(errorMessage ? { errorMessage } : {}),
    });
  }
  return { turns: turns.slice(Math.max(0, turns.length - Math.max(0, last))), total: turns.length };
}

/** A session's conversation, from the child when there is one, else from its file; empty when there is neither. */
export async function readHistoryOf(s: DaemonSession): Promise<unknown[]> {
  if (s.child) {
    return historyOf(s);
  }
  return s.sessionFile ? messagesFromFile(s.sessionFile) : [];
}
