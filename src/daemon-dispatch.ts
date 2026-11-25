// Routes one client command to its handler. The switch is exhaustive over
// ClientCommand, so a new command type is a compile error until it is handled here.
import type * as net from "node:net";
import type { DaemonContext, Responder } from "./daemon-context.ts";
import {
  handleAdopt,
  handleAttach,
  handleResync,
  handleDeactivate,
  handleDelete,
  handleDetach,
  handleExternalRegister,
  handlePrompt,
  handleRename,
  handleRestore,
  handleSpawn,
} from "./daemon-handlers-lifecycle.ts";
import {
  handleAbort,
  handleAbortBash,
  handleAutoMode,
  handleModeNotice,
  handleObserveDialogs,
  handleReadHistory,
  handlePlanMode,
  handlePublish,
  handleDenyAfter,
  handleBackground,
  handleBash,
  handleClear,
  handleClearQueue,
  handleCommands,
  handleCompact,
  handleMcpStatus,
  handleModel,
  handleCd,
  handleReload,
  handleRestoreClear,
  handleRestoreCode,
  handleRewind,
  handleThink,
  handleUiResponse,
} from "./daemon-handlers-ops.ts";
import { handleMessage } from "./daemon-handlers-messages.ts";
import { handleFeedbackSnapshot } from "./daemon-feedback.ts";
import { handleAgentSpawn, handleAgentsOp } from "./daemon-subagents.ts";
import { handlePermissionAdd, handlePermissionCheck, handlePermissionList, handlePermissionRestore, handlePermissionRevoke } from "./daemon-permissions.ts";
import { handleResolve } from "./daemon-resolve.ts";
import { handleScheduleAdd, handleScheduleList, handleScheduleOp, handleWatchAdd } from "./daemon-schedule.ts";
import { BRIDGE_NOTICE_PREFIX, type ClientCommand } from "./shared.ts";
import { oneLine } from "./util.ts";

export async function dispatch(ctx: DaemonContext, cmd: ClientCommand, socket: net.Socket, res: Responder): Promise<void> {
  switch (cmd.type) {
    case "prompt":
      return handlePrompt(ctx, cmd, socket, res);
    case "spawn":
      return handleSpawn(ctx, cmd, socket, res);
    case "adopt":
      return handleAdopt(ctx, cmd, socket, res);
    case "attach":
      return handleAttach(ctx, cmd, socket, res);
    case "resync":
      return handleResync(ctx, cmd, socket, res);
    case "detach":
      return handleDetach(ctx, cmd, socket, res);
    case "deactivate":
      return handleDeactivate(ctx, cmd, res);
    case "delete":
      return handleDelete(ctx, cmd, res);
    case "rename":
      return handleRename(ctx, cmd, res);
    case "restore":
      return handleRestore(cmd, res);
    case "external_register":
      return handleExternalRegister(ctx, cmd, res);
    case "abort":
      return handleAbort(ctx, cmd, res);
    case "bash":
      return handleBash(ctx, cmd, res);
    case "abort_bash":
      return handleAbortBash(ctx, cmd, res);
    case "background":
      return handleBackground(ctx, cmd, res);
    case "deny_after":
      return handleDenyAfter(ctx, cmd, res);
    case "auto_mode":
      return handleAutoMode(ctx, cmd, res);
    case "publish":
      return handlePublish(ctx, cmd, res);
    case "chat_status": {
      const problem = typeof cmd.problem === "string" && cmd.problem.trim() ? oneLine(cmd.problem).slice(0, 300) : undefined; // reaches the status line and a notice: one line, whatever was sent
      const changed = ctx.published.bridgeUp !== cmd.up || (cmd.up && ctx.published.problem !== problem);
      ctx.published.bridgeUp = cmd.up;
      if (cmd.up) {
        ctx.published.problem = problem;
      }
      if (cmd.up && problem && cmd.session !== undefined && changed) {
        ctx.hub.broadcast({ type: "notice", session: cmd.session, text: `${BRIDGE_NOTICE_PREFIX}${problem}`, durable: true });
      }
      if (changed) {
        ctx.hub.broadcastSessions();
      }
      res(true);
      return;
    }
    case "chat_channels":
      if (JSON.stringify(ctx.published.channels) !== JSON.stringify(cmd.channels)) {
        ctx.published.channels = cmd.channels;
        ctx.hub.broadcastSessions();
      }
      res(true);
      return;
    case "plan_mode":
      return handlePlanMode(ctx, cmd, res);
    case "mode_notice":
      return handleModeNotice(ctx, cmd, res);
    case "feedback_snapshot":
      return handleFeedbackSnapshot(ctx, cmd, res);
    case "clear_queue":
      return handleClearQueue(ctx, cmd, res);
    case "commands":
      return handleCommands(ctx, cmd, res);
    case "message":
      return handleMessage(ctx, cmd, res);
    case "agent_spawn":
      return handleAgentSpawn(ctx, cmd, socket, res);
    case "agents_op":
      return handleAgentsOp(ctx, cmd, socket, res);
    case "schedule_add":
      return handleScheduleAdd(ctx, cmd, res);
    case "watch_add":
      return handleWatchAdd(ctx, cmd, res);
    case "schedule_list":
      return handleScheduleList(ctx, cmd, res);
    case "schedule_op":
      return handleScheduleOp(ctx, cmd, res);
    case "permission_check":
      return handlePermissionCheck(ctx, cmd, res);
    case "permission_list":
      return handlePermissionList(ctx, cmd, res);
    case "permission_add":
      return handlePermissionAdd(ctx, cmd, res);
    case "permission_revoke":
      return handlePermissionRevoke(ctx, cmd, res);
    case "permission_restore":
      return handlePermissionRestore(ctx, cmd, res);
    case "resolve":
      return handleResolve(ctx, cmd, res);
    case "mcp_status":
      return handleMcpStatus(ctx, cmd, res);
    case "model":
      return handleModel(ctx, cmd, res);
    case "think":
      return handleThink(ctx, cmd, res);
    case "compact":
      return handleCompact(ctx, cmd, socket, res);
    case "reload":
      return handleReload(ctx, cmd, socket, res);
    case "cd":
      return handleCd(ctx, cmd, socket, res);
    case "clear":
      return handleClear(ctx, cmd, socket, res);
    case "restore_clear":
      return handleRestoreClear(ctx, cmd, socket, res);
    case "rewind":
      return handleRewind(ctx, cmd, res);
    case "restore_code":
      return handleRestoreCode(ctx, cmd, res);
    case "observe_dialogs":
      return handleObserveDialogs(ctx, cmd, socket, res);
    case "read_history":
      return handleReadHistory(ctx, cmd, res);
    case "ui_response":
      return handleUiResponse(ctx, cmd, res);
    case "list":
      ctx.hub.sendSessions(socket);
      res(true);
      return;
    case "shutdown":
      res(true);
      ctx.shutdown();
      return;
    default:
      return refuseUnknown(cmd, res);
  }
}

/** The switch above is exhaustive, so this only runs for a controller newer than the daemon: answer instead of leaving it to time out. */
function refuseUnknown(cmd: never, res: Responder): void {
  const type = (cmd as { type?: unknown }).type;
  res(false, `the daemon does not know the request "${String(type)}" (it is older than this controller: restart it)`);
}
