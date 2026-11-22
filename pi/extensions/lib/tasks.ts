// The agent's task list (ticket 228): the pure parts, shared by the extension that runs inside pi (toriel-tasks.ts) and by toriel
// itself, which draws the list above the editor and counts it in the status line.
//
// The list is replaced whole on every call (what the agent sends is the list), so the state is simply the last call's list, and
// it is read back from the tool results of the session branch: fork, rewind and resume all show the list as of that point.

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface Todo {
  content: string;
  status: TodoStatus;
  /** What it reads as while it is the one being worked on ("Writing the tests"); `content` when the agent gave none. */
  activeForm?: string;
}

/** The tool's name, and the key of the status record that carries the list to toriel (JSON of TasksReport). */
export const TOOL_NAME = "todo_write";
export const STATUS_KEY = "toriel-tasks";

/** What the extension tells toriel through setStatus. */
export interface TasksReport {
  v: 1;
  todos: Todo[];
}

export const MAX_TODOS = 50;
const MAX_TEXT = 200;
const STATUSES: readonly string[] = ["pending", "in_progress", "completed"];

export type Parsed = { ok: true; todos: Todo[] } | { ok: false; error: string };

/** The list an agent sent, checked: a clear message for the model when it is not right (it can fix and send again). */
export function parseTodos(raw: unknown): Parsed {
  if (!Array.isArray(raw)) {
    return { ok: false, error: "todos must be an array of { content, status } objects" };
  }
  if (raw.length > MAX_TODOS) {
    return { ok: false, error: `at most ${MAX_TODOS} tasks; fold the small ones together` };
  }
  const todos: Todo[] = [];
  for (const [i, item] of raw.entries()) {
    const o = (item ?? {}) as Record<string, unknown>;
    const content = typeof o.content === "string" ? o.content.trim() : "";
    if (content === "") {
      return { ok: false, error: `task ${i + 1} has no content` };
    }
    if (typeof o.status !== "string" || !STATUSES.includes(o.status)) {
      return { ok: false, error: `task ${i + 1} ("${content.slice(0, 40)}") needs a status of pending, in_progress or completed` };
    }
    const activeForm = typeof o.activeForm === "string" && o.activeForm.trim() !== "" ? o.activeForm.trim().slice(0, MAX_TEXT) : undefined;
    todos.push({ content: content.slice(0, MAX_TEXT), status: o.status as TodoStatus, ...(activeForm ? { activeForm } : {}) });
  }
  return { ok: true, todos };
}

export function counts(todos: readonly Todo[]): { done: number; active: number; total: number } {
  return { done: todos.filter((t) => t.status === "completed").length, active: todos.filter((t) => t.status === "in_progress").length, total: todos.length };
}

/** What the tool answers the model: the list as it now stands, and a nudge when it is not in the shape the list is for. */
export function describeTodos(todos: readonly Todo[]): string {
  if (todos.length === 0) {
    return "The task list is empty.";
  }
  const c = counts(todos);
  const lines = todos.map((t, i) => `${i + 1}. [${t.status}] ${t.content}`);
  const notes: string[] = [];
  if (c.active > 1) {
    notes.push("More than one task is in_progress: work on one at a time and mark it completed as soon as it is done.");
  } else if (c.active === 0 && c.done < c.total) {
    notes.push("No task is in_progress: mark the one you are starting.");
  }
  return [`Task list updated: ${c.done} of ${c.total} done.`, ...lines, ...notes].join("\n");
}

/** The list as of the end of a session branch: the details of the last `todo_write` result in it (none = empty). */
export function reconstructTodos(branch: ReadonlyArray<{ type?: string; message?: { role?: string; toolName?: string; details?: unknown } }>): Todo[] {
  let todos: Todo[] = [];
  for (const entry of branch) {
    const m = entry.type === "message" ? entry.message : undefined;
    if (m?.role !== "toolResult" || m.toolName !== TOOL_NAME) {
      continue;
    }
    const details = m.details as { todos?: unknown } | undefined;
    const parsed = details?.todos === undefined ? undefined : parseTodos(details.todos);
    if (parsed?.ok) {
      todos = parsed.todos;
    }
  }
  return todos;
}

/** A status record's text read back (toriel's side); undefined when it is not one of ours. */
export function parseReport(text: unknown): Todo[] | undefined {
  try {
    const report = JSON.parse(String(text)) as { v?: number; todos?: unknown };
    if (report?.v !== 1) {
      return undefined;
    }
    const parsed = parseTodos(report.todos);
    return parsed.ok ? parsed.todos : undefined;
  } catch {
    return undefined;
  }
}

/** A list nobody has touched for this long, while the session works, is drawn as stale (ticket 251). */
export const STALE_AFTER_MS = 5 * 60_000;

/** "not updated 12m" (or "1h05m") once `staleMs` of working time has passed since the list changed; "" before that. */
export function staleNote(staleMs: number): string {
  if (!(staleMs >= STALE_AFTER_MS)) {
    return "";
  }
  const minutes = Math.floor(staleMs / 60_000);
  return `not updated ${minutes >= 60 ? `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m` : `${minutes}m`}`;
}

/**
 * The strip above the editor: a header with the count, the task in progress, then what is next, `max` lines at most. Finished
 * tasks are only counted (they are the past), and a list that is all done is the header alone. No tasks, no lines. `staleMs` is how
 * long the session has worked since the list last changed: past STALE_AFTER_MS the header says so.
 */
export function stripLines(todos: readonly Todo[], max = 6, staleMs = 0): string[] {
  if (todos.length === 0) {
    return [];
  }
  const c = counts(todos);
  const stale = c.done < c.total ? staleNote(staleMs) : "";
  const out = [`tasks ${c.done}/${c.total} done${stale ? ` - ${stale}` : ""}`];
  if (c.done === c.total) {
    return out;
  }
  const open = todos.filter((t) => t.status !== "completed");
  const room = Math.max(1, max - 1);
  const shown = open.length > room ? open.slice(0, room - 1) : open;
  for (const t of shown) {
    out.push(t.status === "in_progress" ? `▸ ${t.activeForm ?? t.content}` : `○ ${t.content}`);
  }
  if (shown.length < open.length) {
    out.push(`  +${open.length - shown.length} more`);
  }
  return out;
}

/** The whole list, for /tasks. */
export function listing(todos: readonly Todo[], staleMs = 0): string[] {
  if (todos.length === 0) {
    return ["No tasks. The agent keeps a list when it works on something with several steps."];
  }
  const c = counts(todos);
  const stale = c.done < c.total ? staleNote(staleMs) : "";
  return [`Tasks: ${c.done} of ${c.total} done${stale ? ` - ${stale}` : ""}`, "", ...todos.map((t) => `${t.status === "completed" ? "✓" : t.status === "in_progress" ? "▸" : "○"} ${t.content}`)];
}
