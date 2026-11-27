// toriel goal (ticket 260): the session's goal is set by the user (/goal) and kept by the daemon, one per session. This
// extension gives the agent a toriel_goal tool to mark it done when it is achieved, and reminds it of the goal while it
// works so it does not forget to aim at all (lib/goal-nudge.ts, the task-nudge shape). The goal is fetched from the
// daemon (get, keyed by this session's UUID) at each session start, again at each run start (so a /goal set while the
// session already ran is seen before its first tool call), and once more before the end-of-run reminder buys a turn
// (so a stale done or clear does not). A session that has none, or one that is already done, is never reminded. Runs only
// in children the toriel daemon starts (TORIEL_CHILD).
import { ask } from "./toriel-agents.ts";
import { GoalNudges, TOOL_NAME } from "./lib/goal-nudge.ts";

interface Ctx {
  sessionManager?: { getSessionId?(): string };
}
interface ToolResultEvent {
  toolName?: string;
  content?: Array<{ type: string; text?: string }>;
}
/** What pi hands a handler at the end of a run. */
interface Boundary {
  outcome?: string;
}
/** What a settle handler proposes back: session entries plus one bought turn. */
interface Proposal {
  entries: Array<Record<string, unknown>>;
  continue: boolean;
}
interface Pi {
  on(event: "session_start" | "session_tree", handler: (event: unknown, ctx: Ctx) => void): unknown;
  on(event: "before_agent_start", handler: (event: unknown, ctx: Ctx) => Promise<void>): unknown;
  on(event: "tool_result", handler: (event: ToolResultEvent) => { content: Array<{ type: string; text?: string }> } | undefined): unknown;
  on(event: "agent_before_settle", handler: (event: Boundary, ctx: Ctx) => Promise<Proposal | undefined>): unknown;
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    promptSnippet?: string;
    parameters: unknown;
    execute(toolCallId: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: Ctx): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
  }): void;
}

/** The goal record the daemon keeps for a session; null when it has none. */
type Goal = { text: string; setAt: number; done?: boolean; doneAt?: number; doneBy?: "user" | "agent" };

const DESCRIPTION = [
  "Marks THIS session's goal (set by the user with /goal) as done, once it is actually achieved. You can read the goal in your reminders; when the work it describes is finished, mark it done so the user sees it in the switcher.",
  "Mark it done only when the goal is really met - not when you are close, not when you have decided to stop working on it, and not to stop the reminders. If you cannot finish it, say so and leave it open.",
].join(" ");

export default function (pi: Pi): void {
  if (!process.env.TORIEL_CHILD || !process.env.TORIEL_SOCK) {
    return;
  }
  const sock = process.env.TORIEL_SOCK;
  const nudges = new GoalNudges();
  const own = (ctx: Ctx | undefined): string | undefined => process.env.TORIEL_SESSION_ID ?? ctx?.sessionManager?.getSessionId?.();
  // the daemon's response data is the goal record, or null/{} when the session has none (ask() has already unwrapped it, in
  // toriel-agents.ts); a reply without its text is treated as no goal instead of trusted
  const getGoal = (sessionId: string): Promise<Goal | null> => ask(sock, { type: "goal", action: "get", sessionId }).then((r) => (typeof r.text === "string" ? (r as unknown as Goal) : null));
  // fetch the goal now and make it the nudges' state (a changed text re-arms the immediate reminder); undefined when this
  // child has no session id yet
  const refresh = async (ctx: Ctx | undefined): Promise<Goal | null | undefined> => {
    const sessionId = own(ctx);
    if (!sessionId) {
      return undefined;
    }
    const goal = await getGoal(sessionId);
    nudges.setGoal(goal);
    return goal;
  };
  // a start, resume, fork or rewind: ask the daemon what this session is working towards. A fork copies its goal, so a
  // re-fetch keeps the reminders honest; a daemon without a goal for this session means none.
  const sync = (_event: unknown, ctx: Ctx): void => {
    void refresh(ctx).catch(() => {
      // no answer from the daemon: no goal, and never let a reminder fail the session
    });
  };
  pi.on("session_start", sync);
  pi.on("session_tree", sync);
  // a user prompt begins a run: the one-more-turn allowance is back, and the goal is re-fetched before the run starts, so
  // a /goal set (or marked done) while the session already ran is known to it (pi awaits the handler)
  pi.on("before_agent_start", async (_event, ctx) => {
    nudges.runStarted();
    try {
      await refresh(ctx);
    } catch {
      // no answer from the daemon: run with whatever the goal was
    }
  });
  // every other tool's result carries the reminder when it is time; a failure here never changes a tool result
  pi.on("tool_result", (event) => {
    try {
      const reminder = nudges.afterToolCall(event?.toolName);
      return reminder === undefined ? undefined : { content: [...(event.content ?? []), { type: "text", text: `\n\n${reminder}` }] };
    } catch {
      return undefined;
    }
  });
  // the run is about to end with the goal still open: one more turn, once per run, so "done" gets recorded - confirmed
  // against the daemon first, so a goal cleared or marked done while the run worked does not buy a turn
  pi.on("agent_before_settle", async (event, ctx) => {
    try {
      const reminder = nudges.beforeRunEnds(event?.outcome === "aborted");
      if (reminder === undefined) {
        return undefined;
      }
      const goal = await refresh(ctx);
      if (!goal || goal.done) {
        return undefined;
      }
      return { entries: [{ type: "custom_message", customType: "toriel-goal-reminder", content: reminder, display: false }], continue: true };
    } catch {
      return undefined;
    }
  });
  pi.registerTool({
    name: TOOL_NAME,
    label: "Goal",
    description: DESCRIPTION,
    promptSnippet: "mark the session's goal done once it is achieved",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const sessionId = own(ctx);
      if (!sessionId) {
        return { content: [{ type: "text", text: "Goal not marked done: this session has no id yet." }], details: { error: true } };
      }
      try {
        const r = await ask(sock, { type: "goal", action: "done", by: "agent", sessionId });
        const goal = typeof r.text === "string" ? (r as unknown as Goal) : null;
        nudges.markedDone();
        return { content: [{ type: "text", text: goal ? `Goal marked done: ${goal.text}` : "There is no goal set for this session; nothing was marked." }], details: goal || { error: true } };
      } catch (err) {
        return { content: [{ type: "text", text: `Goal not marked done: ${err instanceof Error ? err.message : String(err)}` }], details: { error: true } };
      }
    },
  });
}
