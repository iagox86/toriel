// toriel tasks (ticket 228): a task list the agent keeps while it works, and toriel shows above the editor. The agent sends the whole
// list each time (todo_write), so the list is the last call; it lives in that call's tool result, so fork, rewind and resume all see
// the list as of their point in the conversation (lib/tasks.ts). Each change, and each session start, is reported to toriel as a
// setStatus record under "toriel-tasks". A model that stops updating the list is reminded (lib/task-nudge.ts, ticket 250): after a
// run of tool calls the next tool result carries a reminder, and a run about to end with the list out of date gets one more turn.
// Runs only in children the toriel daemon starts (TORIEL_CHILD).
import { TaskNudges } from "./lib/task-nudge.ts";
import { counts, describeTodos, MAX_TODOS, parseTodos, reconstructTodos, STATUS_KEY, type TasksReport, TOOL_NAME, type Todo } from "./lib/tasks.ts";

interface Ctx {
  sessionManager?: { getBranch(): Array<{ type?: string; message?: { role?: string; toolName?: string; details?: unknown } }> };
  ui?: { setStatus?(key: string, text: string | undefined): void };
}
interface ToolResultEvent {
  toolName?: string;
  content?: Array<{ type: string; text?: string }>;
}
/** What pi hands a handler at the end of a run. */
interface Boundary {
  outcome?: string;
}
interface Pi {
  on(event: "session_start" | "session_tree", handler: (event: unknown, ctx: Ctx) => void): unknown;
  on(event: "agent_start", handler: () => void): unknown;
  on(event: "tool_result", handler: (event: ToolResultEvent) => { content: Array<{ type: string; text?: string }> } | undefined): unknown;
  on(event: "agent_before_settle", handler: (event: Boundary) => { entries: Array<Record<string, unknown>>; continue: boolean } | undefined): unknown;
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    promptSnippet?: string;
    parameters: unknown;
    execute(toolCallId: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: Ctx): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
  }): void;
}

const DESCRIPTION = [
  "Keeps your task list for the work in hand, and shows it to the user as you go. Send the WHOLE list every time (it replaces the last one); an empty list clears it.",
  "Use it for work with three or more steps, or when the user gave several things to do; do not use it for a single simple step or for chat.",
  "Each task has content (what is to be done, imperative: \"Run the tests\"), a status (pending, in_progress, completed) and optionally activeForm (how it reads while it is under way: \"Running the tests\").",
  "Keep exactly one task in_progress while you work, mark it completed as soon as it is done (not in a batch at the end), and add the tasks you discover along the way.",
  "Only mark a task completed when it is really done: if a test fails or the work is partial, leave it in_progress.",
].join(" ");

export default function (pi: Pi): void {
  if (!process.env.TORIEL_CHILD) {
    return;
  }
  const nudges = new TaskNudges();
  const report = (ctx: Ctx | undefined, todos: readonly Todo[]): void => {
    nudges.setList(todos);
    try {
      const record: TasksReport = { v: 1, todos: [...todos] };
      ctx?.ui?.setStatus?.(STATUS_KEY, JSON.stringify(record));
    } catch {
      // showing the list is a convenience: it must never fail the tool or the session
    }
  };
  // a start, resume, fork or rewind: the list is whatever the branch last said (toriel forgets a list it is not told about)
  const sync = (_event: unknown, ctx: Ctx): void => {
    try {
      report(ctx, reconstructTodos(ctx.sessionManager?.getBranch() ?? []));
    } catch {
      report(ctx, []);
    }
  };
  pi.on("session_start", sync);
  pi.on("session_tree", sync);
  pi.on("agent_start", () => nudges.runStarted());
  // every other tool's result carries the reminder when it is time; a failure here never changes a tool result
  pi.on("tool_result", (event) => {
    try {
      const reminder = nudges.afterToolCall(event?.toolName);
      return reminder === undefined ? undefined : { content: [...(event.content ?? []), { type: "text", text: `\n\n${reminder}` }] };
    } catch {
      return undefined;
    }
  });
  // the run is about to end with the list out of date: one more turn, once per run, so "all done" gets recorded
  pi.on("agent_before_settle", (event) => {
    try {
      const reminder = nudges.beforeRunEnds(event?.outcome === "aborted");
      return reminder === undefined ? undefined : { entries: [{ type: "custom_message", customType: "toriel-task-reminder", content: reminder, display: false }], continue: true };
    } catch {
      return undefined;
    }
  });
  pi.registerTool({
    name: TOOL_NAME,
    label: "Tasks",
    description: DESCRIPTION,
    promptSnippet: `${TOOL_NAME}: keep a visible task list for multi-step work`,
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          maxItems: MAX_TODOS,
          description: "The whole task list, in order.",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "What is to be done, imperative: \"Run the tests\"." },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              activeForm: { type: "string", description: "How the task reads while it is under way: \"Running the tests\"." },
            },
            required: ["content", "status"],
            additionalProperties: false,
          },
        },
      },
      required: ["todos"],
      additionalProperties: false,
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const parsed = parseTodos((params as { todos?: unknown } | undefined)?.todos);
      if (!parsed.ok) {
        return { content: [{ type: "text", text: `The task list was not changed: ${parsed.error}.` }], details: { error: parsed.error } };
      }
      report(ctx, parsed.todos);
      return { content: [{ type: "text", text: describeTodos(parsed.todos) }], details: { todos: parsed.todos, ...counts(parsed.todos) } };
    },
  });
}
