// Per-session goals (ticket 258): one short text per session, kept across restarts, keyed by session UUID.
// Set with /goal, marked done by the user or the agent (the future pi extension), cleared by the user or the
// session's delete; a fork copies the goal it was made from.
import * as fs from "node:fs";
import * as path from "node:path";
import type { ClientCommand, DistributiveOmit } from "./shared.ts";
import { errText, readJsonOr, writeJsonAtomic } from "./util.ts";

/** One session's goal: what it is working towards, when it was set, and whether it is done. */
export interface GoalRecord {
  text: string;
  /** When the goal was set (ms since epoch). */
  setAt: number;
  done?: boolean;
  /** When it was marked done (ms since epoch). */
  doneAt?: number;
  /** Who marked it done ("user" via /goal done, "agent" via the goal command from pi). */
  doneBy?: "user" | "agent";
}

interface GoalsFile {
  goals: Record<string, GoalRecord>;
}

export type GoalAction = "set" | "done" | "clear" | "get";

/**
 * The action a typed /goal line asks for (ticket 258): exactly single-word done, clear or get (and bare /goal, which shows), is that
 * action; anything else is the goal text - so "/goal fix the build" sets it, "/goal done" marks it done, and "/goal done with refactor"
 * sets a goal whose text is "done with refactor". `set <text>` spells a set whose text is an action word.
 */
export function goalAction(words: string): { action: GoalAction; text: string } | { error: string } {
  const parts = words.trim().split(/\s+/).filter(Boolean);
  const head = parts[0]?.toLowerCase();
  if (head === undefined) {
    return { action: "get", text: "" };
  }
  if (parts.length === 1 && (head === "done" || head === "clear" || head === "get")) {
    return { action: head, text: "" };
  }
  const text = (head === "set" ? parts.slice(1) : parts).join(" ");
  if (!text) {
    return { error: "no text given - /goal <text> sets one (/goal shows the current goal)" };
  }
  return { action: "set", text };
}

/** One goal as the sessions broadcast carries it: enough for the switcher rows (text and done), no timestamps (ticket 258). */
export interface GoalSummary {
  text: string;
  done: boolean;
}

/** What /goal says once the daemon has answered: for clear, the record it removed (null when the session had none), else the record after the change (null when none results). */
export function goalNote(action: GoalAction, rec: GoalRecord | null): string {
  if (action === "clear") {
    return rec ? "goal cleared" : "no goal to clear";
  }
  if (!rec) {
    return action === "done" ? "no goal to mark done" : "no goal - /goal <text> to set one";
  }
  if (action === "done") {
    return `goal marked done: ${rec.text}`;
  }
  if (action === "set") {
    return `goal set: ${rec.text}`;
  }
  return `goal: ${rec.text}${rec.done === true ? (rec.doneBy === "agent" ? " (done, by the agent)" : " (done)") : ""}`;
}

export class GoalStore {
  private goals = new Map<string, GoalRecord>();
  private readonly file: string;
  private readonly now: () => number;

  constructor(file: string, now: () => number = Date.now) {
    this.file = file;
    this.now = now;
  }

  load(): void {
    const data = readJsonOr<Partial<GoalsFile>>(this.file, {});
    this.goals = new Map(Object.entries(data.goals ?? {}).filter(([, g]) => typeof g?.text === "string" && typeof g?.setAt === "number"));
  }

  get(sessionId: string | undefined): GoalRecord | undefined {
    return sessionId === undefined ? undefined : this.goals.get(sessionId);
  }

  /** Set or replace a session's goal (a new goal is not done); returns the record. */
  set(sessionId: string, text: string): GoalRecord {
    const record: GoalRecord = { text, setAt: this.now() };
    this.goals.set(sessionId, record);
    this.save();
    return record;
  }

  /** Mark the session's goal done; returns the record, or undefined when there is none to mark. */
  done(sessionId: string, by: "user" | "agent"): GoalRecord | undefined {
    const record = this.goals.get(sessionId);
    if (!record) {
      return undefined;
    }
    record.done = true;
    record.doneAt = this.now();
    record.doneBy = by;
    this.save();
    return record;
  }

  /** Forget the goal; returns the one it had, or undefined when there was none. */
  clear(sessionId: string): GoalRecord | undefined {
    const record = this.goals.get(sessionId);
    if (this.goals.delete(sessionId)) {
      this.save();
    }
    return record;
  }

  /** The session is gone: drop its goal (named for the lifecycle callers, the same forget as /goal clear). */
  remove(sessionId: string): void {
    this.clear(sessionId);
  }

  /** Every goal, by session UUID, as a summary: what the sessions broadcast carries, so rows without a live meta (after a daemon restart) still show the goal. */
  summary(): Record<string, GoalSummary> {
    const out: Record<string, GoalSummary> = {};
    for (const [id, record] of this.goals) {
      out[id] = { text: record.text, done: record.done === true };
    }
    return out;
  }

  /** Give `to` its own copy of `from`'s goal, done state included (a /fork copy keeps the job it was made from). */
  copy(from: string, to: string): boolean {
    const record = this.goals.get(from);
    if (!record) {
      return false;
    }
    this.goals.set(to, { ...record });
    this.save();
    return true;
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeJsonAtomic(this.file, { goals: Object.fromEntries(this.goals) } satisfies GoalsFile);
  }
}

/** Send one goal command to the daemon and say what it answered, as a /goal note: the request-and-error mapping both /goal handlers share (ticket 258). */
export async function requestGoal(
  h: { request(cmd: DistributiveOmit<ClientCommand, "id">, timeoutMs?: number): Promise<unknown> },
  sessionId: string,
  action: GoalAction,
  text?: string,
): Promise<string> {
  try {
    const rec = (await h.request(
      { type: "goal", action, sessionId, ...(action === "set" ? { text } : {}), ...(action === "done" ? { by: "user" as const } : {}) },
      5000,
    )) as GoalRecord | null;
    return goalNote(action, rec);
  } catch (err) {
    const stale = err instanceof Error && /timed out/.test(err.message);
    if (stale) {
      return "goal: no answer from the daemon (is it older than this toriel? restart it: toriel kill-server)";
    }
    return `goal failed: ${errText(err)}`;
  }
}
