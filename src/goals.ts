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

/** One change to a session's goal, kept after the goal itself is gone, so a replayed transcript can still say it happened (ticket 348). */
export interface GoalEvent {
  kind: "set" | "done" | "cleared";
  /** The goal's text at the time. */
  text: string;
  /** When it happened (ms since epoch). */
  at: number;
  /** Who marked it done (done only). */
  by?: "user" | "agent";
}

/** Events kept per session; older ones drop off (a transcript line about a goal from long ago is not worth an unbounded file). */
export const GOAL_LOG_MAX = 50;

interface GoalsFile {
  goals: Record<string, GoalRecord>;
  log?: Record<string, GoalEvent[]>;
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

/** One goal as the sessions broadcast carries it: enough for the switcher rows (text and done), plus when it last changed (ticket 258). */
export interface GoalSummary {
  text: string;
  done: boolean;
  /** When the goal was last set or marked done: a changed stamp is a goal change even when text and done are the same (ticket 348). */
  at: number;
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
  private log = new Map<string, GoalEvent[]>();
  private readonly file: string;
  private readonly now: () => number;

  constructor(file: string, now: () => number = Date.now) {
    this.file = file;
    this.now = now;
  }

  load(): void {
    const data = readJsonOr<Partial<GoalsFile>>(this.file, {});
    this.goals = new Map(Object.entries(data.goals ?? {}).filter(([, g]) => typeof g?.text === "string" && typeof g?.setAt === "number"));
    this.log = new Map(
      Object.entries(data.log ?? {})
        .map(([id, events]): [string, GoalEvent[]] => [id, Array.isArray(events) ? events.filter((e) => typeof e?.text === "string" && typeof e?.at === "number" && ["set", "done", "cleared"].includes(e?.kind)) : []])
        .filter(([, events]) => events.length > 0),
    );
  }

  /** The session's goal changes, oldest first (ticket 348): kept after a clear, gone with the session. */
  history(sessionId: string): GoalEvent[] {
    return [...(this.log.get(sessionId) ?? [])];
  }

  private record(sessionId: string, event: GoalEvent): void {
    this.log.set(sessionId, [...(this.log.get(sessionId) ?? []), event].slice(-GOAL_LOG_MAX));
  }

  get(sessionId: string | undefined): GoalRecord | undefined {
    return sessionId === undefined ? undefined : this.goals.get(sessionId);
  }

  /** Set or replace a session's goal (a new goal is not done); returns the record. */
  set(sessionId: string, text: string): GoalRecord {
    const record: GoalRecord = { text, setAt: this.now() };
    this.goals.set(sessionId, record);
    this.record(sessionId, { kind: "set", text, at: record.setAt });
    this.save();
    return record;
  }

  /** Mark the session's goal done; returns the record, or undefined when there is none to mark. */
  done(sessionId: string, by: "user" | "agent"): GoalRecord | undefined {
    const record = this.goals.get(sessionId);
    if (!record) {
      return undefined;
    }
    const wasDone = record.done === true;
    record.done = true;
    record.doneAt = this.now();
    record.doneBy = by;
    if (!wasDone) {
      this.record(sessionId, { kind: "done", text: record.text, at: record.doneAt, by });
    }
    this.save();
    return record;
  }

  /** Forget the goal (its history stays); returns the one it had, or undefined when there was none. */
  clear(sessionId: string): GoalRecord | undefined {
    const record = this.goals.get(sessionId);
    if (record && this.goals.delete(sessionId)) {
      this.record(sessionId, { kind: "cleared", text: record.text, at: this.now() });
      this.save();
    }
    return record;
  }

  /** The session is gone: drop its goal and its history. */
  remove(sessionId: string): void {
    const had = this.goals.delete(sessionId);
    if (this.log.delete(sessionId) || had) {
      this.save();
    }
  }

  /** Every goal, by session UUID, as a summary: what the sessions broadcast carries, so rows without a live meta (after a daemon restart) still show the goal. */
  summary(): Record<string, GoalSummary> {
    const out: Record<string, GoalSummary> = {};
    for (const [id, record] of this.goals) {
      out[id] = { text: record.text, done: record.done === true, at: record.doneAt ?? record.setAt };
    }
    return out;
  }

  /** Give `to` its own copy of `from`'s goal, done state and history included (a /fork copy keeps the job it was made from, and its transcript the lines about it). */
  copy(from: string, to: string): boolean {
    const record = this.goals.get(from);
    const log = this.log.get(from);
    if (log) {
      this.log.set(to, [...log]);
    }
    if (record) {
      this.goals.set(to, { ...record });
    }
    if (record || log) {
      this.save();
    }
    return record !== undefined;
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeJsonAtomic(this.file, { goals: Object.fromEntries(this.goals), log: Object.fromEntries(this.log) } satisfies GoalsFile);
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
