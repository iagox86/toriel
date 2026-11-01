// Session-to-session messages: one session (or a person, through a tool) tells
// another something. The text lands in the target as a user message with a
// "[from NAME (uuid)]:" label (received.ts), starting the target if it is idle
// on disk. Nobody takes the target's input attach: this is a delivery, not a
// takeover, so whoever is watching keeps their place.
import type { Cmd, DaemonContext, Responder } from "./daemon-context.ts";
import { type FoundSession, findSession } from "./daemon-resolve.ts";
import { deliverToSession } from "./daemon-handlers-bridge.ts";
import type { DaemonSession } from "./daemon-session.ts";
import { log } from "./log.ts";
import { formatReceived } from "./received.ts";

/** Name to put on a message from `fromId`: its session name, else a short id. */
async function senderName(ctx: DaemonContext, fromId: string | undefined): Promise<{ name: string; id: string }> {
  if (!fromId) {
    return { name: "another session", id: "00000000-0000-0000-0000-000000000000" };
  }
  const s = ctx.registry.all().find((x) => x.sessionId === fromId);
  return { name: s?.sessionName ?? `session ${fromId.slice(0, 8)}`, id: fromId };
}

/**
 * Put `body` into the target session as a user message, starting the session
 * if it is idle on disk, or holding it behind a running compaction. Nobody
 * takes the target's input attach. The result is what the caller reports.
 */
export async function deliverToTarget(ctx: DaemonContext, target: FoundSession, body: string): Promise<DeliveryResult> {
  if (!target.file && !target.session?.child) {
    throw new Error(`${target.name ?? "that session"} has not been saved yet - nothing to deliver to`);
  }
  if (target.file && ctx.presence.has(target.file)) {
    throw new Error(`${target.name ?? "that session"} is open in another pi process - /adopt it into toriel first`);
  }
  let s: DaemonSession | undefined = target.session;
  if (!s) {
    s = ctx.registry.byFile(target.file as string) ?? ctx.registry.create(target.cwd ?? process.cwd(), target.file);
  }
  if (s.starting) {
    await s.starting;
  }
  if (s.held) {
    // compacting: pi refuses prompts, so it waits with the others, in order
    s.held.push({ text: body, injected: true });
    ctx.hub.announceQueue(s.id, s.held.map((h) => h.text));
    return { delivered: true, disposition: "queued until compaction ends", to: target.name, toId: target.uuid, session: s.id };
  }
  if (!s.child) {
    if (s.spawning) {
      throw new Error("that session is starting; try again in a moment");
    }
    await ctx.children.start(s, { sessionFile: target.file });
    ctx.hub.broadcastSessions();
  }
  const busy = s.streaming;
  const how = await deliverToSession(ctx, s, body);
  return {
    delivered: true,
    via: how,
    disposition: busy ? "queued behind the work in progress" : how === "bridge" ? "starting a turn" : "started a turn",
    to: target.name,
    toId: target.uuid ?? s.sessionId,
    session: s.id,
  };
}

export interface DeliveryResult {
  delivered: true;
  via?: "bridge" | "legacy";
  disposition: string;
  to?: string;
  toId?: string;
  /** Daemon number of the session that took it. */
  session: number;
}

export async function handleMessage(ctx: DaemonContext, cmd: Cmd<"message">, res: Responder): Promise<void> {
  const text = cmd.text.trim();
  if (!text) {
    throw new Error("message is empty");
  }
  const target = await findSession(ctx, cmd.to);
  if (cmd.from && target.uuid === cmd.from) {
    throw new Error("a session cannot message itself");
  }
  const from = await senderName(ctx, cmd.from);
  const result = await deliverToTarget(ctx, target, formatReceived(from.name, from.id, text));
  log(`message from ${from.name} to session ${result.session} (${result.via === "legacy" ? "legacy steering" : result.via === "bridge" ? "session bridge" : "held"}; ${result.disposition})`);
  const { session: _session, ...reply } = result;
  res(true, undefined, reply);
}
