// Where a switcher-spawned session lands: in the group of the row highlighted
// when the spawn was started (a header is that group's title, a session is
// that session's group); nothing highlighted means ungrouped (ticket 326).
import { resolveGroup, type GroupsFile } from "./groups.ts";

/** A highlighted switcher row, from the switcher's point of view: a group header, or a session (with its group, if any). */
export type SpawnRow = { kind: "header"; title: string } | { kind: "session"; group?: string };

/**
 * The group a new session joins, from the highlighted row: a header's title,
 * a session's group. Nothing highlighted, the "(ungrouped)" pseudo-group, or
 * a session without a group leaves the session ungrouped - undefined, so the
 * caller writes nothing (never a null tombstone, never "(ungrouped)").
 */
export function groupForSpawn(row: SpawnRow | undefined): string | undefined {
  if (!row) {
    return undefined;
  }
  if (row.kind === "header") {
    return row.title === "(ungrouped)" ? undefined : row.title;
  }
  return row.group || undefined;
}

/** Assign `sessionId` to `title` (resolved against `groups`), touching nothing else. */
export function applySpawnGroup(groups: GroupsFile, sessionId: string, title: string): void {
  groups.assignments[sessionId] = resolveGroup(groups, title);
}
