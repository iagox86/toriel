// Rewinding the code along with the conversation (ticket 11): the toriel side of pi/extensions/lib/file-history.ts. The session's
// journal is found by the session id in its file's header; the controller summarises what the agent's edits since a message did (for
// the rewind list), the daemon puts the files back.
import * as path from "node:path";
import { applyRestore, type CodePlan, planRestore, pruneFrom, type RestoreResult } from "../pi/extensions/lib/file-history.ts";
import { FILE_HISTORY_DIR } from "./config.ts";
import { readHeader } from "./session-file.ts";

/** The journal directory of the session whose file is `sessionFile`, or undefined when its header has no usable id. */
export function historyDirFor(sessionFile: string, root: string = FILE_HISTORY_DIR): string | undefined {
  const id = readHeader(sessionFile)?.id;
  return typeof id === "string" && /^[A-Za-z0-9._-]+$/.test(id) ? path.join(root, id) : undefined;
}

/** What undoing the code back to the message sent at `sinceMs` would do; undefined when the agent changed no file since then (or there is no history). */
export function codePlanFor(sessionFile: string, sinceMs: number, root?: string): CodePlan | undefined {
  if (!(sinceMs > 0)) {
    return undefined;
  }
  const dir = historyDirFor(sessionFile, root);
  if (dir === undefined) {
    return undefined;
  }
  const plan = planRestore(dir, sinceMs);
  return plan.files.some((f) => f.status !== "same") ? plan : undefined;
}

/** What the rewind list shows for one message: how many files the code undo would change, the lines it adds and removes, and files it would leave alone. */
export interface CodeSummary {
  files: number;
  added: number;
  removed: number;
  /** Files changed after the agent's last edit, or too big to keep: a restore leaves them. */
  leftAlone: number;
}

export function summarize(plan: CodePlan | undefined): CodeSummary | undefined {
  if (plan === undefined) {
    return undefined;
  }
  const leftAlone = plan.files.filter((f) => f.status === "changed-since" || f.status === "too-big").length;
  return plan.restorable > 0 || leftAlone > 0 ? { files: plan.restorable, added: plan.added, removed: plan.removed, leftAlone } : undefined;
}

/**
 * Put the files back as they were when the message at `sinceMs` was sent. `dropRecords` also forgets the journal from then on, for a
 * rewind that cut the conversation away (with "code only" the conversation, and so the records, stay) - but only when every file went
 * back: a file left behind keeps its records and blobs, the only copy of what it held.
 */
export function restoreCode(sessionFile: string, sinceMs: number, dropRecords: boolean, root?: string): RestoreResult & { plan: CodePlan } {
  const dir = historyDirFor(sessionFile, root);
  if (dir === undefined || !(sinceMs > 0)) {
    return { restored: [], left: [], plan: { files: [], restorable: 0, added: 0, removed: 0 } };
  }
  const plan = planRestore(dir, sinceMs);
  const result = applyRestore(dir, plan);
  if (dropRecords && result.left.length === 0) {
    pruneFrom(dir, sinceMs);
  }
  return { ...result, plan };
}
