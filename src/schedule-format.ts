// How schedules read in a listing (the /schedules panel) and in short form.
import { oneLineFlat } from "./format.ts";
import type { ScheduleView } from "./shared.ts";
import type { Schedule } from "./scheduler.ts";
import { describeTrigger, fmtClock, fmtClockShort, fmtNext } from "./when.ts";

/** "#3 nightly" or "#3". */
export function scheduleLabel(s: ScheduleView): string {
  return `#${s.id}${s.name ? ` ${s.name}` : ""}`;
}

function runs(s: ScheduleView): string {
  return s.max === undefined ? `${s.fired} run${s.fired === 1 ? "" : "s"}` : `run ${s.fired}/${s.max}`;
}

/** One line for a pick list: "#3 poll - every 30m, next 14:30 (in 23m)" (with the session when listing across sessions). */
export function scheduleChoice(s: ScheduleView, now: Date, showSession: boolean): string {
  const state = s.state === "paused" ? "paused" : s.next === undefined ? "waiting for a run" : `next ${fmtNext(s.next, now)}`;
  const session = showSession ? ` [${s.sessionName ?? s.session.slice(0, 8)}]` : "";
  return `${scheduleLabel(s)} - ${s.when}, ${state}${session}: ${oneLineFlat(s.prompt, 40)}`;
}

/** One schedule as a few indented lines under its label. */
function entry(s: ScheduleView, now: Date, showSession: boolean): string[] {
  const state = s.held
    ? `waiting: ${s.held}`
    : s.state === "paused"
      ? s.lastError
        ? "PAUSED after repeated failures"
        : "paused"
      : s.next === undefined
        ? s.when.startsWith("loop") ? "waiting for the current run to finish" : "-"
        : `next ${fmtNext(s.next, now)}`;
  const expiry = s.expiresAt === null ? "never expires" : `expires ${fmtClock(s.expiresAt, now)}`;
  const head = [scheduleLabel(s), s.when, state, runs(s), expiry];
  if (s.by === "agent") {
    head.push("made by the agent");
  }
  const lines = [head.join(" | "), `    ${oneLineFlat(s.prompt, 100)}`];
  if (showSession) {
    lines.splice(1, 0, `    session: ${s.sessionName ?? s.session.slice(0, 8)}`);
  }
  if (s.until !== undefined || s.while !== undefined) {
    lines.push(`    ${s.until !== undefined ? `until \`${s.until}\` succeeds` : `while \`${s.while}\` succeeds`}`);
  }
  if (s.lastError) {
    lines.push(`    last error: ${oneLineFlat(s.lastError, 100)}`);
  }
  return lines;
}

/** The text of the /schedules panel: soonest first within each session; sessions named when `showSession`. */
export function scheduleListing(schedules: ScheduleView[], now: Date, showSession: boolean): string {
  const order = [...schedules].sort((a, b) => (a.next ?? Number.MAX_SAFE_INTEGER) - (b.next ?? Number.MAX_SAFE_INTEGER) || a.id - b.id);
  return order.flatMap((s) => entry(s, now, showSession)).join("\n");
}

/** The strip above the editor: up to three active schedules, soonest first, then "+N more". Times are absolute so the line does not go stale between redraws. */
export function scheduleStripLines(schedules: Schedule[], now: Date, held: (id: number) => string | undefined = () => undefined): string[] {
  const active = schedules.filter((s) => s.state === "active").sort((a, b) => (a.nextFire ?? Number.MAX_SAFE_INTEGER) - (b.nextFire ?? Number.MAX_SAFE_INTEGER));
  const lines = active.slice(0, 3).map((s) => {
    const why = held(s.id);
    const when = why ? `waiting: ${why}` : s.nextFire === undefined ? "after the current run" : `next ${fmtClockShort(s.nextFire, now)}`;
    return `scheduled: ${s.name ?? `#${s.id}`}, ${describeTrigger(s.trigger, now)}, ${when} - ${oneLineFlat(s.prompt, 50)}`;
  });
  if (active.length > 3) {
    lines.push(`+${active.length - 3} more (/schedules)`);
  }
  return lines;
}
