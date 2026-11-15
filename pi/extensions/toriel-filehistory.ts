// toriel file history (ticket 11): records what the write and edit tools change, so rewinding a session can offer to put the files back
// as well (see lib/file-history.ts for the format and what it does not see). Before a write/edit call runs it keeps the file's content;
// after the call it notes what the file holds. It only observes: it never blocks a call, never throws, and does nothing when the
// daemon did not give it a directory (TORIEL_FILE_HISTORY) or it runs outside a toriel child.
import * as path from "node:path";
import { FILE_HISTORY_ENV, recordAfter, recordBefore } from "./lib/file-history.ts";
import { resolveTarget } from "./lib/scope-root.ts";

interface Ctx {
  cwd?: string;
  sessionManager?: { getSessionId?(): string | undefined };
}
interface ToolEvent {
  toolName?: unknown;
  toolCallId?: unknown;
  input?: unknown;
}
interface Pi {
  on(event: "tool_call" | "tool_result", handler: (event: ToolEvent, ctx?: Ctx) => undefined): void;
}

const TOOLS = new Set(["write", "edit"]);

/** The directory of this session's journal, or undefined when there is nowhere to put it. */
export function sessionDir(root: string | undefined, sessionId: string | undefined): string | undefined {
  return root && sessionId && /^[A-Za-z0-9._-]+$/.test(sessionId) ? path.join(root, sessionId) : undefined;
}

/** The absolute path a write/edit call targets, or undefined when the call is not one or names none. */
export function targetOf(event: ToolEvent, cwd: string): string | undefined {
  const raw = (event.input as { path?: unknown } | undefined)?.path;
  if (typeof event.toolName !== "string" || !TOOLS.has(event.toolName) || typeof raw !== "string" || raw === "") {
    return undefined;
  }
  try {
    return resolveTarget(raw.replace(/^@/, ""), cwd);
  } catch {
    return undefined;
  }
}

export default function (pi: Pi): void {
  const root = process.env[FILE_HISTORY_ENV];
  if (!process.env.TORIEL_CHILD || !root) {
    return;
  }
  const handle = (before: boolean) => (event: ToolEvent, ctx?: Ctx): undefined => {
    try {
      const dir = sessionDir(root, process.env.TORIEL_SESSION_ID ?? ctx?.sessionManager?.getSessionId?.());
      const file = dir === undefined ? undefined : targetOf(event, ctx?.cwd ?? process.cwd());
      const call = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
      if (dir !== undefined && file !== undefined && call !== undefined) {
        if (before) {
          recordBefore(dir, call, event.toolName as string, file);
        } else {
          recordAfter(dir, call, file);
        }
      }
    } catch {
      // observing must never disturb a tool call
    }
    return undefined;
  };
  pi.on("tool_call", handle(true));
  pi.on("tool_result", handle(false));
}

