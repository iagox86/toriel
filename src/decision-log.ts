// One line per permission prompt the daemon handles (ticket 239): which surface and rule asked, why it was shown if auto mode stood
// aside, and who answered (a grant, auto mode, the user, the deny-after timer). pi's own review log records the ask but not the
// answer's author, so "auto mode still prompts" could not be told from "I answered these myself". Kept next to the other daemon data;
// `/feedback` copies the lines around a note into its bundle. Best effort: a log that cannot be written never blocks a prompt.
import * as fs from "node:fs";
import * as path from "node:path";
import { DECISIONS_FILE } from "./config.ts";

/** Who answered: a toriel grant, auto mode, the person, the deny-after timer, or nobody (the prompt went away unanswered). */
export type DecidedBy = "grant" | "auto" | "user" | "deny-after" | "dropped";

export interface DecisionRecord {
  v: 1;
  at: string;
  /** The daemon's id for the session, and pi's session uuid when known. */
  session: number;
  sessionId?: string;
  /** The agent profile's name; null for a plain session. */
  agent: string | null;
  /** The dialog title's first line (pi-permission-system's "Permission Required ..."), shortened. */
  title?: string;
  /** The surfaces the prompt was about (`bash`, `mcp`, `external_directory_write`, ...) and what it concerned (command, path or tool), shortened. */
  surfaces: string[];
  value?: string;
  /** Why pi asked, as the grants link reported it: a rule the owner wrote (explicit) or the default. Absent when the link said nothing. */
  rule?: { explicit: boolean; pattern?: string; origin?: string };
  /** Auto mode was on when the prompt arrived; `floor` says why it stood aside, when it did. */
  auto: boolean;
  floor?: string;
  by: DecidedBy;
  /** The kind of client that answered when it said so ("chatto" for the chat bridge); absent for a toriel controller (ticket 270). */
  source?: string;
  /** "yes", "no", "cancelled", or the option's own text; absent for a prompt nobody answered. */
  answer?: string;
  /** How long the prompt waited before it was answered (a person's, or the deny-after timer's), ms. */
  waitMs?: number;
  /** A controller was attached, so a person could have seen it. */
  attended: boolean;
  /** The session's scope mode (deny or ask), when it is scoped. */
  scope?: "deny" | "ask";
}

/** A record before anyone has answered: everything but the answer. */
export type DecisionBase = Omit<DecisionRecord, "v" | "at" | "by" | "answer" | "waitMs" | "source">;

const MAX_BYTES = 8 * 1024 * 1024;

/** Shorten a command or path for the log: one line, at most 200 characters. */
export function brief(text: string | undefined, max = 200): string | undefined {
  if (text === undefined) {
    return undefined;
  }
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** What a user's reply to a dialog says: yes, no, cancelled, or the option text. */
export function answerText(response: Record<string, unknown>): string {
  if (response.cancelled === true) {
    return "cancelled";
  }
  if (typeof response.confirmed === "boolean") {
    return response.confirmed ? "yes" : "no";
  }
  const value = typeof response.value === "string" ? response.value : "";
  const first = value.split(/[\s,:]/, 1)[0]?.toLowerCase();
  return first === "yes" || first === "no" ? first : (brief(value, 60) ?? "");
}

/** Append one record. The file is rotated to `.1` past 8 MB, so it cannot grow without bound. */
export function recordDecision(rec: Omit<DecisionRecord, "v" | "at"> & { at?: string }, file = DECISIONS_FILE): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > MAX_BYTES) {
        fs.renameSync(file, `${file}.1`);
      }
    } catch {
      // no file yet
    }
    fs.appendFileSync(file, `${JSON.stringify({ v: 1, at: new Date().toISOString(), ...rec })}\n`);
  } catch {
    // best effort
  }
}

/** The records written between two times (ISO strings, inclusive), oldest first; torn lines are skipped. */
export function readDecisions(from: string, to: string, file = DECISIONS_FILE): DecisionRecord[] {
  const out: DecisionRecord[] = [];
  for (const f of [`${file}.1`, file]) {
    let text: string;
    try {
      text = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      try {
        const r = JSON.parse(line) as DecisionRecord;
        if (typeof r.at === "string" && r.at >= from && r.at <= to) {
          out.push(r);
        }
      } catch {
        // blank or torn
      }
    }
  }
  return out;
}
