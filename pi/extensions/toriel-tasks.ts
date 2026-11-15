// toriel tasks (ticket 228): a task list the agent keeps while it works, and toriel shows above the editor. The agent sends the whole
// list each time (todo_write), so the list is the last call; it lives in that call's tool result, so fork, rewind and resume all see
// the list as of their point in the conversation (lib/tasks.ts). Each change, and each session start, is reported to toriel as a
// setStatus record under "toriel-tasks". Runs only in children the toriel daemon starts (TORIEL_CHILD).
import { counts, describeTodos, MAX_TODOS, parseTodos, reconstructTodos, STATUS_KEY, type TasksReport, TOOL_NAME, type Todo } from "./lib/tasks.ts";

interface Ctx {
  sessionManager?: { getBranch(): Array<{ type?: string; message?: { role?: string; toolName?: string; details?: unknown } }> };
  ui?: { setStatus?(key: string, text: string | undefined): void };
}
interface Pi {
  on(event: "session_start" | "session_tree", handler: (event: unknown, ctx: Ctx) => void): unknown;
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
  const report = (ctx: Ctx | undefined, todos: readonly Todo[]): void => {
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
