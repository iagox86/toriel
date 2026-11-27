// Reminders to keep the session's goal in the model's mind (ticket 260). The goal is set by the user (or the model, via
// the toriel_goal tool) and then easy to forget: a small model can finish every step without ever looking at what it was
// aiming for. The task-list nudge (task-nudge.ts, ticket 250) is the same shape, so this reuses its thresholds; the goal is
// pure state here so it is testable without pi: the extension (toriel-goal.ts) feeds it the goal record and each finished
// tool call, and appends what it returns to the next tool result, or asks for one more turn before the run ends.
export { END_OF_RUN_CALLS, MID_RUN_CALLS } from "./task-nudge.ts";
import { END_OF_RUN_CALLS, MID_RUN_CALLS } from "./task-nudge.ts";

export const TOOL_NAME = "toriel_goal";

/** The reminder text: names the goal, so the model can act on it or mark it done. */
export function reminderText(goal: string): string {
  return `Reminder: your goal is "${goal}". Act on it, or if it is achieved, mark it done now with ${TOOL_NAME}. If the goal was already marked done, ignore this reminder.`;
}

export class GoalNudges {
  private goal: string | undefined;
  private active = false;
  private announced = false;
  private callsThisRun = 0;
  private lastMidRun = 0;
  private endOfRunAsked = false;

  /**
   * What the daemon says the session's goal is: active when there is one that is not done. A text that becomes non-null (a
   * goal set, or a refetch delivering a different one) re-arms the immediate reminder; the same text again is not news.
   */
  setGoal(goal: { text: string; done?: boolean } | null | undefined): void {
    const text = goal && !goal.done ? goal.text : undefined;
    const changed = text !== undefined && text !== this.goal;
    this.goal = text;
    this.active = text !== undefined;
    if (changed) {
      // a fresh goal restarts the cadence; the same text again (a mid-run refetch) never does
      this.callsThisRun = 0;
      this.lastMidRun = 0;
      this.announced = false;
    }
  }

  /** The model marked the goal done (toriel_goal): no more reminders this run. */
  markedDone(): void {
    this.active = false;
    this.goal = undefined;
  }

  /** A tool call other than toriel_goal finished; the reminder to add to its result, if it is time. */
  afterToolCall(toolName: string | undefined): string | undefined {
    if (toolName === TOOL_NAME) {
      return undefined; // a toriel_goal call is not counted, whether it marked the goal done or failed
    }
    if (!this.active) {
      return undefined;
    }
    this.callsThisRun++;
    if (!this.announced) {
      // the goal only just became live: say it at once instead of waiting for the 8-call cadence
      this.announced = true;
      this.lastMidRun = this.callsThisRun;
      return reminderText(this.goal as string);
    }
    if (this.callsThisRun - this.lastMidRun < MID_RUN_CALLS) {
      return undefined;
    }
    this.lastMidRun = this.callsThisRun;
    return reminderText(this.goal as string);
  }

  /** A new run (a prompt from the user) begins: the one-more-turn allowance is back, and this run's count starts over. */
  runStarted(): void {
    this.endOfRunAsked = false;
    this.callsThisRun = 0;
    this.lastMidRun = 0;
  }

  /**
   * The run is about to end with an open goal: the reminder to give the model one more turn with, or undefined. At most once
   * per run (the turn it buys may mark the goal done or not; either way the run then ends), and only when the model did work
   * in this run, so a run that ends at once is not nagged.
   */
  beforeRunEnds(aborted: boolean): string | undefined {
    if (aborted || this.endOfRunAsked || !this.active || this.callsThisRun < END_OF_RUN_CALLS) {
      return undefined;
    }
    this.endOfRunAsked = true;
    return reminderText(this.goal as string);
  }
}
