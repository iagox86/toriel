// Friendly time parsing for the scheduling commands (docs/design.md item 10).
// `parseWhen` reads a time spec off the front of a word list - "90m", "at
// tomorrow 9am", "every weekday 9am", a 5-field cron - and returns the trigger
// it means, when it first fires, and the words it left over (the prompt). It is
// pure: `now` is passed in, and every clock time is local time. Failures are
// messages meant to be shown, each saying what to type instead.
import { CronExpressionParser } from "cron-parser";
import { fmtAge } from "./format.ts";

export type Trigger =
  | { kind: "once"; at: number }
  /** Fixed cadence counted from `anchor` (creation time), so a slow run never shifts later ones. */
  | { kind: "every"; ms: number; anchor: number }
  | { kind: "cron"; expr: string }
  /** Re-run after the previous run finishes; no gap means the model picks the next delay itself. */
  | { kind: "loop"; gapMs?: number };

/** Which command is asking: it decides what shapes are accepted. "auto" works it out (the agent tool). */
export type WhenMode = "auto" | "in" | "at" | "every" | "cron" | "loop";

export interface ParsedWhen {
  ok: true;
  trigger: Trigger;
  /** Epoch ms of the first fire (a self-paced loop runs at once). */
  first: number;
  /** The words after the time spec: the prompt. */
  rest: string[];
  /** Things worth telling the user about how the input was read ("rolled to tomorrow"). */
  notes: string[];
}
export type WhenResult = ParsedWhen | { ok: false; error: string };

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
const UNIT_WORDS = /^(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?)$/;
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const EXAMPLES = 'try "90m", "at 14:30", "every 2h", "every weekday 9am", or a cron like "*/15 * * * *"';

type Step<T> = { ok: true; value: T; used: number } | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** "1h30m", "90m", "1.5h" -> ms; undefined when the token is not entirely a duration. */
function compoundMs(token: string): number | undefined {
  const parts = [...token.toLowerCase().matchAll(/(\d+(?:\.\d+)?)([smhdw])/g)];
  if (parts.length === 0 || parts.map((p) => p[0]).join("") !== token.toLowerCase()) {
    return undefined;
  }
  return Math.round(parts.reduce((sum, p) => sum + Number(p[1]) * (UNIT_MS[p[2] ?? ""] ?? 0), 0));
}

/** A duration at the front of `words`: "90m", "1h30m", or "2 hours". */
function duration(words: string[]): Step<number> | undefined {
  const first = words[0] ?? "";
  const compound = compoundMs(first);
  if (compound !== undefined) {
    return compound > 0 ? { ok: true, value: compound, used: 1 } : fail("a duration must be more than zero");
  }
  const unit = (words[1] ?? "").toLowerCase();
  if (/^\d+(\.\d+)?$/.test(first) && UNIT_WORDS.test(unit)) {
    const ms = Math.round(Number(first) * (UNIT_MS[unit[0] === "s" ? "s" : unit.startsWith("mi") ? "m" : unit[0] ?? ""] ?? 0));
    return ms > 0 ? { ok: true, value: ms, used: 2 } : fail("a duration must be more than zero");
  }
  return undefined;
}

interface Clock {
  h: number;
  m: number;
}

/** "14:30", "9am", "5:15pm", "noon". A bare "5" is refused: it could be either 5am or 5pm. */
function clock(token: string): { ok: true; value: Clock } | { ok: false; error: string } {
  const t = token.toLowerCase();
  if (t === "noon") {
    return { ok: true, value: { h: 12, m: 0 } };
  }
  if (t === "midnight") {
    return { ok: true, value: { h: 0, m: 0 } };
  }
  const match = /^(\d{1,2})(?::(\d{2}))?(am|pm)?$/.exec(t);
  if (!match) {
    return fail(`cannot read "${token}" as a time of day; ${EXAMPLES}`);
  }
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const suffix = match[3];
  if (minute > 59) {
    return fail(`"${token}" is not a time of day (minutes go to 59)`);
  }
  if (suffix) {
    if (hour < 1 || hour > 12) {
      return fail(`"${token}" is not a time of day (${suffix} hours are 1-12)`);
    }
    return { ok: true, value: { h: (hour % 12) + (suffix === "pm" ? 12 : 0), m: minute } };
  }
  if (match[2] === undefined) {
    return fail(`"${token}" is ambiguous - try "${hour}:00" for 24-hour time, or "${hour}am" / "${hour}pm"`);
  }
  if (hour > 23) {
    return fail(`"${token}" is not a time of day (hours go to 23)`);
  }
  return { ok: true, value: { h: hour, m: minute } };
}

type Day = { kind: "today" } | { kind: "tomorrow" } | { kind: "weekday"; dow: number } | { kind: "date"; y: number; mo: number; d: number };

function weekdayIndex(word: string): number | undefined {
  const i = WEEKDAYS.indexOf(word.toLowerCase().replace(/s$/, "").slice(0, 3));
  const full = /^(sun|mon|tues?|wed(nes)?|thu(rs?)?|fri|sat(ur)?)(day)?s?$/.test(word.toLowerCase());
  return full && i !== -1 ? i : undefined;
}

function dayWord(word: string): Day | undefined {
  const w = word.toLowerCase();
  if (w === "today") {
    return { kind: "today" };
  }
  if (w === "tomorrow") {
    return { kind: "tomorrow" };
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(w);
  if (iso) {
    return { kind: "date", y: Number(iso[1]), mo: Number(iso[2]) - 1, d: Number(iso[3]) };
  }
  const dow = weekdayIndex(w);
  return dow === undefined ? undefined : { kind: "weekday", dow };
}

/** The moment "day at time" falls on, relative to `now`; the notes say when it had to move. */
function resolveClock(day: Day | undefined, at: Clock, now: Date): { ok: true; ms: number; notes: string[] } | { ok: false; error: string } {
  const on = (offset: number): Date => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, at.h, at.m, 0, 0);
  const label = `${String(at.h).padStart(2, "0")}:${String(at.m).padStart(2, "0")}`;
  const notes: string[] = [];
  let when: Date;
  if (day === undefined) {
    when = on(0);
    if (when.getTime() <= now.getTime()) {
      when = on(1);
      notes.push(`${label} has already passed today, so this is tomorrow`);
    }
  } else if (day.kind === "today") {
    when = on(0);
    if (when.getTime() <= now.getTime()) {
      return fail(`${label} has already passed today - try "tomorrow ${label}"`);
    }
  } else if (day.kind === "tomorrow") {
    when = on(1);
  } else if (day.kind === "weekday") {
    let delta = (day.dow - now.getDay() + 7) % 7;
    if (delta === 0 && on(0).getTime() <= now.getTime()) {
      delta = 7;
    }
    when = on(delta);
  } else {
    when = new Date(day.y, day.mo, day.d, at.h, at.m, 0, 0);
    if (when.getTime() <= now.getTime()) {
      return fail("that date and time is in the past");
    }
  }
  return { ok: true, ms: when.getTime(), notes };
}

/** `at`-style: [at] [today|tomorrow|mon|2026-11-02] [at] <time>. */
function atSpec(words: string[], now: Date): Step<{ ms: number; notes: string[] }> {
  let i = words[0]?.toLowerCase() === "at" ? 1 : 0;
  const day = dayWord(words[i] ?? "");
  if (day) {
    i += 1;
  }
  if (words[i]?.toLowerCase() === "at") {
    i += 1;
  }
  const token = words[i];
  if (token === undefined) {
    return fail(day ? `a day needs a time: "at ${words[i - 1] ?? "tomorrow"} 9am"` : `no time given; ${EXAMPLES}`);
  }
  const at = clock(token);
  if (!at.ok) {
    return at;
  }
  const when = resolveClock(day, at.value, now);
  return when.ok ? { ok: true, value: { ms: when.ms, notes: when.notes }, used: i + 1 } : when;
}

const DOW_FIELD: Record<string, string> = { weekday: "1-5", weekend: "0,6" };

/** `every`-style: <duration> | hour | day|weekday|weekend|<weekday> [at] <time>. Cadences become a cron expression. */
function everySpec(words: string[]): Step<Trigger> | undefined {
  const dur = duration(words);
  if (dur) {
    return dur.ok ? { ok: true, value: { kind: "every", ms: dur.value, anchor: 0 }, used: dur.used } : dur;
  }
  const head = (words[0] ?? "").toLowerCase().replace(/s$/, "");
  if (head === "hour" || head === "minute" || head === "week") {
    return { ok: true, value: { kind: "every", ms: UNIT_MS[head[0] ?? ""] ?? 0, anchor: 0 }, used: 1 };
  }
  const dow = head === "day" || head === "daily" ? "*" : (DOW_FIELD[head] ?? (weekdayIndex(head) === undefined ? undefined : String(weekdayIndex(head))));
  if (dow === undefined) {
    return undefined;
  }
  let i = 1;
  if (words[i]?.toLowerCase() === "at") {
    i += 1;
  }
  const token = words[i];
  if (token === undefined) {
    return fail(`"every ${words[0]}" needs a time of day: "every ${words[0]} 9am"`);
  }
  const at = clock(token);
  if (!at.ok) {
    return at;
  }
  return { ok: true, value: { kind: "cron", expr: `${at.value.m} ${at.value.h} * * ${dow}` }, used: i + 1 };
}

const CRON_FIELD = /^[0-9*/,\-?LW#a-zA-Z]+$/;

function looksLikeCron(words: string[]): boolean {
  return words.length >= 5 && words.slice(0, 5).every((w) => CRON_FIELD.test(w) && /[0-9*]/.test(w));
}

/** A standalone duration ("3d", "90 minutes") for flags like --expires; the whole text must be one. */
export function parseDurationText(text: string): { ok: true; ms: number } | { ok: false; error: string } {
  const words = text.trim().split(/\s+/);
  const d = duration(words);
  if (!d || (d.ok && d.used !== words.length)) {
    return fail(`cannot read "${text}" as a duration; try 3d, 12h or "90 minutes"`);
  }
  return d.ok ? { ok: true, ms: d.value } : d;
}

/** The next time a cron expression fires after `from`. */
export function cronNext(expr: string, from: number): number | undefined {
  try {
    return CronExpressionParser.parse(expr, { currentDate: new Date(from) }).next().getTime();
  } catch {
    return undefined;
  }
}

function cronSpec(words: string[], now: Date): Step<Trigger> {
  const fields = words.slice(0, 5);
  if (fields.length < 5) {
    return fail('a cron expression has five fields: minute hour day-of-month month day-of-week, e.g. "*/15 * * * *"');
  }
  const expr = fields.join(" ");
  try {
    CronExpressionParser.parse(expr, { currentDate: now });
  } catch (err) {
    return fail(`not a valid cron expression (${expr}): ${err instanceof Error ? err.message : String(err)}`);
  }
  return { ok: true, value: { kind: "cron", expr }, used: 5 };
}

/**
 * Read the time spec at the front of `words`. A first word holding spaces (a
 * quoted "*\/15 * * * *") is split first. With mode "auto" the spec's own shape
 * decides ("in 5m", "at 9am", "every 2h", a bare duration, clock time or cron).
 */
export function parseWhen(input: string[], now: Date, mode: WhenMode = "auto"): WhenResult {
  const words = input.length > 0 && /\s/.test(input[0] ?? "") ? [...(input[0] ?? "").split(/\s+/).filter(Boolean), ...input.slice(1)] : [...input];
  const lead = (words[0] ?? "").toLowerCase();
  let m = mode;
  let body = words;
  if (m === "auto") {
    if (lead === "in" || lead === "at" || lead === "every" || lead === "loop" || lead === "cron") {
      m = lead;
      body = lead === "at" ? words : words.slice(1);
    } else if (looksLikeCron(words)) {
      m = "cron";
    } else if (duration(words)) {
      m = "in";
    } else {
      m = "at";
    }
  }
  const finish = (trigger: Trigger, first: number, used: number, notes: string[] = []): ParsedWhen => ({
    ok: true,
    trigger,
    first,
    rest: body.slice(used),
    notes,
  });
  const t = now.getTime();

  if (m === "in") {
    const skip = body[0]?.toLowerCase() === "in" ? 1 : 0;
    const dur = duration(body.slice(skip));
    if (!dur) {
      return fail(`"/in" needs a delay like 90m, 2h or "45 minutes"; for a clock time use /at`);
    }
    return dur.ok ? finish({ kind: "once", at: t + dur.value }, t + dur.value, skip + dur.used) : dur;
  }
  if (m === "at") {
    const spec = atSpec(body, now);
    return spec.ok ? finish({ kind: "once", at: spec.value.ms }, spec.value.ms, spec.used, spec.value.notes) : spec;
  }
  if (m === "every") {
    const skip = body[0]?.toLowerCase() === "every" ? 1 : 0;
    const spec = everySpec(body.slice(skip));
    if (!spec) {
      return fail(`cannot read "${body.slice(skip, skip + 2).join(" ")}" as a repeat interval; ${EXAMPLES}`);
    }
    if (!spec.ok) {
      return spec;
    }
    const trigger: Trigger = spec.value.kind === "every" ? { ...spec.value, anchor: t } : spec.value;
    const first = nextFire(trigger, t);
    return first === undefined ? fail("that schedule never fires") : finish(trigger, first, skip + spec.used);
  }
  if (m === "cron") {
    const spec = cronSpec(body, now);
    if (!spec.ok) {
      return spec;
    }
    const first = spec.value.kind === "cron" ? cronNext(spec.value.expr, t) : undefined;
    return first === undefined ? fail("that cron expression never fires") : finish(spec.value, first, spec.used);
  }
  // loop: an optional gap, otherwise the model chooses each next delay
  const skip = body[0]?.toLowerCase() === "every" ? 1 : 0;
  const dur = duration(body.slice(skip));
  if (!dur) {
    return finish({ kind: "loop" }, t, 0);
  }
  return dur.ok ? finish({ kind: "loop", gapMs: dur.value }, t, skip + dur.used) : dur;
}

/**
 * When a trigger fires next, strictly after `from` (for a loop, `from` is when
 * the last run finished). Undefined: a one-shot already past, or a self-paced
 * loop (the model decides).
 */
export function nextFire(trigger: Trigger, from: number): number | undefined {
  switch (trigger.kind) {
    case "once":
      return trigger.at > from ? trigger.at : undefined;
    case "every":
      return trigger.anchor + (Math.floor((from - trigger.anchor) / trigger.ms) + 1) * trigger.ms;
    case "cron":
      return cronNext(trigger.expr, from);
    case "loop":
      return trigger.gapMs === undefined ? undefined : from + trigger.gapMs;
  }
}

/** "30m", "1h30m", "2d": a duration in the shortest exact form the parser reads back. */
export function fmtDuration(ms: number): string {
  let left = Math.round(ms / 1000);
  let out = "";
  for (const [unit, size] of [["d", 86_400], ["h", 3_600], ["m", 60], ["s", 1]] as const) {
    if (left >= size) {
      out += `${Math.floor(left / size)}${unit}`;
      left %= size;
    }
  }
  return out || "0s";
}

/** What a trigger does, in words: "every 30m", "daily 09:00", "once at ...". */
export function describeTrigger(trigger: Trigger, now: Date = new Date()): string {
  switch (trigger.kind) {
    case "once":
      return `once, ${fmtClock(trigger.at, now)}`;
    case "every":
      return `every ${fmtDuration(trigger.ms)}`;
    case "cron":
      return `cron ${trigger.expr}`;
    case "loop":
      return trigger.gapMs === undefined ? "loop, self-paced" : `loop, ${fmtDuration(trigger.gapMs)} after each run`;
  }
}

/** "14:05", "tomorrow 09:00", "Mon 09:00", or "Nov 12 09:00": a time with just enough date to be unambiguous. */
export function fmtClock(ms: number, now: Date): string {
  const d = new Date(ms);
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86_400_000);
  if (days === 0) {
    return hhmm;
  }
  if (days === 1) {
    return `tomorrow ${hhmm}`;
  }
  if (days > 1 && days < 7) {
    return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]} ${hhmm}`;
  }
  return `${d.toLocaleString("en-US", { month: "short" })} ${d.getDate()} ${hhmm}`;
}

/** `fmtClock` for tight spaces: "tmrw 09:00" for "tomorrow 09:00". */
export function fmtClockShort(ms: number, now: Date): string {
  return fmtClock(ms, now).replace("tomorrow", "tmrw");
}

/** "14:05 (in 12m)": a fire time with how far away it is. */
export function fmtNext(ms: number, now: Date): string {
  return `${fmtClock(ms, now)} (in ${fmtAge(Math.max(0, ms - now.getTime()))})`;
}
