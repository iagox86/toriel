// What a controller should show for a session.
import * as fs from "node:fs";
import type * as net from "node:net";
import type { DaemonContext } from "./daemon-context.ts";
import type { DaemonSession } from "./daemon-session.ts";
import { messagesFromFile } from "./transcript.ts";

/**
 * pi's in-context messages, except that once the session has been compacted the
 * file is used - it keeps the whole conversation, with a marker where the
 * compaction happened (pi's own list starts at the summary and has lost
 * everything before it). Not while a run is in flight: the file lacks the
 * message being written.
 */
export async function historyOf(s: DaemonSession): Promise<unknown[]> {
  const live = await (s.child as NonNullable<DaemonSession["child"]>).getMessages();
  if (s.streaming || !s.sessionFile) {
    return live;
  }
  try {
    const fromFile = messagesFromFile(s.sessionFile);
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
