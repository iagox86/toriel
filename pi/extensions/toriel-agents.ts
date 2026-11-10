// toriel agents: tools that let a session in toriel talk to its siblings and
// schedule its own future prompts: `toriel_message` (delivers text to another
// session by id or name) and `toriel_schedule_create/list/cancel` (docs/design.md item 10). The daemon does the work (resolving, waking an idle session, labelling
// the message); this file is the thin client that asks it. Runs only in
// children the toriel daemon starts (TORIEL_CHILD).
import { connect } from "node:net";

interface Ctx {
  sessionManager?: { getSessionId?(): string };
}
interface Pi {
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    promptSnippet?: string;
    parameters: unknown;
    execute(toolCallId: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: Ctx): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
  }): void;
}

// the daemon puts its own socket path in every child's environment
const sockPath = process.env.TORIEL_SOCK;
const TIMEOUT_MS = 30_000;

/**
 * One request/response exchange with the daemon; rejects with the daemon's error text.
 * `timeoutMs` 0 waits as long as it takes (a subagent call); `signal` aborting closes the
 * connection, which is how the daemon learns the caller gave up.
 */
export function ask(sock: string, cmd: Record<string, unknown>, timeoutMs = TIMEOUT_MS, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const id = `agents-${process.pid}-${Date.now()}`;
    const s = connect(sock);
    let buf = "";
    const done = (fn: () => void) => {
      clearTimeout(timer);
      s.destroy();
      fn();
    };
    const timer = timeoutMs > 0 ? setTimeout(() => done(() => reject(new Error("the toriel daemon did not answer in time"))), timeoutMs) : undefined;
    if (signal?.aborted) {
      done(() => reject(new Error("cancelled")));
      return;
    }
    signal?.addEventListener("abort", () => done(() => reject(new Error("cancelled"))), { once: true });
    s.on("connect", () => s.write(`${JSON.stringify({ ...cmd, id })}\n`));
    s.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      for (const line of buf.split("\n")) {
        try {
          const msg = JSON.parse(line) as { type?: string; id?: string; ok?: boolean; error?: string; data?: Record<string, unknown> };
          if (msg.type === "response" && msg.id === id) {
            done(() => (msg.ok ? resolve(msg.data ?? {}) : reject(new Error(msg.error ?? "the daemon refused"))));
            return;
          }
        } catch {
          // a partial line; wait for more
        }
      }
    });
    s.on("error", () => done(() => reject(new Error("cannot reach the toriel daemon"))));
  });
}

export const MESSAGE_DESCRIPTION =
  "Send a message to another toriel session, by its session id (preferred, a UUID) or its name. The text arrives in that session as a user message labelled with your name and id, and an idle session is started to read it. It returns once delivered, not when the other session answers; if you expect a reply it arrives later as a message to you. Use this ONLY when the user asks you to tell or ask another session something - never on your own initiative.";

export const SCHEDULE_CREATE_DESCRIPTION =
  'Schedule a prompt to be sent back to THIS session later, for "check again in an hour", "wait until X, then continue", or recurring work. `when` is one string: "in 30m" (any delay, even "in 10s"), "at 14:30" / "tomorrow 9am", "every 2h", "every weekday 9am", or a 5-field cron like "*/15 * * * *" (repeats can be no shorter than 1 minute; one-shot delays have no minimum). The prompt arrives as a user message labelled "[scheduled #N ...]" when this session is idle (it never interrupts a turn); a stopped session is started. Recurring schedules end after 7 days unless `expires` says otherwise. Returns the schedule id and the real next run time - read it back to check it is what you meant. Make the prompt self-contained: say what to check and what to do about the result. Prefer long delays over short ones and never poll in a tight loop. A one-shot removes itself after it runs; a repeating schedule keeps running until it expires, hits `max`, or is cancelled - cancel one only when you made it for your own follow-up and what it watched for has happened, never one the user asked for. Tell the user what you scheduled.';

export const SCHEDULE_CANCEL_DESCRIPTION = "Cancel one of this session's repeating schedules by id (3 or #3) or name. One-shots remove themselves after they run, so do not cancel them. Only cancel a schedule you made for your own follow-up once it has served its purpose; never cancel one the user asked for unless they ask you to.";

/** The toriel_agent description with the live agent types (the daemon passes them in TORIEL_AGENT_TYPES, so this never goes stale). */
export function agentDescription(types: string | undefined): string {
  return `Delegate a self-contained task to a subagent: a separate session that runs the named agent type and returns its final message. Foreground (the default) waits for the result; several toriel_agent calls in one turn run in parallel. With background: true it returns a handle at once and the result arrives later as a message; toriel_agents can list, wait for, stop or fetch it. The subagent sees nothing of this conversation unless context is "fork", so write the task as a complete brief: the goal, the paths and facts it needs, what to return and how long, and whether it may edit anything. Its answer is only as good as the brief. Limits apply (depth, how many at once and in total, a token budget per subagent); a refusal comes back as text, so then do the work yourself. Pass cwd when the task lives in a worktree or another directory: the subagent is scoped to its own cwd, so its writes inside it are silent and outside it are denied.\n\nAgent types:\n${types?.trim() || "(none defined)"}`;
}

export const AGENTS_DESCRIPTION =
  'Manage the subagents this session started with toriel_agent. action "list" shows them with state, turns and time; "status" and "result" take an id like #2; "wait" blocks until the id (or, with no id, all running ones) ends or timeoutSeconds passes; "stop" aborts one and returns what it had so far.';

type Reply = { content: Array<{ type: "text"; text: string }>; details: unknown };
const text = (t: string, details: unknown): Reply => ({ content: [{ type: "text", text: t }], details });
const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export default function (pi: Pi) {
  if (!process.env.TORIEL_CHILD || !sockPath) {
    return;
  }
  const sock = sockPath;
  pi.registerTool({
    name: "toriel_message",
    label: "Message",
    description: MESSAGE_DESCRIPTION,
    promptSnippet: "toriel_message: send a message to another toriel session (only when the user asks)",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "Session id (UUID or its first 8+ characters) or the session's exact name" },
        text: { type: "string", description: "What to tell it. Self-contained: the other session sees nothing else of this conversation." },
      },
      required: ["to", "text"],
      additionalProperties: false,
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const { to, text } = params as { to: string; text: string };
      const from = process.env.TORIEL_SESSION_ID ?? ctx.sessionManager?.getSessionId?.();
      try {
        const r = await ask(sock, { type: "message", to, text, from });
        const who = `${r.to ?? "the session"}${r.toId ? ` (${r.toId})` : ""}`;
        return { content: [{ type: "text", text: `Delivered to ${who}: ${r.disposition}.` }], details: r };
      } catch (err) {
        return { content: [{ type: "text", text: `Not delivered: ${err instanceof Error ? err.message : err}` }], details: { error: true } };
      }
    },
  });
  const own = (ctx: Ctx): string | undefined => process.env.TORIEL_SESSION_ID ?? ctx.sessionManager?.getSessionId?.();
  const lineOf = (s: Record<string, unknown>): string =>
    `#${s.id}${s.name ? ` ${s.name}` : ""}: ${s.when}; ${s.state === "paused" ? "paused" : s.next ? `next ${new Date(s.next as number).toLocaleString()}` : "waiting for a run to finish"}; ${s.fired} run(s)${s.max ? ` of ${s.max}` : ""}; prompt: ${String(s.prompt).slice(0, 120)}`;

  pi.registerTool({
    name: "toriel_schedule_create",
    label: "Schedule",
    description: SCHEDULE_CREATE_DESCRIPTION,
    promptSnippet: "toriel_schedule_create: send a prompt to this session later or on a repeat (in 30m, every 2h, a cron)",
    parameters: {
      type: "object",
      properties: {
        when: { type: "string", description: 'When: "in 30m" or "in 10s" (one-shot delays have no minimum), "at 14:30", "tomorrow 9am", "every 2h" (repeats: 1 minute at the shortest), "every weekday 9am", or a 5-field cron' },
        prompt: { type: "string", description: "What to send this session then. Self-contained." },
        name: { type: "string", description: "Optional short name to cancel it by" },
        max: { type: "integer", minimum: 1, description: "Stop after this many runs (recurring only)" },
        expires: { type: "string", description: 'End after this long, e.g. "3d" or "12h", or "never" (default for recurring: 7d)' },
      },
      required: ["when", "prompt"],
      additionalProperties: false,
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const p = params as { when: string; prompt: string; name?: string; max?: number; expires?: string };
      const uuid = own(ctx);
      if (!uuid) {
        return text("Not scheduled: this session has no id yet.", { error: true });
      }
      try {
        const r = await ask(sock, { type: "schedule_add", uuid, mode: "auto", when: p.when.trim().split(/\s+/), prompt: p.prompt, name: p.name, max: p.max, expires: p.expires, by: "agent" });
        const notes = Array.isArray(r.notes) && r.notes.length > 0 ? ` (${r.notes.join("; ")})` : "";
        return text(`Scheduled ${r.echo}${notes}`, r);
      } catch (err) {
        return text(`Not scheduled: ${reason(err)}`, { error: true });
      }
    },
  });

  pi.registerTool({
    name: "toriel_schedule_list",
    label: "Schedules",
    description: "List this session's schedules: id, name, when, next run, runs so far and prompt.",
    promptSnippet: "toriel_schedule_list: list this session's scheduled prompts",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const uuid = own(ctx);
      try {
        const r = await ask(sock, { type: "schedule_list", uuid });
        const list = (r.schedules as Array<Record<string, unknown>>) ?? [];
        return text(list.length === 0 ? "No schedules in this session." : list.map(lineOf).join("\n"), r);
      } catch (err) {
        return text(`Could not list schedules: ${reason(err)}`, { error: true });
      }
    },
  });

  pi.registerTool({
    name: "toriel_schedule_cancel",
    label: "Cancel schedule",
    description: SCHEDULE_CANCEL_DESCRIPTION,
    promptSnippet: "toriel_schedule_cancel: cancel one of this session's schedules by id or name",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: 'Schedule id ("3" or "#3") or its name; "all" cancels every schedule of this session' },
      },
      required: ["id"],
      additionalProperties: false,
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const { id } = params as { id: string };
      try {
        const r = await ask(sock, { type: "schedule_op", op: "cancel", uuid: own(ctx), ...(id.trim().toLowerCase() === "all" ? { all: true } : { ref: id }) });
        const list = (r.schedules as Array<Record<string, unknown>>) ?? [];
        return text(list.length === 0 ? "Nothing to cancel." : `Cancelled ${list.map((s) => `#${s.id}${s.name ? ` ${s.name}` : ""}`).join(", ")}.`, r);
      } catch (err) {
        return text(`Not cancelled: ${reason(err)}`, { error: true });
      }
    },
  });

  if (process.env.TORIEL_CAN_SPAWN === "1") {
    pi.registerTool({
      name: "toriel_agent",
      label: "Subagent",
      description: agentDescription(process.env.TORIEL_AGENT_TYPES),
      promptSnippet: "toriel_agent: delegate a self-contained task to a subagent and get its final message back",
      parameters: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Agent type, one of the listed names" },
          task: { type: "string", description: "The complete brief. The subagent has no other context (unless context is fork)." },
          description: { type: "string", description: "Three to six words naming the job, shown in the session list" },
          model: { type: "string", description: "Optional provider/id replacing the agent type's model (not with context fork)" },
          background: { type: "boolean", description: "Return a handle at once; the result arrives later as a message" },
          context: { type: "string", enum: ["fresh", "fork"], description: "fresh (default) starts empty; fork starts from a copy of this conversation" },
          system: { type: "string", description: "Extra instructions appended to the agent type's system prompt" },
          cwd: { type: "string", description: "Optional absolute path; the subagent runs there instead of the parent's cwd" },
        },
        required: ["agent", "task", "description"],
        additionalProperties: false,
      },
      async execute(_id, params, signal, _onUpdate, ctx) {
        const p = params as { agent: string; task: string; description: string; model?: string; background?: boolean; context?: string; system?: string; cwd?: string };
        try {
          const r = await ask(sock, { type: "agent_spawn", from: own(ctx), ...p }, 0, signal as AbortSignal | undefined);
          return text(String(r.text ?? ""), r);
        } catch (err) {
          return text(`Subagent not started: ${reason(err)}`, { error: true });
        }
      },
    });

    pi.registerTool({
      name: "toriel_agents",
      label: "Subagents",
      description: AGENTS_DESCRIPTION,
      promptSnippet: "toriel_agents: list, wait for, stop or fetch the result of this session's subagents",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "status", "wait", "stop", "result"] },
          id: { type: "string", description: 'Subagent id such as "#2" (required for status, stop and result)' },
          timeoutSeconds: { type: "integer", minimum: 1, description: "wait only: give up after this long (default 300)" },
        },
        required: ["action"],
        additionalProperties: false,
      },
      async execute(_id, params, signal, _onUpdate, ctx) {
        const p = params as { action: string; id?: string; timeoutSeconds?: number };
        try {
          const r = await ask(sock, { type: "agents_op", from: own(ctx), action: p.action, ref: p.id, timeoutMs: p.timeoutSeconds ? p.timeoutSeconds * 1000 : undefined }, 0, signal as AbortSignal | undefined);
          return text(String(r.text ?? ""), r);
        } catch (err) {
          return text(`Not done: ${reason(err)}`, { error: true });
        }
      },
    });
  }
}
