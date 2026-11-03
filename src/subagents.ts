// Subagent bookkeeping and limits (docs/design.md item 9). Pure: the daemon
// side (daemon-subagents.ts) starts and stops the sessions; this decides
// whether a spawn is allowed and keeps the records the tools read back.
import type { AgentProfile } from "./agents.ts";

export interface SubagentLimits {
  /** How many subagent links may sit above a session that spawns (1 = only the user's sessions spawn). */
  maxDepth: number;
  /** Subagents running at once, daemon-wide. */
  maxConcurrent: number;
  /** Spawns one session may make over its lifetime in this daemon. */
  maxSpawnsPerParent: number;
  /** Default token budget of one subagent when its profile sets none. */
  budget: number;
}

/** `maxDepth` may be raised, but never past this. */
export const HARD_MAX_DEPTH = 2;

export const DEFAULT_SUBAGENT_LIMITS: SubagentLimits = { maxDepth: 1, maxConcurrent: 3, maxSpawnsPerParent: 20, budget: 150_000 };

/** How long a finished subagent stays in the switcher before it is deleted (the trash keeps its file). */
export const DEFAULT_KEEP_MS = 30 * 60_000;

/** The grace window from `TORIEL_SUBAGENT_KEEP_MS`: a whole number of ms, 0 allowed; anything else (unset, negative, not a number) means the default. */
export function keepMsFrom(raw: string | undefined): number {
  const n = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_KEEP_MS;
}

export type SubagentState = "running" | "done" | "stopped" | "limit" | "failed";

export interface SubagentRecord {
  /** The number the tools use (#1, #2...), unique per daemon run. */
  handle: number;
  /** UUID of the session that started it. */
  parent: string;
  /** Daemon session number of the subagent. */
  session: number;
  childId?: string;
  childName?: string;
  agent: string;
  description: string;
  background: boolean;
  state: SubagentState;
  startedAt: number;
  endedAt?: number;
  /** The subagent's final assistant text (partial after a stop or a limit). */
  result?: string;
  /** Why it ended early, or anything else the parent should know. */
  note?: string;
  /** When the parent had the result: the tool call answered (foreground) or the message delivered (background). */
  deliveredAt?: number;
  /** Assistant messages so far. */
  turns: number;
  /** Tokens counted against the budget so far (see messageTokens). */
  tokens: number;
  /** How the newest assistant message ended ("stop", "toolUse", "error", "aborted") and its error text. */
  lastStop?: string;
  lastError?: string;
  /** Token budget of this run (profile or default, capped by what the parent had left). */
  budget: number;
  maxTurns?: number;
}

export class SubagentBook {
  private readonly records: SubagentRecord[] = [];
  private nextHandle = 1;

  add(init: Omit<SubagentRecord, "handle" | "state" | "startedAt" | "turns" | "tokens">, now = Date.now()): SubagentRecord {
    const rec: SubagentRecord = { ...init, handle: this.nextHandle++, state: "running", startedAt: now, turns: 0, tokens: 0 };
    this.records.push(rec);
    return rec;
  }

  get(handle: number): SubagentRecord | undefined {
    return this.records.find((r) => r.handle === handle);
  }

  bySession(session: number): SubagentRecord | undefined {
    return this.records.find((r) => r.session === session);
  }

  /** The record of the session with this UUID, when it is a subagent. */
  byChild(uuid: string): SubagentRecord | undefined {
    return this.records.find((r) => r.childId === uuid);
  }

  ofParent(parent: string): SubagentRecord[] {
    return this.records.filter((r) => r.parent === parent);
  }

  running(): SubagentRecord[] {
    return this.records.filter((r) => r.state === "running");
  }
}

export interface SpawnContext {
  limits: SubagentLimits;
  book: SubagentBook;
  parent: string;
  /** The spawning session's own profile; undefined = a plain session the user started. */
  parentProfile?: AgentProfile;
  /** Subagent links above the parent. */
  parentDepth: number;
}

/** Whether a session gets the toriel_agent tools: its profile (none = a session the user started) allows spawning and it has depth left. */
export function mayDelegate(profile: AgentProfile | undefined, depth: number, limits: SubagentLimits): boolean {
  return (!profile || profile.canSpawn) && depth < Math.min(limits.maxDepth, HARD_MAX_DEPTH);
}

/** Why a spawn is refused, in words the calling model can act on; undefined when it may go ahead. */
export function refuseSpawn(c: SpawnContext): string | undefined {
  const maxDepth = Math.min(c.limits.maxDepth, HARD_MAX_DEPTH);
  if (c.parentProfile && !c.parentProfile.canSpawn) {
    return `This agent profile ("${c.parentProfile.name}") may not start subagents (canSpawn is false). Do the work yourself.`;
  }
  if (c.parentDepth >= maxDepth) {
    return `Subagents may not start subagents here (depth limit ${maxDepth}). Do the work yourself.`;
  }
  const spawned = c.book.ofParent(c.parent).length;
  if (spawned >= c.limits.maxSpawnsPerParent) {
    return `This session has already started ${spawned} subagents (limit ${c.limits.maxSpawnsPerParent}). Do the rest yourself or ask the user.`;
  }
  const running = c.book.running().length;
  if (running >= c.limits.maxConcurrent) {
    return `${running} subagents are already running (limit ${c.limits.maxConcurrent}). Wait for one with toriel_agents {action: "wait"} or try again shortly.`;
  }
  return undefined;
}

/** Token budget for a new subagent: its profile's, else the default, never more than its parent has left (undefined = unlimited parent). */
export function childBudget(profileBudget: number | undefined, limits: SubagentLimits, parentLeft: number | undefined): number {
  const own = profileBudget ?? limits.budget;
  return parentLeft === undefined ? own : Math.max(0, Math.min(own, parentLeft));
}

export interface TurnCheck {
  turns: number;
  maxTurns?: number;
  tokens: number;
  budget: number;
  /** The message ended in a tool call, so the run goes on (a run that is ending needs no cutting). */
  continuing: boolean;
}

/** Whether a running subagent must be cut off, and the note for its parent. */
export function limitBreach(c: TurnCheck): string | undefined {
  if (!c.continuing) {
    return undefined;
  }
  if (c.tokens >= c.budget) {
    return `stopped: it used ${c.tokens} tokens, over its budget of ${c.budget}`;
  }
  if (c.maxTurns !== undefined && c.turns >= c.maxTurns) {
    return `stopped: it reached its limit of ${c.maxTurns} turns`;
  }
  return undefined;
}

/** What a tool shows for one record. */
export function describeRecord(r: SubagentRecord, now = Date.now()): string {
  const secs = Math.round(((r.endedAt ?? now) - r.startedAt) / 1000);
  const note = r.note ? ` - ${r.note}` : "";
  return `#${r.handle} ${r.agent}: ${r.description} [${r.state}${r.background ? ", background" : ""}, ${r.turns}${r.maxTurns !== undefined ? `/${r.maxTurns}` : ""} turn(s), ${r.tokens}/${r.budget} tokens, ${secs}s]${note}`;
}

/** The result text a parent gets: the subagent's words, with the reason when it was cut short. */
export function resultText(r: SubagentRecord): string {
  const body = r.result?.trim() ? r.result.trim() : "(the subagent produced no text)";
  switch (r.state) {
    case "running":
      return `#${r.handle} is still running.`;
    case "done":
      return body;
    case "failed":
      return `Subagent #${r.handle} failed${r.note ? `: ${r.note}` : ""}.${r.result ? `\n\nPartial result:\n${body}` : ""}`;
    default:
      return `Subagent #${r.handle} ${r.note ?? "was stopped"}.\n\nPartial result:\n${body}`;
  }
}

/** "#3" or "3" as a handle number. */
export function parseHandle(ref: string | undefined): number | undefined {
  const m = /^#?(\d+)$/.exec((ref ?? "").trim());
  return m ? Number(m[1]) : undefined;
}

/** A subagent session as the sweep sees it. */
export interface SweepCandidate {
  uuid: string;
  /** Its session file, when known. */
  file?: string;
  /** Last change to the file (ms), 0 when unknown. */
  mtime: number;
  /** A pi process is running for it (someone reopened it, or it is still working). */
  live: boolean;
  /** The in-memory record, when this daemon run started it. */
  record?: Pick<SubagentRecord, "state" | "endedAt" | "deliveredAt">;
}

/**
 * The subagents whose grace window has ended. The window starts when the parent had the result
 * (background: delivery; foreground: the answered call), or at the last change to the file if that
 * is later, so a subagent someone kept talking to is not swept; with no record (a daemon restart
 * since) the file alone dates it. Anything live or still running stays.
 */
export function expiredSubagents(cands: readonly SweepCandidate[], now: number, keepMs: number): SweepCandidate[] {
  return cands.filter((c) => {
    if (c.live || c.record?.state === "running") {
      return false;
    }
    const settled = c.record ? (c.record.deliveredAt ?? c.record.endedAt ?? 0) : 0;
    const since = Math.max(settled, c.mtime);
    return since > 0 && now - since >= keepMs;
  });
}

/**
 * What one assistant message adds to a subagent's budget: the input it had to process fresh, what it
 * wrote, and cache writes. Cache reads are left out: pi's `totalTokens` counts the whole re-read context
 * of every turn, so a run that only ever held 25k tokens of context would have "used" 150k after seven turns.
 */
export function messageTokens(usage: { input?: number; output?: number; cacheWrite?: number } | undefined): number {
  return (usage?.input ?? 0) + (usage?.output ?? 0) + (usage?.cacheWrite ?? 0);
}

/** How a run that settled on its own ended, when that was not a normal finish: an error or an abort (the user's esc on its view, a provider failure). */
export function abnormalEnd(lastStop: string | undefined, lastError: string | undefined): { state: SubagentState; note: string } | undefined {
  if (lastStop === undefined) {
    return { state: "failed", note: "ended without producing an answer" };
  }
  if (lastStop === "toolUse") {
    return { state: "failed", note: "ended on a tool call, with no final answer" };
  }
  if (lastStop === "aborted") {
    return { state: "stopped", note: "was interrupted (aborted) before it finished" };
  }
  if (lastStop === "error") {
    return { state: "failed", note: `ended with an error${lastError ? `: ${lastError}` : ""}` };
  }
  return undefined;
}

/** The newest non-empty assistant text in a message list: what a subagent had said before it was cut off. */
export function lastAssistantText(messages: ReadonlyArray<{ role?: string; content?: unknown }>): string | undefined {
  for (const m of [...messages].reverse()) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) {
      continue;
    }
    const text = (m.content as Array<{ type?: string; text?: string }>)
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text)
      .join("\n")
      .trim();
    if (text) {
      return text;
    }
  }
  return undefined;
}
