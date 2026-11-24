// toriel plan mode (ticket 229, lib/plan-mode.ts): while a session is in plan mode this blocks every tool that could change something,
// tells the agent what mode it is in, and gives it the two tools that go in and out: enter_plan_mode (it asks to plan first; no
// approval needed, it only takes power away) and exit_plan_mode (it shows the user the plan and waits for the decision; only an
// approval ends the mode). The mode itself is a marker file the daemon and this extension both read and write (PLAN_DIR_ENV); each
// flip and each session start is reported to the daemon as a status record under "toriel-plan". Runs only in children the toriel
// daemon starts (TORIEL_CHILD).
import { readFileSync } from "node:fs";
import { MCP_FILE_ENV, parseMcpYaml } from "./lib/mcp-config.ts";
import { APPROVE, approvalTitle, ENTER_TOOL, EXIT_TOOL, PLAN_DIR_ENV, PLAN_OFF_NOTE, PLAN_ON_NOTE, planOn, planVerdict, REJECT, REVISE, setPlanOn, STATUS_KEY } from "./lib/plan-mode.ts";

interface Ctx {
  hasUI?: boolean;
  sessionManager?: { getSessionId?(): string | undefined };
  ui?: {
    setStatus?(key: string, text: string | undefined): void;
    select?(title: string, options: string[]): Promise<string | undefined>;
    input?(title: string, placeholder?: string): Promise<string | undefined>;
  };
}
interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
}
interface Pi {
  on(event: "session_start", handler: (event: unknown, ctx: Ctx) => void): unknown;
  on(event: "tool_call", handler: (event: { toolName?: unknown }, ctx?: Ctx) => { block: true; reason: string } | undefined): unknown;
  on(event: "before_agent_start", handler: (event: { messageType?: string }, ctx?: Ctx) => { message: { customType: string; content: string; display: boolean } } | undefined): unknown;
  registerTool(tool: { name: string; label: string; description: string; promptSnippet?: string; parameters: unknown; execute(toolCallId: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: Ctx): Promise<ToolResult> }): void;
}

/** The mcp.yaml servers marked readOnly: their tools may run in plan mode. Read at the moment of the call, so an edit to the file applies at once. */
export function readOnlyServers(file: string | undefined): Set<string> {
  if (file === undefined) {
    return new Set();
  }
  try {
    const { servers } = parseMcpYaml(readFileSync(file, "utf8"));
    return new Set(Object.entries(servers).filter(([, s]) => s.readOnly === true).map(([name]) => name));
  } catch {
    return new Set();
  }
}

const text = (t: string, details: unknown = {}): ToolResult => ({ content: [{ type: "text", text: t }], details });

export default function (pi: Pi): void {
  const dir = process.env[PLAN_DIR_ENV];
  if (!process.env.TORIEL_CHILD || !dir) {
    return;
  }
  const idOf = (ctx?: Ctx): string | undefined => process.env.TORIEL_SESSION_ID ?? ctx?.sessionManager?.getSessionId?.();
  const on = (ctx?: Ctx): boolean => planOn(dir, idOf(ctx));
  const report = (ctx: Ctx | undefined, value: boolean): void => {
    try {
      ctx?.ui?.setStatus?.(STATUS_KEY, JSON.stringify({ v: 1, on: value }));
    } catch {
      // the status line is a convenience
    }
  };
  /** True once the agent has been told the mode ended, so it is told once. */
  let told: boolean | undefined;

  pi.on("session_start", (_event, ctx) => {
    const value = on(ctx);
    told = value;
    report(ctx, value);
  });

  pi.on("tool_call", (event, ctx) => {
    if (!on(ctx)) {
      return undefined;
    }
    const reason = planVerdict(typeof event?.toolName === "string" ? event.toolName : "", readOnlyServers(process.env[MCP_FILE_ENV]));
    return reason === undefined ? undefined : { block: true, reason };
  });

  // the agent hears which mode it is in with each user prompt (the last note stays in the conversation, so a background notice does not repeat it)
  pi.on("before_agent_start", (event, ctx) => {
    if (event?.messageType !== "user") {
      return undefined;
    }
    const value = on(ctx);
    const before = told;
    told = value;
    if (value) {
      return { message: { customType: "toriel-plan-mode", content: PLAN_ON_NOTE, display: false } };
    }
    return before === true ? { message: { customType: "toriel-plan-mode", content: PLAN_OFF_NOTE, display: false } } : undefined;
  });

  pi.registerTool({
    name: ENTER_TOOL,
    label: "Plan mode",
    description: "Switch to plan mode: you can only look (read, search, read-only commands), not change anything, until the user approves a plan you propose with exit_plan_mode. Use it before a change that is large, risky or unclear, so the user can agree on the approach first.",
    promptSnippet: `${ENTER_TOOL}: look and plan first, change nothing until the user approves`,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      if (on(ctx)) {
        return text("Plan mode is already on.");
      }
      try {
        setPlanOn(dir, idOf(ctx), true);
      } catch (err) {
        return text(`Plan mode could not be switched on: ${err instanceof Error ? err.message : String(err)}.`);
      }
      told = true;
      report(ctx, true);
      return text(PLAN_ON_NOTE);
    },
  });

  pi.registerTool({
    name: EXIT_TOOL,
    label: "Plan",
    description: `Present your plan to the user and ask to leave plan mode. Pass the complete plan: the steps in order, the files and commands involved, and how you will check the result. The user approves it (plan mode ends and you carry it out), asks for changes (revise and call this again) or rejects it. Use it only in plan mode.`,
    promptSnippet: `${EXIT_TOOL}: show the user the plan and ask to start`,
    parameters: {
      type: "object",
      properties: { plan: { type: "string", description: "The whole plan, in markdown." } },
      required: ["plan"],
      additionalProperties: false,
    },
    async execute(_id, params, _signal, onUpdate, ctx) {
      const plan = typeof (params as { plan?: unknown } | undefined)?.plan === "string" ? ((params as { plan: string }).plan).trim() : "";
      if (!on(ctx)) {
        return text("Plan mode is not on, so there is nothing to approve. Go ahead.");
      }
      if (plan === "") {
        return text("The plan was empty. Call exit_plan_mode again with the whole plan.");
      }
      if (!ctx.hasUI || !ctx.ui?.select) {
        return text("There is no user to approve a plan here, so plan mode stays on.");
      }
      // The popup only has room for the start of a long plan (ticket 254); the whole of it goes into the tool's output, which scrolls with the transcript.
      if (typeof onUpdate === "function") {
        try {
          (onUpdate as (r: ToolResult) => void)(text(`The plan, for the user to decide on:\n\n${plan}`));
        } catch {
          // showing it twice is a convenience; the popup still asks
        }
      }
      const answer = await ctx.ui.select(approvalTitle(plan), [APPROVE, REVISE, REJECT]);
      if (answer === APPROVE) {
        try {
          setPlanOn(dir, idOf(ctx), false);
        } catch (err) {
          return text(`The user approved the plan, but plan mode could not be switched off: ${err instanceof Error ? err.message : String(err)}. Tell the user.`, { approved: true });
        }
        told = false;
        report(ctx, false);
        return text("The user approved the plan. Plan mode is off: carry the plan out now.", { approved: true, plan });
      }
      if (answer === REVISE) {
        const feedback = (await ctx.ui.input?.("What should change in the plan?", "")) ?? "";
        return text(feedback.trim() === "" ? "The user wants the plan changed but did not say how. Plan mode stays on: ask what they would like different, or revise it yourself." : `The user wants the plan changed: ${feedback.trim()}\nPlan mode stays on. Revise the plan and call exit_plan_mode again.`, { approved: false });
      }
      return text("The user did not approve the plan (rejected, or nobody answered). Plan mode stays on; do not change anything. Ask what they would like instead.", { approved: false });
    },
  });
}
