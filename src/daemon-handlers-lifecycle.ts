// Commands about which sessions exist and who is driving them: prompting,
// spawning, adopting, attaching, deleting, renaming.
import * as fs from "node:fs";
import type * as net from "node:net";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { findAgent } from "./agents.ts";
import { TRASH_DIR } from "./config.ts";
import type { Cmd, DaemonContext, Responder } from "./daemon-context.ts";
import { historyOf, sendHistory } from "./daemon-history.ts";
import type { DaemonSession } from "./daemon-session.ts";
import { forkSnapshot } from "./fork-snapshot.ts";
import { forkNote, recordFork, sessionIdOfFile } from "./lineage.ts";
import { wasHandled } from "./handled-files.ts";
import { profileOfSession } from "./session-agents.ts";
import { log } from "./log.ts";
import { restoreTrashedSession, trashSessionFile } from "./trash.ts";
import { errText } from "./util.ts";

export async function handlePrompt(
  ctx: DaemonContext,
  cmd: Cmd<"prompt">,
  socket: net.Socket,
  res: Responder,
): Promise<void> {
  let s: DaemonSession | undefined;
  if (cmd.session !== undefined) {
    s = ctx.registry.get(cmd.session);
    if (!s) {
      throw new Error(`unknown session ${cmd.session}`);
    }
  } else if (cmd.sessionFile) {
    if (!cmd.cwd) {
      throw new Error("prompt for an untracked session requires cwd");
    }
    log(`prompt for file ${cmd.sessionFile} (confirmFork=${cmd.confirmFork ? "yes" : "no"})`);
    if (ctx.presence.has(cmd.sessionFile)) {
      throw new Error("session is live in another pi process - /adopt to fork it into toriel");
    }
    s = ctx.registry.byFile(cmd.sessionFile);
    if (!s && !fs.existsSync(cmd.sessionFile)) {
      // a controller still showing a session that was deleted meanwhile (a finished subagent swept, a /delete elsewhere)
      throw new Error("that session was deleted (its file is gone) - /restore brings it back from the trash");
    }
    if (!s) {
      // A file this daemon has never handled may be open in an external,
      // presence-less pi process - undetectable directly, but a very recent
      // mtime is a strong signal. Continuing would branch the conversation
      // (pi's tree keeps both sides), so ask once before touching the file.
      // Files the daemon has handled before are its own: no confirm, whatever
      // their mtime (a resume makes them look freshly written).
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(cmd.sessionFile).mtimeMs;
      } catch {
        // stat failure: treat as old
      }
      // a file toriel ran before a daemon restart is its own, however fresh its mtime
      if (Date.now() - mtimeMs < 60_000 && !cmd.confirmFork && !wasHandled(cmd.sessionFile)) {
        res(true, undefined, { confirmFork: true, ageMs: Math.round(Date.now() - mtimeMs) });
        return;
      }
      s = ctx.registry.create(cmd.cwd, cmd.sessionFile);
      log(`session ${s.id} registered from file ${cmd.sessionFile}`);
    }
  } else {
    throw new Error("prompt requires session or sessionFile");
  }

  if (s.starting) {
    await s.starting;
  }
  if (s.held) {
    s.held.push({ text: cmd.message, images: cmd.images });
    ctx.hub.announceQueue(s.id, s.held.map((h) => h.text));
    res(true, undefined, { disposition: "queued" });
    return;
  }
  if (s.child && !s.attachedTo) {
    // Free live session: the prompter implicitly takes the input attach.
    s.attachedTo = socket;
    ctx.hub.broadcastSessions();
  }
  if (!s.child) {
    // Inactive or dead: (re)spawn, attach the requester, then prompt.
    if (s.attachedTo && s.attachedTo !== socket) {
      throw new Error("session is attached to another controller");
    }
    if (s.spawning) {
      throw new Error("spawn in progress; retry");
    }
    s.attachedTo = socket;
    await ctx.children.start(s, { sessionFile: cmd.sessionFile, name: cmd.name });
    ctx.hub.broadcastSessions();
    await sendHistory(ctx, socket, s);
  }
  // "steer" covers both cases: executes immediately when idle, and is
  // queued as a steering message when a run is already in flight.
  await s.child!.prompt(cmd.message, cmd.images, "steer");
  res(true, undefined, { disposition: "started" });
}

export async function handleSpawn(
  ctx: DaemonContext,
  cmd: Cmd<"spawn">,
  socket: net.Socket,
  res: Responder,
): Promise<void> {
  const agent = cmd.agent ? findAgent(cmd.agent, cmd.cwd) : undefined;
  const existing = cmd.sessionFile
    ? ctx.registry.byFile(cmd.sessionFile)
    : undefined;
  const s = existing ?? ctx.registry.create(cmd.cwd, cmd.sessionFile);
  if (s.child && s.attachedTo && s.attachedTo !== socket) {
    throw new Error("session is attached to another controller");
  }
  if (!s.child) {
    if (s.spawning) {
      throw new Error("spawn in progress; retry");
    }
    if (s.attachedTo && s.attachedTo !== socket) {
      throw new Error("session is attached to another controller");
    }
    s.attachedTo = socket;
    // Respond as soon as the session is registered (startChild has already
    // broadcast it as spawning) so the controller can open it immediately;
    // prompts arriving before the child is up wait on s.starting.
    const starting = ctx.children.start(s, { sessionFile: cmd.sessionFile, name: cmd.name, agent }).then(async () => {
      if (cmd.name && !s.sessionName) {
        await s.child!.setSessionName(cmd.name);
        await ctx.children.refreshMeta(s);
      }
      ctx.hub.broadcastSessions();
      await sendHistory(ctx, socket, s);
    });
    s.starting = starting.finally(() => {
      s.starting = undefined;
    });
    s.starting.catch((err: unknown) => {
      log(`session ${s.id} spawn failed: ${errText(err)}`);
      s.attachedTo = undefined;
      ctx.hub.broadcastSessions();
    });
    if (cmd.ready) {
      await starting;
    }
    res(true, undefined, { sessionId: s.id, uuid: s.sessionId });
    return;
  }
  if (cmd.ready) {
    await s.starting;
  }
  res(true, undefined, { sessionId: s.id });
}

/**
 * Delete a session the way /delete does: stop its process, drop its schedules and grants, forget
 * it and move its file to the trash. Returns where the file went (undefined for a session that
 * never had one). Throws for a bare path with nothing behind it.
 */
export async function removeSession(ctx: DaemonContext, s: DaemonSession | undefined, file: string | undefined): Promise<string | undefined> {
  if (s?.child) {
    await ctx.children.deactivate(s);
  }
  // a deleted session takes its schedules and permission grants with it (a stopped one keeps them and is woken when they fire)
  const uuid = s?.sessionId ?? (file ? /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(file)?.[0] : undefined);
  if (uuid) {
    const gone = ctx.scheduler.removeSession(uuid);
    if (gone.length > 0) {
      log(`removed ${gone.length} schedule(s) of the deleted session ${uuid}`);
    }
    const grants = ctx.grants.removeSession(uuid);
    if (grants.length > 0) {
      log(`removed ${grants.length} permission grant(s) of the deleted session ${uuid}`);
    }
  }
  if (s) {
    ctx.registry.delete(s.id);
  }
  // A never-prompted session has no file on disk - dropping the entry is
  // the whole delete. Only a bare path with nothing behind it is an error.
  let trashedTo: string | undefined;
  if (file && fs.existsSync(file)) {
    trashedTo = trashSessionFile(file, TRASH_DIR);
    log(`trashed ${file} -> ${trashedTo}`);
  } else if (!s) {
    throw new Error(`session file does not exist: ${file}`);
  }
  return trashedTo;
}

export async function handleDelete(
  ctx: DaemonContext,
  cmd: Cmd<"delete">,
  res: Responder,
): Promise<void> {
  const s = ctx.registry.find(cmd);
  const file = s?.sessionFile ?? cmd.path;
  if (!file) {
    throw new Error("delete requires a session or path");
  }
  const trashedTo = await removeSession(ctx, s, file);
  ctx.hub.broadcastSessions();
  res(true, undefined, { trashedTo });
}

export async function handleRename(
  ctx: DaemonContext,
  cmd: Cmd<"rename">,
  res: Responder,
): Promise<void> {
  const name = cmd.name.trim();
  if (!name) {
    throw new Error("name is empty");
  }
  const s = ctx.registry.find(cmd);
  if (s?.child) {
    await s.child.setSessionName(name);
    await ctx.children.refreshMeta(s);
    ctx.hub.broadcastSessions();
  } else if (cmd.path) {
    const mgr = SessionManager.open(cmd.path);
    mgr.appendSessionInfo(name);
  } else {
    throw new Error("rename requires a session or path");
  }
  res(true);
}

/** Replace one controller's view of a live session with its current history. Needs a running child; changes nothing in the session. */
export async function handleResync(ctx: DaemonContext, cmd: Cmd<"resync">, socket: net.Socket, res: Responder): Promise<void> {
  const s = ctx.registry.live(cmd.session);
  const history = await historyOf(s);
  // both counts and what the history is made of, so the cause of a drift can be read off the log (board 181)
  const roles: Record<string, number> = {};
  for (const m of history as Array<{ role?: string; outOfContext?: boolean }>) {
    const key = `${m.role ?? "?"}${m.outOfContext ? "(old)" : ""}`;
    roles[key] = (roles[key] ?? 0) + 1;
  }
  log(`session ${s.id}: controller asked for a resync (its view drifted from pi's message count): view saw ${cmd.seen ?? "?"}, history has ${history.length} ${JSON.stringify(roles)}, pi's own count ${s.messageCount ?? "?"}`);
  ctx.hub.send(socket, { type: "history", session: s.id, messages: history });
  res(true);
}

export async function handleAttach(
  ctx: DaemonContext,
  cmd: Cmd<"attach">,
  socket: net.Socket,
  res: Responder,
): Promise<void> {
  const s = ctx.registry.live(cmd.session);
  if (s.attachedTo === socket) {
    // asked again: the controller may have missed the dialog that is waiting
    if (s.pendingDialog && s.lastDialog) {
      ctx.hub.send(socket, { type: "ui_request", session: s.id, request: s.lastDialog });
    }
    res(true);
    return;
  }
  if (s.attachedTo && !cmd.force) {
    throw new Error("attached to another controller (repeat to take over)");
  }
  s.attachedTo = socket;
  ctx.hub.broadcastSessions();
  if (s.pendingDialog && s.lastDialog) {
    ctx.hub.send(socket, { type: "ui_request", session: s.id, request: s.lastDialog });
  }
  await sendHistory(ctx, socket, s);
  res(true);
}

export function handleDetach(
  ctx: DaemonContext,
  cmd: Cmd<"detach">,
  socket: net.Socket,
  res: Responder,
): void {
  const s = ctx.registry.get(cmd.session);
  if (s?.attachedTo === socket) {
    s.attachedTo = undefined;
    ctx.hub.broadcastSessions();
  }
  res(true);
}

export async function handleDeactivate(
  ctx: DaemonContext,
  cmd: Cmd<"deactivate">,
  res: Responder,
): Promise<void> {
  const s = ctx.registry.get(cmd.session);
  if (!s) {
    throw new Error(`unknown session ${cmd.session}`);
  }
  await ctx.children.deactivate(s);
  ctx.hub.broadcastSessions();
  res(true);
}

export function handleExternalRegister(
  ctx: DaemonContext,
  cmd: Cmd<"external_register">,
  res: Responder,
): void {
  const file = cmd.sessionFile;
  if (ctx.registry.all().some((s) => (s.child as { process?: { pid?: number } } | undefined)?.process?.pid === cmd.pid)) {
    // a daemon-owned child loaded the presence extension before the
    // TORIEL_CHILD guard existed - never treat our own children as
    // external
    log(`ignoring self-registration from daemon child (pid ${cmd.pid})`);
    res(true);
    return;
  }
  if (cmd.live) {
    ctx.presence.register(file, { pid: cmd.pid, cwd: cmd.cwd });
    log(`external pi registered: ${file} (pid ${cmd.pid})`);
  } else {
    ctx.presence.deregister(file);
    log(`external pi deregistered: ${file}`);
  }
  ctx.hub.broadcastSessions();
  res(true);
}

/** Fork a session that is live in some other pi process into a toriel-managed one. */
export async function handleAdopt(
  ctx: DaemonContext,
  cmd: Cmd<"adopt">,
  socket: net.Socket,
  res: Responder,
): Promise<void> {
  if (!cmd.path || !fs.existsSync(cmd.path)) {
    throw new Error("adopt: session file not found");
  }
  if (!cmd.cwd) {
    throw new Error("adopt requires cwd");
  }
  const existing = cmd.fork ? undefined : ctx.registry.byFile(cmd.path);
  if (existing?.child) {
    // already daemon-managed and live: nothing to adopt
    res(true, undefined, { sessionId: existing.id });
    return;
  }
  const s = existing ?? ctx.registry.create(cmd.cwd);
  if (s.attachedTo && s.attachedTo !== socket) {
    throw new Error("session is attached to another controller");
  }
  s.attachedTo = socket;
  s.spawning = true;
  ctx.hub.broadcastSessions();
  const parentId = sessionIdOfFile(cmd.path);
  const parentFile = cmd.path;
  const parentName = cmd.parentName ?? "(unnamed)";
  // a parent that is mid-run has a file that may end in the middle of a turn: fork from its last settled point
  const snapshot = cmd.fork ? forkSnapshot(cmd.path) : undefined;
  try {
    // the same arguments as any other start (extensions, tools, profile): a fork built by hand
    // loaded none of toriel's extensions, so the inherited toriel_* tools were dropped
    // the fork learns its parent now; its own id is not known until it starts
    // through start(), so a fork comes up the way every other session does (recorded as handled, bridge detected)
    await ctx.children.start(s, {
      forkPath: snapshot?.path ?? cmd.path,
      name: cmd.name,
      // a fork of a profiled session (a subagent, say) is the same kind of agent: same tools and scope, kept across respawns
      agent: cmd.fork ? profileOfSession(parentId) : undefined,
      appendSystemPrompt: parentId ? forkNote({ id: parentId, name: parentName, file: parentFile }) : undefined,
    });
    if (cmd.name) {
      await s.child?.setSessionName(cmd.name);
      await ctx.children.refreshMeta(s);
    }
    log(`session ${s.id} adopted (forked from ${cmd.path}${snapshot && snapshot.dropped > 0 ? `, without its last ${snapshot.dropped} unfinished entries` : ""})`);
  } catch (err) {
    // do not leave a half-registered session (attached, no child) behind
    s.attachedTo = undefined;
    throw err;
  } finally {
    snapshot?.cleanup();
    s.spawning = false;
    ctx.hub.broadcastSessions();
  }
  if (parentId && s.sessionId && s.sessionFile) {
    recordFork(
      { id: parentId, name: parentName, file: parentFile },
      { id: s.sessionId, name: cmd.name ?? s.sessionName ?? "(unnamed)", file: s.sessionFile },
    );
  }
  let grantsCopied = 0;
  if (cmd.fork && cmd.keepPermissions && parentId && s.sessionId) {
    grantsCopied = ctx.grants.copySession(parentId, s.sessionId).length;
    if (grantsCopied > 0) {
      log(`session ${s.id} took ${grantsCopied} permission grants from ${parentId}`);
      ctx.hub.broadcastSessions();
    }
  }
  await sendHistory(ctx, socket, s);
  res(true, undefined, { sessionId: s.id, sessionUuid: s.sessionId, grantsCopied });
}

export function handleRestore(cmd: Cmd<"restore">, res: Responder): void {
  const restored = restoreTrashedSession(cmd.trashedTo, TRASH_DIR);
  log(`restored deleted session ${restored}`);
  res(true, undefined, { path: restored });
}
