// Reminders to keep the task list current (ticket 250). Models write a todo list and then forget it: marking work done has no
// immediate payoff, so a small model can finish every item and leave the list on "1 in progress". Claude Code reminds the model
// from outside; this is the same, as pure state so it is testable without pi: the extension (toriel-tasks.ts) feeds it the list and
// each finished tool call, and appends what it returns to the next tool result, or asks for one more turn before the run ends.
import { counts, type Todo, TOOL_NAME } from "./tasks.ts";

/** Tool calls without a todo_write, while items are open, before the next tool result carries a reminder (and between reminders). */
export const MID_RUN_CALLS = 8;
/** Tool calls since the last todo_write before an ending run is given one more turn to update the list. */
export const END_OF_RUN_CALLS = 3;

/** The reminder text: names what the list says now, so the model can see it is out of date. */
export function reminderText(todos: readonly Todo[]): string {
  const c = counts(todos);
  const current = todos.find((t) => t.status === "in_progress");
  const open = c.total - c.done;
  const state = current ? `"${current.activeForm ?? current.content}" in progress, ${open - 1} more open` : `${open} open`;
  return `Reminder: your task list (${c.done} of ${c.total} done) still shows ${state}. If that has changed, update it now with ${TOOL_NAME}: mark finished work completed and the next task in_progress. If it is still accurate, carry on and ignore this.`;
}

export class TaskNudges {
  private todos: readonly Todo[] = [];
  private sinceWrite = 0;
  private lastMidRun = 0;
  private endOfRunAsked = false;

  /** The list was written (a todo_write call, or a start/resume/fork/rewind that read it back): the model is up to date as of now. */
  setList(todos: readonly Todo[]): void {
    this.todos = todos;
    this.sinceWrite = 0;
    this.lastMidRun = 0;
  }

  /** Open items exist: an empty or finished list is never nagged about. */
  private get open(): boolean {
    const c = counts(this.todos);
    return c.total > 0 && c.done < c.total;
  }

  /** A tool call other than todo_write finished; the reminder to add to its result, if it is time. */
  afterToolCall(toolName: string | undefined): string | undefined {
    if (toolName === TOOL_NAME) {
      return undefined; // setList already ran, from the tool itself
    }
    this.sinceWrite++;
    if (!this.open || this.sinceWrite - this.lastMidRun < MID_RUN_CALLS) {
      return undefined;
    }
    this.lastMidRun = this.sinceWrite;
    return reminderText(this.todos);
  }

  /** A new run (a prompt from the user) begins: the one-more-turn allowance is back. */
  runStarted(): void {
    this.endOfRunAsked = false;
  }

  /**
   * The run is about to end: the reminder to give the model one more turn with, or undefined. At most once per run (the turn it buys
   * may update the list or not; either way the run then ends), and only when the model did real work since it last wrote the list.
   */
  beforeRunEnds(aborted: boolean): string | undefined {
    if (aborted || this.endOfRunAsked || !this.open || this.sinceWrite < END_OF_RUN_CALLS) {
      return undefined;
    }
    this.endOfRunAsked = true;
    return reminderText(this.todos);
  }
}
