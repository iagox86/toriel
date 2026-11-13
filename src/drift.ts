// Drift detection: a controller counts the transcript messages it has seen
// (history replay length plus the message events since); the daemon reports how
// many messages pi holds when a run settles. A mismatch means the view missed
// or doubled something, and the cure is the same as for a reconnect: replace the
// view from the daemon's history. See docs/design.md, "Display state: events
// invalidate, snapshots reconcile".

/**
 * How many entries of a history replay one live pi event adds. The invariant: every event that grows what
 * `messagesFromFile` / `get_messages` return counts here, or the next settled digest differs by one and the
 * controller asks for a full resync (ticket 181). That is a finished message of any role the history can
 * hold (pi stores its system prompt as `system` messages), an appended message entry, and a completed
 * compaction, which adds one marker row (an aborted or failed one adds nothing).
 */
export function messagesAdded(ev: Record<string, unknown>): number {
  if (ev.type === "message_end") {
    const role = (ev.message as { role?: string } | undefined)?.role;
    return role === "user" || role === "assistant" || role === "toolResult" || role === "custom" || role === "system" ? 1 : 0;
  }
  if (ev.type === "compaction_end") {
    return ev.aborted !== true && ev.result ? 1 : 0;
  }
  if (ev.type === "entry_appended") {
    return (ev.entry as { type?: string } | undefined)?.type === "custom_message" ? 1 : 0;
  }
  return 0;
}

/** Whether a digest from the daemon shows the view out of step. A streaming session is never judged (events are in flight). */
export function drifted(seen: number | undefined, digest: { messages: number; streaming: boolean }): boolean {
  if (digest.streaming || seen === undefined) {
    return false;
  }
  return seen !== digest.messages;
}
