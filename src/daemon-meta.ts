// The session list as one controller should see it.
import type * as net from "node:net";
import type { DaemonSession, SessionRegistry } from "./daemon-session.ts";
import type { Presence } from "./presence.ts";
import { scheduleStripLines } from "./schedule-format.ts";
import type { Scheduler } from "./scheduler.ts";
import type { SessionMeta, UsageReport } from "./shared.ts";

function metaFor(s: DaemonSession, socket: net.Socket, presence: Presence, usage: ReadonlyMap<string, UsageReport>, scheduler?: Scheduler): SessionMeta {
  const active = s.sessionId && scheduler ? scheduler.list(s.sessionId).filter((x) => x.state === "active") : [];
  return {
    id: s.id,
    cwd: s.cwd,
    sessionName: s.sessionName,
    model: s.model,
    provider: s.provider,
    usage: s.provider ? usage.get(s.provider) : undefined,
    thinkingLevel: s.thinkingLevel,
    ctxTokens: s.ctxTokens,
    ctxMax: s.ctxMax,
    sessionId: s.sessionId,
    sessionFile: s.sessionFile,
    messageCount: s.messageCount,
    tokens: Math.round(s.totalTokens),
    cost: Math.round(s.totalCost * 10000) / 10000,
    streaming: s.streaming,
    compacting: s.compacting,
    dead: s.dead,
    active: s.child !== undefined,
    pendingDialog: s.pendingDialog,
    settingsMtime: s.child ? s.settingsMtime : undefined,
    settingsProblem: s.child ? s.settingsProblem : undefined,
    sessionBridge: s.child ? s.sessionBridge : undefined,
    agent: s.agent?.name,
    acceptsImages: s.acceptsImages,
    attachedToYou: s.attachedTo === socket,
    attachedElsewhere: s.attachedTo !== undefined && s.attachedTo !== socket,
    externallyLive: s.sessionFile !== undefined && presence.has(s.sessionFile),
    schedules: active.length > 0 ? active.length : undefined,
    scheduleLines: active.length > 0 && scheduler ? scheduleStripLines(active, new Date(), (id) => scheduler.heldReason(id)) : undefined,
    nextFire: s.sessionId && scheduler ? scheduler.soonest(s.sessionId) : undefined,
  };
}

/** Daemon-owned sessions plus the ones only seen through external pi processes. */
export function sessionMetas(
  registry: SessionRegistry,
  presence: Presence,
  usage: ReadonlyMap<string, UsageReport>,
  socket: net.Socket,
  scheduler?: Scheduler,
): SessionMeta[] {
  const metas = registry.all().map((s) => metaFor(s, socket, presence, usage, scheduler));
  const tracked = new Set(metas.map((m) => m.sessionFile).filter((f): f is string => !!f));
  return [...metas, ...presence.pseudoMetas(tracked)];
}
