// Commands that act on a live session's child: model, compaction, reload,
// clear, rewind, dialog answers.
import * as fs from "node:fs";
import type * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { compactAndWait } from "./compact-wait.ts";
import { bangEnv } from "./child-env.ts";
import { SOCK, TRASH_DIR } from "./config.ts";
import { type Cmd, type DaemonContext, requireNotInPi, type Responder } from "./daemon-context.ts";
import { deliverToSession } from "./daemon-handlers-bridge.ts";
import { sendHistory } from "./daemon-history.ts";
import { type DaemonSession, type HeldPrompt, requireIdle } from "./daemon-session.ts";
import { formatLocalCommand, type LocalResult, runLocal } from "./local-command.ts";
import { log } from "./log.ts";
import { matchModel, modelName } from "./model-match.ts";
import { matchThinkingLevel } from "./think-match.ts";
import { clearFile, latestClearBackup, restoreClear, rewindFile } from "./rewind.ts";
import { setSessionFileCwd } from "./session-header.ts";
import { encodeLine } from "./shared.ts";

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
  const child = ctx.registry.live(cmd.session).child;
  const commands = await child.getCommands();
  if (!commands.some((c) => c.name === BACKGROUND_COMMAND)) {
    throw new Error("this session's pi does not have the background-jobs extension; restart the session");
  }
  await child.prompt(`/${BACKGROUND_COMMAND}`);
  res(true);
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
  if (!s.sessionFile) {
    throw new Error("nothing to reload yet (no session file)");
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
  // pi restores a session's model and thinking level only when the file has
  // messages, so an emptied one would start on the defaults: carry them over.
  const before = await s.child!.getState();
  const attached = s.attachedTo;
  await ctx.children.deactivate(s);
  const result = clearFile(file, TRASH_DIR);
  log(`cleared ${file}: ${result.removed} entries -> ${result.trashedTo}`);
  s.attachedTo = attached;
  await ctx.children.start(s, { sessionFile: file });
  if (before.model) {
    await s.child!.setModel(before.model.provider, before.model.id);
  }
  await s.child!.setThinkingLevel(before.thinkingLevel);
  await ctx.children.refreshMeta(s);
  ctx.hub.broadcastSessions();
  await sendHistory(ctx, socket, s);
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
  const wasLive = Boolean(s?.child);
  const attached = s?.attachedTo;
  const before = wasLive ? await s!.child!.getState() : undefined;
  if (s?.child) {
    await ctx.children.deactivate(s);
  }
  restoreClear(file, backup);
  log(`restored ${file} from ${backup.trashedTo}`);
  if (s && wasLive) {
    s.attachedTo = attached;
    await ctx.children.start(s, { sessionFile: file });
    // the restored file has messages again, so pi resumes its own model; keep the one in use now
    if (before?.model) {
      await s.child!.setModel(before.model.provider, before.model.id);
      await s.child!.setThinkingLevel(before.thinkingLevel);
      await ctx.children.refreshMeta(s);
    }
    await sendHistory(ctx, socket, s);
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
  ctx.hub.broadcastSessions();
  res(true, undefined, { text: result.text, removed: result.removed, trashedTo: result.trashedTo });
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
  s.pendingDialog = false;
  s.lastDialog = undefined;
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
