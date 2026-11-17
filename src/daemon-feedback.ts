// The daemon's side of a /feedback bundle (ticket 239): what only it knows about a session at the moment of the note. The files (the
// session copy, the logs, the doctor report) are the controller's to gather (feedback-bundle.ts); this is the state in memory.
import * as os from "node:os";
import { buildInfo } from "./build-id.ts";
import { brief } from "./decision-log.ts";
import type { Cmd, DaemonContext, Responder } from "./daemon-context.ts";
import { viewOfGrant } from "./daemon-permissions.ts";
import { autoOn, type DaemonSession } from "./daemon-session.ts";
import { piAgentDir } from "./pi-dir.ts";
import { PROTOCOL } from "./shared.ts";
import { loadSettings } from "./settings.ts";
import { collect } from "./updates.ts";

/** The session's own state: its modes, scope, sandbox, grants and any prompt waiting. */
export function sessionSnapshot(ctx: DaemonContext, s: DaemonSession): Record<string, unknown> {
  const settings = loadSettings().settings;
  const title = typeof s.lastDialog?.title === "string" ? s.lastDialog.title : undefined;
  return {
    id: s.id,
    sessionId: s.sessionId,
    sessionFile: s.sessionFile,
    cwd: s.cwd,
    agent: s.agent?.name ?? null,
    model: s.model,
    provider: s.provider,
    streaming: s.streaming,
    messages: s.messageCount,
    live: s.child !== undefined && !s.dead,
    attached: s.attachedTo !== undefined,
    auto: { on: autoOn(s), until: typeof s.autoUntil === "number" ? new Date(s.autoUntil).toISOString() : null },
    plan: s.plan === true,
    denyAfterMs: ctx.children.denyAfterMs(s) ?? null,
    scope: s.scope ?? null,
    // the sandbox wraps bash for a scoped session unless the setting turns it off (daemon-children.ts launch)
    sandboxed: s.scope !== undefined && settings.sandbox !== "off",
    prompt: s.pendingDialog ? { title: brief(title?.split("\n")[0], 160), waitingMs: s.dialogInfo ? Date.now() - s.dialogInfo.at : undefined } : null,
    grants: s.sessionId ? ctx.grants.list(s.sessionId).map((g) => viewOfGrant(ctx, g)) : [],
  };
}

/** The daemon's own build, runtime and settings, and the session's state when one is named. */
export function buildSnapshot(ctx: DaemonContext, session?: number): Record<string, unknown> {
  const build = buildInfo();
  const s = session === undefined ? undefined : ctx.registry.get(session);
  return {
    source: "daemon",
    at: new Date().toISOString(),
    daemon: { pid: process.pid, protocol: PROTOCOL, build: build.label, dir: build.dir, uptimeSeconds: Math.round(process.uptime()), node: process.version, platform: `${os.platform()} ${os.release()} ${os.arch()}`, sessions: ctx.registry.all().length },
    settings: loadSettings().settings,
    // versions of what this daemon's checkout carries: pinned, installed, and whether the user's own copy shadows a bundled one
    packages: collect({ root: build.dir, agentDir: piAgentDir(), cwd: s?.cwd }),
    session: s ? sessionSnapshot(ctx, s) : undefined,
  };
}

export function handleFeedbackSnapshot(ctx: DaemonContext, cmd: Cmd<"feedback_snapshot">, res: Responder): void {
  if (cmd.session !== undefined && !ctx.registry.get(cmd.session)) {
    throw new Error(`no session #${cmd.session}`);
  }
  res(true, undefined, buildSnapshot(ctx, cmd.session));
}
