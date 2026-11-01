// The controller side of /in /at /every /loop /cron /schedules /cancel /pause
// /resume /fire. The daemon does the parsing and owns the schedules; these
// functions turn a parsed command into a request and its answer into a notice
// or panel. Shared by the session and switcher command tables.
import type { Invocation } from "./cli.ts";
import type { Host } from "./host.ts";
import { scheduleLabel, scheduleListing, scheduleChoice } from "./schedule-format.ts";
import type { ScheduleView } from "./shared.ts";
import { errText } from "./util.ts";
import type { WhenMode } from "./when.ts";

type Op = "pause" | "resume" | "fire" | "cancel";
const PAST: Record<Op, string> = { pause: "paused", resume: "resumed", fire: "fired", cancel: "cancelled" };

/** Create a schedule in the session with daemon number `session`. */
export async function addSchedule(h: Host, command: string, mode: WhenMode, call: Invocation, session: number | undefined): Promise<void> {
  if (session === undefined) {
    h.notify(`/${command}: send a message first - a schedule needs a saved session`);
    return;
  }
  const max = call.opts.max === undefined ? undefined : Number(call.opts.max);
  if (max !== undefined && (!Number.isInteger(max) || max < 1)) {
    h.notify(`/${command}: --max wants a whole number of runs, like --max 5`);
    return;
  }
  const catchup = call.opts.catchup as string | undefined;
  if (catchup !== undefined && catchup !== "once" && catchup !== "skip") {
    h.notify(`/${command}: --catchup is "once" or "skip"`);
    return;
  }
  try {
    const r = (await h.request({
      type: "schedule_add",
      session,
      mode,
      when: call.args,
      name: call.opts.name as string | undefined,
      max,
      expires: call.opts.expires as string | undefined,
      catchup,
      dryRun: call.opts.dryRun === true,
      until: call.opts.until as string | undefined,
      while: call.opts.while as string | undefined,
    })) as { echo: string; notes?: string[] };
    h.notify([r.echo, ...(r.notes ?? [])].join(" - "));
  } catch (err) {
    h.notify(`/${command}: ${errText(err)}`);
  }
}

/** pause / resume / cancel / fire the schedule named in the call; `session` narrows it to one session's. */
export async function operateSchedule(h: Host, command: Op, call: Invocation, session: number | undefined): Promise<void> {
  if (call.args[0] === undefined && call.opts.all !== true) {
    await pickSchedule(h, command, session);
    return;
  }
  try {
    const r = (await h.request({ type: "schedule_op", op: command, ref: call.args[0], all: call.opts.all === true, session })) as { schedules: ScheduleView[]; count: number };
    if (r.count === 0) {
      h.notify(`no schedules to ${command}`);
    } else if (r.count === 1) {
      h.notify(`${PAST[command]} ${scheduleLabel(r.schedules[0] as ScheduleView)}`);
    } else {
      h.notify(`${PAST[command]} ${r.count} schedules`);
    }
  } catch (err) {
    h.notify(`/${command}: ${errText(err)}`);
  }
}

/** With no schedule named: a dropdown of the schedules in scope; picking one runs the command on it. */
async function pickSchedule(h: Host, command: Op, session: number | undefined): Promise<void> {
  try {
    const r = (await h.request({ type: "schedule_list", session })) as { schedules: ScheduleView[] };
    const now = new Date();
    const usable = command === "resume" ? r.schedules.filter((s) => s.state === "paused") : command === "pause" ? r.schedules.filter((s) => s.state === "active") : r.schedules;
    if (usable.length === 0) {
      h.notify(r.schedules.length === 0 ? "no schedules (/every, /in, /at, /loop, /cron create them)" : `no schedules to ${command}`);
      return;
    }
    const byLabel = new Map(usable.map((s) => [scheduleChoice(s, now, session === undefined), s.id]));
    h.choicePanel.open(`${command[0]?.toUpperCase()}${command.slice(1)} which schedule?`, [...byLabel.keys()], undefined, (choice) => {
      const id = byLabel.get(choice);
      if (id !== undefined) {
        void operateSchedule(h, command, { args: [String(id)], opts: {} }, session);
      }
    });
    h.tui.requestRender();
  } catch (err) {
    h.notify(`/${command}: ${errText(err)}`);
  }
}

/** Open the listing: one session's schedules, or everyone's. */
export async function showSchedules(h: Host, session: number | undefined): Promise<void> {
  try {
    const r = (await h.request({ type: "schedule_list", session })) as { schedules: ScheduleView[] };
    if (r.schedules.length === 0) {
      h.notify(session === undefined ? "no schedules (in a session: /every 30m <prompt>, /in 90m <prompt>, /schedules --help)" : "no schedules in this session - try /every 30m <prompt> or /in 90m <prompt> (/schedules --all lists every session's)");
      return;
    }
    h.infoPanel.show(scheduleListing(r.schedules, new Date(), session === undefined));
    h.tui.requestRender();
  } catch (err) {
    h.notify(`/schedules: ${errText(err)}`);
  }
}
