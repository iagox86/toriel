// Goal changes as lines in a session's transcript (ticket 348): the daemon keeps each session's goal events (GoalStore.history),
// and the controller places one dim row per event among the transcript's items by time, live and on replay alike.
import type { GoalEvent, GoalSummary } from "./goals.ts";

/** The line for one goal event, without the "toriel: " prefix the row adds. */
export function goalLineText(e: GoalEvent): string {
  switch (e.kind) {
    case "set":
      return `goal set: ${e.text}`;
    case "done":
      return `goal done: ${e.text}${e.by === "agent" ? " (marked by the agent)" : ""}`;
    case "cleared":
      return `goal cleared: ${e.text}`;
  }
}

/** The session UUIDs whose goal changed between two sessions broadcasts: a new goal, a re-set or done (a new stamp), or a goal gone (cleared). */
export function changedGoals(prev: Record<string, GoalSummary>, next: Record<string, GoalSummary>): string[] {
  const out: string[] = [];
  for (const [id, g] of Object.entries(next)) {
    const before = prev[id];
    if (!before || before.at !== g.at || before.text !== g.text || before.done !== g.done) {
      out.push(id);
    }
  }
  for (const id of Object.keys(prev)) {
    if (!(id in next)) {
      out.push(id);
    }
  }
  return out;
}

/** What placeGoalLines needs of an item: when it happened, and whether it is a goal row it put there. */
export interface Placeable {
  at?: number;
  goalLine?: boolean;
}

/**
 * `items` with the goal rows of an earlier placement taken out and one row per event put back: before the first item stamped later
 * than the event, else at the end. Items with no stamp (a message the file kept without a time) are passed over, so they never
 * decide where a line goes.
 */
export function placeGoalLines<T extends Placeable>(items: readonly T[], events: readonly GoalEvent[], row: (e: GoalEvent) => T): T[] {
  const out = items.filter((i) => !i.goalLine);
  for (const e of [...events].sort((a, b) => a.at - b.at)) {
    const line = row(e);
    line.at = e.at;
    line.goalLine = true;
    const at = out.findIndex((i) => i.at !== undefined && i.at > e.at);
    if (at === -1) {
      out.push(line);
    } else {
      out.splice(at, 0, line);
    }
  }
  return out;
}
