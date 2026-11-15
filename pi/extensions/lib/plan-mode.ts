// Plan mode (ticket 229): a session mode in which the agent can only look. It explores, writes a plan, and calls exit_plan_mode; the
// user approves, asks for changes or rejects, and only an approval ends the mode.
//
// Where the state lives: one marker file per session under TORIEL_PLAN_DIR (a directory the daemon owns, named by the session's
// UUID). The daemon writes it for /plan, the toriel-plan extension writes it for the agent's own enter_plan_mode and the user's
// approval; whoever asks reads the file, so a flip is seen by the next tool call without a message between the two processes, and
// the mode survives a restart of the child or of the daemon. The extension also reports each flip to the daemon as a status record
// so the status line can say so.
//
// What it enforces (a guardrail for an agent that follows instructions, not a boundary against one that does not: the permission
// system, the scope root and the sandbox are the boundaries):
//   - a tool that is not on the list of read-only ones is blocked with a reason the model reads (planVerdict);
//   - bash runs in bubblewrap with the whole filesystem read-only (planWrap), so no list of "safe" commands has to be guessed; when
//     bubblewrap is not there the command is not run;
//   - an MCP tool is allowed only when its server is marked `readOnly: true` in mcp.yaml.
import * as fs from "node:fs";
import * as path from "node:path";
import { bwrapArgs, MASKED_DIRS, type Spawnable } from "./sandbox.ts";

/** The directory of the per-session marker files; set by the daemon. */
export const PLAN_DIR_ENV = "TORIEL_PLAN_DIR";
/** The status record the extension sends the daemon when the mode flips or a session starts: `{v: 1, on}`. */
export const STATUS_KEY = "toriel-plan";
export const ENTER_TOOL = "enter_plan_mode";
export const EXIT_TOOL = "exit_plan_mode";

const ID = /^[A-Za-z0-9._-]+$/;

/** The marker file of a session, or undefined when there is no directory or the id is not a plain name. */
export function planFile(dir: string | undefined, sessionId: string | undefined): string | undefined {
  return dir && sessionId && ID.test(sessionId) ? path.join(dir, sessionId) : undefined;
}

/** Whether the session is in plan mode now. Never throws; no marker means off. */
export function planOn(dir: string | undefined, sessionId: string | undefined): boolean {
  const file = planFile(dir, sessionId);
  return file !== undefined && fs.existsSync(file);
}

/** Switch the mode on or off for a session. Throws when it cannot (the caller says so; a mode that did not take must not look as if it had). */
export function setPlanOn(dir: string | undefined, sessionId: string | undefined, on: boolean): void {
  const file = planFile(dir, sessionId);
  if (file === undefined || dir === undefined) {
    throw new Error("plan mode has nowhere to keep its state for this session");
  }
  if (on) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, "1\n", { mode: 0o600 });
  } else {
    fs.rmSync(file, { force: true });
  }
}

/** Tools that cannot change anything, or only things the session owns (its own jobs, its own task list), plus the ones that leave planning. */
export const PLAN_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "bash", // runs read-only (planWrap)
  "codemode", // its inner calls come through the same gate one by one
  "tool_search",
  "web_search",
  "fetch_content",
  "get_search_content",
  "code_search",
  "toriel_usage",
  "toriel_job",
  "toriel_schedule_list",
  "toriel_agents",
  "toriel_permission_check",
  "todo_write",
  "ask_user_question",
  ENTER_TOOL,
  EXIT_TOOL,
]);

/** The server of an MCP tool name (`mcp__<server>__<tool>`), or undefined when it is not one. */
export function mcpServerOf(toolName: string): string | undefined {
  const m = /^mcp__(.+?)__./.exec(toolName);
  return m?.[1];
}

/** Why a tool call is refused in plan mode, in words for the model; undefined when it may go ahead. */
export function planVerdict(toolName: string, readOnlyServers: ReadonlySet<string> = new Set()): string | undefined {
  if (PLAN_TOOLS.has(toolName)) {
    return undefined;
  }
  const server = mcpServerOf(toolName);
  if (server !== undefined && readOnlyServers.has(server)) {
    return undefined;
  }
  const what = toolName === "write" || toolName === "edit" ? `the ${toolName} tool changes files` : server !== undefined ? `the "${server}" MCP server is not marked readOnly in mcp.yaml, so its tools may change things` : `${toolName} may change something`;
  return `Plan mode is on, so ${toolName} is not available (${what}). Explore with read, grep, find, ls and read-only commands, then call ${EXIT_TOOL} with your plan; nothing is changed until the user approves it.`;
}

/** Why plan mode cannot run a command when bubblewrap is missing. */
export const NO_BWRAP = "plan mode runs commands read-only through bubblewrap, which could not be started, so the command was not run. Use read, grep, find and ls, or ask the user to install bubblewrap or leave plan mode";

/**
 * What to spawn for a command in plan mode: the whole filesystem read-only, a private /dev, /proc and /tmp, the socket directories
 * emptied and the daemon's socket hidden (as the sandbox does), nothing writable at all. Network is left alone: planning may read the web.
 */
export function planWrap(command: string, cwd: string, sock?: string, isDir: (p: string) => boolean = defaultIsDir, exists: (p: string) => boolean = fs.existsSync): Spawnable {
  const masked = MASKED_DIRS.filter((d) => isDir(d));
  const hidden = sock !== undefined && path.isAbsolute(sock) && exists(sock) && !masked.some((d) => sock === d || sock.startsWith(`${d}/`)) ? [sock] : [];
  return { file: "bwrap", args: [...bwrapArgs({ writable: [], readOnly: [], masked, hidden }, cwd), "bash", "-c", command], failure: NO_BWRAP };
}

function defaultIsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** What the agent is told on its next turn while the mode is on, and once when it has just ended. */
export const PLAN_ON_NOTE = [
  "[PLAN MODE ACTIVE]",
  "You are in plan mode: you can look but not change anything. Files cannot be written or edited, commands run read-only, and tools that could change something are refused.",
  "Explore what you need, ask the user a question when something is unclear and you have the tool for it, then call exit_plan_mode with the complete plan (the steps, the files involved, how you will check the result).",
  "The user approves it, asks for changes or rejects it. Only an approval ends plan mode; until then, keep planning.",
].join("\n");

export const PLAN_OFF_NOTE = "[PLAN MODE ENDED]\nPlan mode is off: you may change files and run commands again. If a plan was approved, carry it out.";

/** The text exit_plan_mode asks the user to decide on: the plan, capped so a runaway one does not fill the screen. */
export function approvalTitle(plan: string, cap = 4000): string {
  const text = plan.trim();
  return `Plan mode: approve this plan?\n\n${text.length > cap ? `${text.slice(0, cap)}\n... (the plan is ${text.length} characters; the rest is in the tool call)` : text}`;
}

export const APPROVE = "Approve the plan and start";
export const REVISE = "Keep planning (tell the agent what to change)";
export const REJECT = "Reject the plan";
