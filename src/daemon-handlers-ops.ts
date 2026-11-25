// Commands that act on a live session's child: model, compaction, reload,
// clear, rewind, dialog answers.
import * as fs from "node:fs";
import type * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { compactAndWait } from "./compact-wait.ts";
import { bangEnv } from "./child-env.ts";
import { PLAN_DIR, SOCK, TRASH_DIR } from "./config.ts";
import { planOn, setPlanOn } from "../pi/extensions/lib/plan-mode.ts";
import { type Cmd, type DaemonContext, requireNotInPi, type Responder } from "./daemon-context.ts";
import { deliverToSession } from "./daemon-handlers-bridge.ts";
import { sendHistory } from "./daemon-history.ts";
import { answerText, recordDecision } from "./decision-log.ts";
import { autoOn, type DaemonSession, type HeldPrompt, requireIdle } from "./daemon-session.ts";
import { formatLocalCommand, type LocalResult, runLocal } from "./local-command.ts";
import { log } from "./log.ts";
import { matchModel, modelName } from "./model-match.ts";
import { matchThinkingLevel } from "./think-match.ts";
import { clearFile, latestClearBackup, restoreClear, rewindFile, rewindTargets } from "./rewind.ts";
import { restoreCode } from "./rewind-code.ts";
import { setSessionFileCwd } from "./session-header.ts";
import { encodeLine } from "./shared.ts";
import { fmtClock, fmtDuration, parseDurationText } from "./when.ts";
import { MAX_DENY_MS, minDenyMs } from "./settings.ts";

/** The longest one stretch of timed auto mode (a forgotten one should not outlive the day). */
const MAX_AUTO_MS = 24 * 3_600_000;

export async function handleAbort(
  ctx: DaemonContext,
  cmd: Cmd<"abort">,
  res: Responder,
): Promise<void> {
  await ctx.registry.live(cmd.session).child.abort();
  res(true);
}

/**
 * `!command`: run it here, then tell the agent at once (an ordinary message in
 * <local-command> tags, which starts a turn or queues behind the one running).
 * pi's own `bash` call is avoided on purpose: it would only show the output to
 * the model with the user's next message.
 */
export async function handleBash(ctx: DaemonContext, cmd: Cmd<"bash">, res: Responder): Promise<void> {
  const s = ctx.registry.live(cmd.session);
  if (s.held) {
    throw new Error("session is compacting; wait for it to finish");
  }
  if (s.localCommand) {
    throw new Error("a ! command is already running here (esc stops it)");
  }
  const abort = new AbortController();
  s.localCommand = abort;
  let result: LocalResult;
  try {
    result = await runLocal(cmd.command, s.cwd, abort.signal, undefined, bangEnv(s, SOCK));
  } finally {
    s.localCommand = undefined;
  }
  const text = formatLocalCommand(cmd.command, result);
  const child = ctx.registry.get(cmd.session)?.child;
  if (child) {
    await child.prompt(text, undefined, "steer");
  }
  res(true, undefined, result);
}

export async function handleAbortBash(ctx: DaemonContext, cmd: Cmd<"abort_bash">, res: Responder): Promise<void> {
  ctx.registry.live(cmd.session).localCommand?.abort();
  res(true);
}

/** Name of the toriel-jobs extension command (the same string as BACKGROUND_COMMAND in pi/extensions/toriel-jobs.ts; a test keeps them equal). */
export const BACKGROUND_COMMAND = "toriel-background";

/**
 * Ask the session's pi to move the bash command(s) the agent is waiting for to the
 * background. The extension command runs at once even mid-turn and answers with a
 * notice ("Moved to the background: j2 (...)" or "No command is running in the
 * foreground"). Never prompt for a command pi does not have: it would reach the
 * model as text.
 */
export async function handleBackground(ctx: DaemonContext, cmd: Cmd<"background">, res: Responder): Promise<void> {
  const s = ctx.registry.live(cmd.session);
  // a subagent the agent is waiting for moves first (ticket 212); one ctrl-b does one kind of thing, the next press moves a command too
  const agents = s.sessionId ? ctx.subagents.backgroundForeground(s.sessionId) : [];
  if (agents.length > 0) {
    ctx.hub.broadcast({ type: "notice", session: s.id, text: `moved to the background: ${agents.map((r) => `subagent #${r.handle} (${r.agent})`).join(", ")}; the result arrives as a message`, durable: true });
    res(true);
    return;
  }
  const child = s.child;
  const commands = await child.getCommands();
  if (!commands.some((c) => c.name === BACKGROUND_COMMAND)) {
    throw new Error("this session's pi does not have the background-jobs extension; restart the session");
  }
  await child.prompt(`/${BACKGROUND_COMMAND}`);
  res(true);
}

/**
 * Switch auto mode for a session (ticket 213; see auto-mode.ts for what it answers and the floor it never does). A sleeping
 * session may have it set: the flag is the daemon's, not the child's. Says so in the transcript either way, since a mode that
 * answers prompts must never be ambiguous.
 */
export function handleAutoMode(ctx: DaemonContext, cmd: Cmd<"auto_mode">, res: Responder): void {
  const s = ctx.registry.get(cmd.session);
  if (!s) {
    throw new Error(`no session #${cmd.session}`);
  }
  const on = cmd.on ?? !autoOn(s);
  let ms: number | undefined;
  if (on && cmd.for !== undefined) {
    const d = parseDurationText(cmd.for);
    if (!d.ok) {
      throw new Error(d.error);
    }
    if (d.ms > MAX_AUTO_MS) {
      throw new Error(`auto mode can last at most ${fmtDuration(MAX_AUTO_MS)} at a time`);
    }
    ms = d.ms;
  }
  clearTimeout(s.autoTimer);
  s.autoTimer = undefined;
  if (!on) {
    s.autoUntil = undefined;
  } else {
    s.autoUntil = ms === undefined ? null : Date.now() + ms;
    if (ms !== undefined) {
      s.autoTimer = setTimeout(() => endAuto(ctx, s), ms);
      s.autoTimer.unref();
    }
  }
  const until = typeof s.autoUntil === "number" ? s.autoUntil : undefined;
  log(`auto mode ${on ? "on" : "off"} for session ${s.id}${until !== undefined ? ` until ${new Date(until).toISOString()}` : ""}`);
  if (cmd.quiet !== true) {
    ctx.hub.broadcast({ type: "notice", session: s.id, text: autoNotice(on, until), durable: true });
  }
  ctx.hub.broadcastSessions();
  res(true, undefined, { on, until });
}

/**
 * Switch plan mode for a session (ticket 229, pi/extensions/lib/plan-mode.ts): the marker file is the state, so a sleeping session
 * may have it set and the child that wakes finds it. The agent learns on its next prompt; the notice says so in the transcript.
 */
export function handlePlanMode(ctx: DaemonContext, cmd: Cmd<"plan_mode">, res: Responder): void {
  const s = ctx.registry.get(cmd.session);
  if (!s) {
    throw new Error(`no session #${cmd.session}`);
  }
  if (!s.sessionId) {
    throw new Error("this session has no id yet: send a message first");
  }
  const on = cmd.on ?? !planOn(PLAN_DIR, s.sessionId);
  setPlanOn(PLAN_DIR, s.sessionId, on);
  s.plan = on;
  log(`plan mode ${on ? "on" : "off"} for session ${s.id}`);
  if (cmd.quiet !== true) {
    ctx.hub.broadcast({ type: "notice", session: s.id, text: planNotice(on), durable: true });
  }
  ctx.hub.broadcastSessions();
  res(true, undefined, { on });
}

/**
 * Publish a session to chat, or stop (ticket 269). Keyed by UUID and only a flag: it never wakes a sleeping session, and the chat
 * bridge (when there is one) reacts to the change. Chat itself has no way to publish.
 */
export function handlePublish(ctx: DaemonContext, cmd: Cmd<"publish">, res: Responder): void {
  if (cmd.unpark) {
    // /park -u: publish again only if the session was published when it was parked
    const back = ctx.published.takeResume(cmd.sessionId);
    if (back) {
      log(`session ${cmd.sessionId} unparked: published to chat again`);
      ctx.hub.broadcastSessions();
    }
    res(true, undefined, { published: ctx.published.has(cmd.sessionId) });
    return;
  }
  if (cmd.on === false && cmd.resume) {
    // /park: unpublish, but remember it, so using the session again publishes it again
    if (ctx.published.park(cmd.sessionId)) {
      log(`session ${cmd.sessionId} parked: no longer published until it is used again`);
      ctx.hub.broadcastSessions();
    }
    res(true, undefined, { published: false });
    return;
  }
  const on = cmd.on ?? !ctx.published.has(cmd.sessionId);
  if (ctx.published.set(cmd.sessionId, on)) {
    log(`session ${cmd.sessionId} ${on ? "published to chat" : "no longer published"}`);
    ctx.hub.broadcastSessions();
  }
  res(true, undefined, { published: on });
}

const autoNotice =(on: boolean, until: number | undefined): string =>
  on
    ? `auto mode ON${until !== undefined ? ` until ${fmtClock(until, new Date())}` : ""}: permission prompts are allowed without asking, except the ones that always ask (credentials, destructive commands, pushes, writes outside the directory); /auto off ends it (shift+tab moves on to the next mode)`
    : "auto mode OFF: permission prompts ask again";

const planNotice = (on: boolean): string =>
  on ? "plan mode ON: the agent can only look (no writes, no edits, commands run read-only) until you approve a plan; /plan off ends it" : "plan mode OFF: the agent can change things again";

/**
 * Say which mode the session is in (ticket 236): the one line a burst of quiet shift+tab changes leaves. Plan wins over auto, as
 * `modeOf` has it; neither is the normal mode, said with both switches' "off" so a reader sees what ended.
 */
export function handleModeNotice(ctx: DaemonContext, cmd: Cmd<"mode_notice">, res: Responder): void {
  const s = ctx.registry.get(cmd.session);
  if (!s) {
    throw new Error(`no session #${cmd.session}`);
  }
  const plan = s.plan === true;
  const text = plan ? planNotice(true) : autoOn(s) ? autoNotice(true, typeof s.autoUntil === "number" ? s.autoUntil : undefined) : "normal mode: permission prompts ask again and the agent can change things again (shift+tab: auto, then plan)";
  ctx.hub.broadcast({ type: "notice", session: s.id, text, durable: true });
  res(true, undefined, { plan, auto: autoOn(s) });
}

/**
 * Set how long this session's permission prompts wait before the daemon denies them (ticket 88): a duration, `off` (wait for ever,
 * whatever the setting says), `default` (follow the permissionDenyAfter setting) or `status`. Replies with the effective wait in ms.
 */
export function handleDenyAfter(ctx: DaemonContext, cmd: Cmd<"deny_after">, res: Responder): void {
  const s = ctx.registry.get(cmd.session);
  if (!s) {
    throw new Error(`no session #${cmd.session}`);
  }
  const word = cmd.after.trim().toLowerCase();
  if (word === "off") {
    s.denyAfter = null;
  } else if (word === "default") {
    s.denyAfter = undefined;
  } else if (word !== "status") {
    const d = parseDurationText(cmd.after);
    if (!d.ok) {
      throw new Error(d.error);
    }
    if (d.ms < minDenyMs() || d.ms > MAX_DENY_MS) {
      throw new Error(`a prompt can wait between ${fmtDuration(minDenyMs())} and ${fmtDuration(MAX_DENY_MS)} before it is denied`);
    }
    s.denyAfter = d.ms;
  }
  const ms = ctx.children.denyAfterMs(s);
  if (word !== "status") {
    log(`deny-after ${ms === undefined ? "off" : fmtDuration(ms)} for session ${s.id}`);
    ctx.hub.broadcast({
      type: "notice",
      session: s.id,
      text: ms === undefined ? "deny-after OFF: permission prompts wait until you answer" : `deny-after ${fmtDuration(ms)}: a permission prompt nobody answers in that time is denied (the agent is told it was refused); /deny-after off ends it`,
      durable: true,
    });
  }
  res(true, undefined, { ms });
}

/** A timed auto mode ran out. */
function endAuto(ctx: DaemonContext, s: DaemonSession): void {
  s.autoTimer = undefined;
  s.autoUntil = undefined;
  ctx.hub.broadcast({ type: "notice", session: s.id, text: "auto mode ended (its time ran out): permission prompts ask again", durable: true });
  ctx.hub.broadcastSessions();
}

export async function handleClearQueue(
  ctx: DaemonContext,
  cmd: Cmd<"clear_queue">,
  res: Responder,
): Promise<void> {
  res(true, undefined, await ctx.registry.live(cmd.session).child.clearQueue());
}

export async function handleCommands(
  ctx: DaemonContext,
  cmd: Cmd<"commands">,
  res: Responder,
): Promise<void> {
  const s = cmd.session === undefined ? undefined : ctx.registry.get(cmd.session);
  res(true, undefined, await ctx.children.slashCommands(s));
}

export async function handleMcpStatus(ctx: DaemonContext, cmd: Cmd<"mcp_status">, res: Responder): Promise<void> {
  res(true, undefined, { text: await ctx.children.mcpStatus(ctx.registry.live(cmd.session)) });
}

export async function handleModel(
  ctx: DaemonContext,
  cmd: Cmd<"model">,
  res: Responder,
): Promise<void> {
  const s = ctx.registry.live(cmd.session);
  const models = await s.child.getAvailableModels();
  if (!cmd.query?.trim()) {
    res(true, undefined, { current: s.model, models: models.map(modelName) });
    return;
  }
  const match = matchModel(models, cmd.query);
  if (match.kind === "none") {
    throw new Error(`no model matches "${cmd.query.trim()}"`);
  }
  if (match.kind === "many") {
    const shown = match.matches.slice(0, 8).map(modelName).join(", ");
    const more = match.matches.length > 8 ? `, +${match.matches.length - 8} more` : "";
    throw new Error(`"${cmd.query.trim()}" matches ${match.matches.length} models: ${shown}${more}`);
  }
  await s.child.setModel(match.model.provider, match.model.id);
  await ctx.children.refreshMeta(s);
  ctx.hub.broadcastSessions();
  res(true, undefined, { model: modelName(match.model) });
}

export async function handleThink(
  ctx: DaemonContext,
  cmd: Cmd<"think">,
  res: Responder,
): Promise<void> {
  const s = ctx.registry.live(cmd.session);
  const levels = await s.child.getAvailableThinkingLevels();
  const current = (await s.child.getState()).thinkingLevel;
  if (!cmd.level?.trim()) {
    res(true, undefined, { current, levels });
    return;
  }
  const match = matchThinkingLevel(levels, cmd.level);
  if (match.kind === "none") {
    throw new Error(`this model has no thinking level "${cmd.level.trim()}" - it supports: ${levels.join(", ")}`);
  }
  if (match.kind === "many") {
    throw new Error(`"${cmd.level.trim()}" matches ${match.matches.length} levels: ${match.matches.join(", ")}`);
  }
  await s.child.setThinkingLevel(match.level);
  await ctx.children.refreshMeta(s);
  ctx.hub.broadcastSessions();
  res(true, undefined, { level: match.level });
}

/** Send what was typed during a compaction, now that pi accepts prompts again. */
async function releaseHeld(ctx: DaemonContext, s: DaemonSession, held: HeldPrompt[]): Promise<void> {
  ctx.hub.announceQueue(s.id, []);
  for (const { text, images, injected } of held) {
    try {
      if (!s.child) {
        throw new Error("the session stopped before the message could be sent");
      }
      if (injected) {
        await deliverToSession(ctx, s, text);
      } else {
        await s.child.prompt(text, images, "steer");
      }
    } catch (err) {
      log(`session ${s.id}: message held during compaction was not delivered: ${err}`);
    }
  }
}

export async function handleCompact(
  ctx: DaemonContext,
  cmd: Cmd<"compact">,
  socket: net.Socket,
  res: Responder,
): Promise<void> {
  const s = ctx.registry.live(cmd.session);
  requireIdle(s);
  s.held = [];
  try {
    const result = await compactAndWait(s.child, cmd.instructions?.trim() || undefined);
    await ctx.children.refreshMeta(s);
    ctx.hub.broadcastSessions();
    // the transcript now starts from the summary: replace the controller's view
    await sendHistory(ctx, socket, s);
    res(true, undefined, { tokensBefore: result?.tokensBefore, tokensAfter: result?.estimatedTokensAfter });
  } finally {
    const held = s.held;
    s.held = undefined;
    if (held.length > 0) {
      await releaseHeld(ctx, s, held);
    }
  }
}

export async function handleReload(
  ctx: DaemonContext,
  cmd: Cmd<"reload">,
  socket: net.Socket,
  res: Responder,
): Promise<void> {
  const s = ctx.registry.live(cmd.session);
  requireIdle(s);
  // the path is set as soon as a session spawns; a session with no message yet has no file behind it,
  // and restarting pi against a missing file re-keys the session (ticket 155)
  if (!s.sessionFile || !fs.existsSync(s.sessionFile)) {
    throw new Error("nothing to reload yet (the session has no file): send a message first");
  }
  await ctx.children.restart(s);
  ctx.hub.broadcastSessions();
  await sendHistory(ctx, socket, s);
  res(true);
}

/** `dir` as an absolute path: ~ is the home directory, a relative path starts from `base`. */
export function resolveDir(dir: string, base: string): string {
  return path.resolve(base, dir.trim().replace(/^~(?=$|\/)/, os.homedir()));
}

export async function handleCd(
  ctx: DaemonContext,
  cmd: Cmd<"cd">,
  socket: net.Socket,
  res: Responder,
): Promise<void> {
  const s = ctx.registry.live(cmd.session);
  requireIdle(s);
  if (!s.sessionFile || !fs.existsSync(s.sessionFile)) {
    throw new Error("nothing to move yet (the session has no file): send a message first, or start one in the right place with /new -C <dir>");
  }
  if (!cmd.dir?.trim()) {
    throw new Error("cd needs a directory");
  }
  const dir = resolveDir(cmd.dir, s.cwd);
  if (!(fs.existsSync(dir) && fs.statSync(dir).isDirectory())) {
    throw new Error(`${dir} is not a directory`);
  }
  if (dir === s.cwd) {
    res(true, undefined, { cwd: dir, changed: false });
    return;
  }
  const before = s.cwd;
  const previous = setSessionFileCwd(s.sessionFile, dir);
  s.cwd = dir;
  log(`session ${s.id} moved from ${previous ?? "(unknown)"} to ${dir}`);
  try {
    await ctx.children.restart(s);
  } catch (err) {
    // pi would not start there: put the file and the session back, so the next message starts it where it was
    setSessionFileCwd(s.sessionFile, previous ?? before);
    s.cwd = before;
    ctx.hub.broadcastSessions();
    throw err;
  }
  ctx.hub.broadcastSessions();
  await sendHistory(ctx, socket, s);
  res(true, undefined, { cwd: dir, changed: true });
}

export async function handleClear(
  ctx: DaemonContext,
  cmd: Cmd<"clear">,
  socket: net.Socket,
  res: Responder,
): Promise<void> {
  const s = ctx.registry.live(cmd.session);
  requireIdle(s);
  const file = s.sessionFile;
  if (!file || !fs.existsSync(file)) {
    throw new Error("nothing to clear yet (no session file)");
  }
  requireNotInPi(ctx, file);
  let result!: ReturnType<typeof clearFile>;
  // an emptied file starts on pi's defaults, so the model and thinking level in use are carried over
  await ctx.children.restartAround(
    s,
    () => {
      result = clearFile(file, TRASH_DIR);
      log(`cleared ${file}: ${result.removed} entries -> ${result.trashedTo}`);
    },
    { keepModel: true },
  );
  ctx.hub.broadcastSessions();
  await sendHistory(ctx, socket, s);
  // the other controllers (the chat bridge) hear that the conversation went; the one that asked flashes its own line
  ctx.hub.broadcast({ type: "notice", session: s.id, text: "conversation cleared: same session, empty conversation (the old contents are in the trash)" });
  res(true, undefined, { removed: result.removed });
}

/** Undo the last /clear of a session: its old contents come back from the trash. */
export async function handleRestoreClear(
  ctx: DaemonContext,
  cmd: Cmd<"restore_clear">,
  socket: net.Socket,
  res: Responder,
): Promise<void> {
  const s = ctx.registry.find(cmd);
  const file = s?.sessionFile ?? cmd.path;
  if (!file) {
    throw new Error("restore requires a session or path");
  }
  requireNotInPi(ctx, file);
  if (s) {
    requireIdle(s);
  }
  const backup = latestClearBackup(TRASH_DIR, file);
  if (!backup) {
    throw new Error("nothing to restore");
  }
  const doRestore = () => {
    restoreClear(file, backup);
    log(`restored ${file} from ${backup.trashedTo}`);
  };
  if (s?.child) {
    // the restored file has messages again, so pi would resume its own model; keep the one in use now
    await ctx.children.restartAround(s, doRestore, { keepModel: true, file });
    await sendHistory(ctx, socket, s);
  } else {
    doRestore();
  }
  ctx.hub.broadcastSessions();
  res(true, undefined, { entries: backup.entries });
}

export async function handleRewind(
  ctx: DaemonContext,
  cmd: Cmd<"rewind">,
  res: Responder,
): Promise<void> {
  const s = ctx.registry.find(cmd);
  const file = s?.sessionFile ?? cmd.path;
  if (!file) {
    throw new Error("rewind requires a session or path");
  }
  requireNotInPi(ctx, file);
  if (s) {
    requireIdle(s);
  }
  if (s?.child) {
    await ctx.children.deactivate(s);
  }
  const result = rewindFile(file, cmd.entryId, TRASH_DIR);
  log(`rewound ${file} before ${cmd.entryId}: ${result.removed} entries -> ${result.trashedTo}`);
  // the files go back after the conversation was cut, so a rewind that fails leaves both as they were
  const code = cmd.code ? codeResult(file, result.ts, true) : undefined;
  ctx.hub.broadcastSessions();
  res(true, undefined, { text: result.text, removed: result.removed, trashedTo: result.trashedTo, ...(code ? { code } : {}) });
}

/** Put the files back for the message at `ts` and say what happened; the log names the files, never their contents. */
function codeResult(file: string, ts: number, dropRecords: boolean): { restored: string[]; left: Array<{ path: string; why: string }> } {
  const r = restoreCode(file, ts, dropRecords);
  log(`restored the code of ${file} to ${new Date(ts).toISOString()}: ${r.restored.length} restored, ${r.left.length} left alone`);
  return { restored: r.restored, left: r.left };
}

/** Put back the files the agent changed since a message, leaving the conversation alone (the "code only" choice of the rewind list). */
export async function handleRestoreCode(ctx: DaemonContext, cmd: Cmd<"restore_code">, res: Responder): Promise<void> {
  const s = ctx.registry.find(cmd);
  const file = s?.sessionFile ?? cmd.path;
  if (!file) {
    throw new Error("restore_code requires a session or path");
  }
  if (s) {
    requireIdle(s);
  }
  const target = rewindTargets(file).find((t) => t.entryId === cmd.entryId);
  if (!target || target.ts <= 0) {
    throw new Error(`no user message ${cmd.entryId} with a time in ${file}`);
  }
  res(true, undefined, { code: codeResult(file, target.ts, false) });
}

/**
 * Start or stop sending this controller every session's dialogs, attached or not (ticket 270). The dialogs open right now are sent
 * at once, so a bridge that connects while a prompt waits still shows it. Needs a controller connection.
 */
export function handleObserveDialogs(ctx: DaemonContext, cmd: Cmd<"observe_dialogs">, socket: net.Socket, res: Responder): void {
  if (!ctx.hub.isController(socket)) {
    throw new Error("observe_dialogs comes from a controller connection");
  }
  const on = cmd.on !== false;
  ctx.hub.observe(socket, on);
  if (on) {
    for (const s of ctx.registry.all()) {
      if (s.child && s.pendingDialog && s.lastDialog && s.attachedTo !== socket) {
        ctx.hub.send(socket, { type: "ui_request", session: s.id, request: s.lastDialog });
      }
    }
  }
  res(true, undefined, { observing: on });
}

/** Deliver the user's answer to a dialog the child asked for. */
export function handleUiResponse(
  ctx: DaemonContext,
  cmd: Cmd<"ui_response">,
  res: Responder,
): void {
  const s = ctx.registry.live(cmd.session);
  const response = cmd.response ?? {};
  if (typeof response.id !== "string") {
    throw new Error("ui_response without id");
  }
  // first answer wins (ticket 270): any controller may answer, and the later one finds the dialog gone; nothing reaches pi twice
  const pending = s.lastDialog?.id;
  if (pending !== response.id) {
    log(`session ${s.id} ui_response ${response.id} refused: already answered or gone (pending: ${typeof pending === "string" ? pending : "none"})`);
    throw new Error("already answered");
  }
  log(`session ${s.id} ui_response ${response.id}${cmd.source ? ` from ${cmd.source}` : ""}`);
  if (s.dialogInfo) {
    recordDecision({ ...s.dialogInfo.base, by: "user", ...(cmd.source ? { source: cmd.source } : {}), answer: answerText(response), waitMs: Date.now() - s.dialogInfo.at });
  }
  s.dialogInfo = undefined;
  s.pendingDialog = false;
  s.lastDialog = undefined;
  clearTimeout(s.denyTimer);
  s.denyTimer = undefined;
  ctx.hub.broadcast({ type: "ui_resolved", session: s.id, id: response.id, by: "user", ...(cmd.source ? { source: cmd.source } : {}) });
  ctx.hub.broadcastSessions();
  // Write raw: RpcClient.send() overwrites the record's id with its own
  // correlation id, which would break the dialog reply matching, and it
  // would also wait 30s for an ack that extension_ui_response never sends.
  const record = { type: "extension_ui_response", ...response };
  const stdin = (s.child as unknown as { process?: { stdin?: { write(s: string): void } } }).process?.stdin;
  if (!stdin) {
    throw new Error("child stdin unavailable");
  }
  stdin.write(encodeLine(record));
  res(true);
}
