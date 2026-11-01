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

/** One request/response exchange with the daemon; rejects with the daemon's error text. */
export function ask(sock: string, cmd: Record<string, unknown>, timeoutMs = TIMEOUT_MS): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const id = `agents-${process.pid}-${Date.now()}`;
    const s = connect(sock);
    let buf = "";
    const done = (fn: () => void) => {
      clearTimeout(timer);
      s.destroy();
      fn();
    };
    const timer = setTimeout(() => done(() => reject(new Error("the toriel daemon did not answer in time"))), timeoutMs);
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
}
