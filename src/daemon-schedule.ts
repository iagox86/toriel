// The daemon's side of scheduling (docs/design.md item 10): the host the
// Scheduler runs against, and the handlers for the schedule_* commands. The
// Scheduler itself is pure; this file is where a fire becomes a prompt in a
// session, and where a person's or an agent's command becomes a schedule.
import type { Cmd, DaemonContext, Responder } from "./daemon-context.ts";
import { deliverToTarget } from "./daemon-handlers-messages.ts";
import { findSession } from "./daemon-resolve.ts";
import { execFile } from "node:child_process";
import { log } from "./log.ts";
import { formatScheduled } from "./schedule-label.ts";
import type { EndReason, Schedule, SchedulerEvent, SchedulerHost } from "./scheduler.ts";
import { loadSettings } from "./settings.ts";
import type { ScheduleView, UsageReport } from "./shared.ts";
import { describeTrigger, fmtClock, fmtDuration, fmtNext, nextFire, parseDurationText, parseWhen } from "./when.ts";

/** Added to a self-paced /loop's prompt: the loop only continues if the model schedules the next run. */
const SELF_PACED_FOOTER = '\n\n(Self-paced loop: when this pass is done, if more is needed call toriel_schedule_create with `when` set to how long to wait (for example "in 20m"; prefer long waits) and this same prompt, so the loop continues. If you do not, the loop ends here.)';

/** Scheduled runs pause when a usage window of the session's provider reaches this percent (setting scheduleUsagePause; 0 = never). */
const DEFAULT_USAGE_PAUSE = 95;

/** Fires later than this are labelled late in the prompt. */
const LATE_AFTER_MS = 60_000;

/** The host the daemon's Scheduler runs against; `ctx` is late-bound because the Scheduler is part of the context. */
export function schedulerHost(ctx: () => DaemonContext, usage: ReadonlyMap<string, UsageReport>): SchedulerHost {
  return {
    now: () => Date.now(),
    setTimer: (fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref();
      return t;
    },
    clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
    ready: (uuid) => {
      const c = ctx();
      const s = c.registry.all().find((x) => x.sessionId === uuid);
      if (!s) {
        return true; // only a file: delivery starts it
      }
      const external = s.sessionFile !== undefined && c.presence.has(s.sessionFile);
      return !s.streaming && !s.compacting && !s.pendingDialog && !s.held && !s.spawning && !external;
    },
    budget: (uuid) => {
      const limit = loadSettings().settings.scheduleUsagePause ?? DEFAULT_USAGE_PAUSE;
      const provider = ctx().registry.all().find((x) => x.sessionId === uuid)?.provider;
      const report = provider ? usage.get(provider) : undefined;
      if (!limit || !report) {
        return undefined;
      }
      const now = Date.now();
      const hot = report.windows.find((w) => w.pct >= limit && (w.resetsAt === undefined || w.resetsAt > now));
      return hot ? `${report.provider} ${hot.label} usage is ${Math.round(hot.pct)}% (scheduled runs pause at ${limit}%)${hot.resetsAt ? `; resets ${fmtClock(hot.resetsAt, new Date(now))}` : ""}` : undefined;
    },
    check: async (schedule) => {
      const c = ctx();
      const cmd = schedule.until ?? schedule.while;
      if (cmd === undefined) {
        return "go";
      }
      const cwd = c.registry.all().find((x) => x.sessionId === schedule.session)?.cwd ?? (await findSession(c, schedule.session).then((f) => f.cwd).catch(() => undefined));
      const passed = await runCheck(cmd, cwd);
      if (passed === undefined) {
        return "wait";
      }
      return schedule.until !== undefined ? (passed ? "go" : "wait") : passed ? "go" : "stop";
    },
    deliver: async (schedule, info) => {
      const c = ctx();
      const target = await findSession(c, schedule.session);
      const late = info.lateBy > LATE_AFTER_MS ? fmtDuration(info.lateBy) : undefined;
      const paced = schedule.trigger.kind === "loop" && schedule.trigger.gapMs === undefined;
      await deliverToTarget(c, target, formatScheduled({ id: schedule.id, name: schedule.name, run: info.run, max: schedule.max, late }, paced ? `${schedule.prompt}${SELF_PACED_FOOTER}` : schedule.prompt));
    },
    event: (e) => {
      logEvent(e);
      announce(ctx(), e);
    },
  };
}

const END_TEXT: Partial<Record<EndReason, string>> = { expired: "expired", max: "finished its last run", cancelled: "cancelled", condition: "ended: its --while check stopped holding" };

/** Tell controllers: the list changed (markers), and when a schedule ends or fails, say so in its session. */
function announce(ctx: DaemonContext, e: SchedulerEvent): void {
  if (e.type === "changed") {
    ctx.hub.broadcastSessions();
    return;
  }
  const uuid = e.schedule.session;
  const s = ctx.registry.all().find((x) => x.sessionId === uuid);
  if (!s) {
    return;
  }
  const label = `schedule #${e.schedule.id}${e.schedule.name ? ` ${e.schedule.name}` : ""}`;
  if (e.type === "ended" && END_TEXT[e.reason]) {
    ctx.hub.broadcast({ type: "notice", session: s.id, text: `${label} ${END_TEXT[e.reason]}` });
  } else if (e.type === "held") {
    ctx.hub.broadcast({ type: "notice", session: s.id, text: `${label} is waiting: ${e.reason}` });
  } else if (e.type === "failed") {
    ctx.hub.broadcast({ type: "notice", session: s.id, text: `${label} could not run: ${e.error}${e.paused ? " - paused (/resume to retry)" : ""}` });
  }
}

function logEvent(e: SchedulerEvent): void {
  if (e.type === "fired") {
    log(`schedule #${e.schedule.id} fired into session ${e.schedule.session} (run ${e.run}${e.lateBy > LATE_AFTER_MS ? `, late ${fmtDuration(e.lateBy)}` : ""})`);
  } else if (e.type === "ended") {
    log(`schedule #${e.schedule.id} ended: ${e.reason}`);
  } else if (e.type === "held") {
    log(`schedule #${e.schedule.id} held: ${e.reason}`);
  } else if (e.type === "failed") {
    log(`schedule #${e.schedule.id} could not fire: ${e.error}${e.paused ? " (paused after repeated failures)" : ""}`);
  }
}

const CHECK_TIMEOUT_MS = 30_000;

/** Run a shell check in the session's directory: true = exit 0, false = a non-zero exit, undefined = it could not run or timed out (the caller waits). */
function runCheck(cmd: string, cwd: string | undefined): Promise<boolean | undefined> {
  return new Promise((resolve) => {
    execFile("sh", ["-c", cmd], { cwd, timeout: CHECK_TIMEOUT_MS, windowsHide: true }, (err) => {
      if (!err) {
        resolve(true);
      } else if (typeof (err as { code?: unknown }).code === "number" && !(err as { killed?: boolean }).killed) {
        resolve(false);
      } else {
        log(`schedule check "${cmd}" could not run: ${err.message}`);
        resolve(undefined);
      }
    });
  });
}

/** The UUID a command's `session` (daemon number) or `uuid` names; undefined when it names neither. */
function scopeOf(ctx: DaemonContext, cmd: { session?: number; uuid?: string }): string | undefined {
  if (cmd.uuid) {
    return cmd.uuid;
  }
  if (cmd.session === undefined) {
    return undefined;
  }
  const uuid = ctx.registry.get(cmd.session)?.sessionId;
  if (!uuid) {
    throw new Error("this session has no id yet - send it a message first");
  }
  return uuid;
}

export function viewOf(ctx: DaemonContext, s: Schedule, now: Date = new Date()): ScheduleView {
  return {
    id: s.id,
    session: s.session,
    sessionName: ctx.registry.all().find((x) => x.sessionId === s.session)?.sessionName,
    name: s.name,
    prompt: s.prompt,
    when: describeTrigger(s.trigger, now),
    state: s.state,
    next: s.state === "active" ? s.nextFire : undefined,
    fired: s.fired,
    max: s.max,
    expiresAt: s.expiresAt,
    by: s.by,
    catchup: s.catchup,
    lastFire: s.lastFire,
    lastError: s.lastError,
    until: s.until,
    while: s.while,
    held: ctx.scheduler.heldReason(s.id),
  };
}

/** One line telling someone what a new schedule will do, with its real next fire. */
function echoOf(s: Schedule, now: Date): string {
  const first = s.trigger.kind === "loop" ? "first run now" : `next ${s.nextFire === undefined ? "?" : fmtNext(s.nextFire, now)}`;
  const parts = [`#${s.id}${s.name ? ` ${s.name}` : ""}: ${describeTrigger(s.trigger, now)}, ${first}`];
  parts.push(s.expiresAt === null ? "never expires" : `expires ${fmtClock(s.expiresAt, now)}`);
  if (s.max !== undefined) {
    parts.push(`max ${s.max}`);
  }
  if (s.until !== undefined) {
    parts.push(`until \`${s.until}\` succeeds`);
  }
  if (s.while !== undefined) {
    parts.push(`while \`${s.while}\` succeeds`);
  }
  return parts.join(", ");
}

export async function handleScheduleAdd(ctx: DaemonContext, cmd: Cmd<"schedule_add">, res: Responder): Promise<void> {
  const uuid = scopeOf(ctx, cmd);
  if (!uuid) {
    throw new Error("a schedule needs a session");
  }
  const now = new Date();
  const parsed = parseWhen(cmd.when, now, cmd.mode);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  if (cmd.prompt !== undefined && parsed.rest.length > 0) {
    throw new Error(`cannot read "${parsed.rest.join(" ")}" as part of the time; put the text to send in the prompt`);
  }
  const prompt = (cmd.prompt ?? parsed.rest.join(" ")).trim();
  if (!prompt) {
    throw new Error("what should it say? Add the prompt after the time, e.g. /in 90m check the build");
  }
  let expiresIn: number | null | undefined;
  if (cmd.expires !== undefined) {
    if (cmd.expires.trim().toLowerCase() === "never") {
      expiresIn = null;
    } else {
      const d = parseDurationText(cmd.expires);
      if (!d.ok) {
        throw new Error(d.error);
      }
      expiresIn = d.ms;
    }
  }
  if (cmd.dryRun) {
    const fires = [parsed.first];
    while (fires.length < 3 && parsed.trigger.kind !== "once" && parsed.trigger.kind !== "loop") {
      const next = nextFire(parsed.trigger, fires[fires.length - 1] as number);
      if (next === undefined) {
        break;
      }
      fires.push(next);
    }
    res(true, undefined, { dryRun: true, when: describeTrigger(parsed.trigger, now), fires, notes: parsed.notes, echo: `would run ${fires.map((f) => fmtNext(f, now)).join(", then ")}` });
    return;
  }
  const s = ctx.scheduler.add({
    session: uuid,
    prompt,
    trigger: parsed.trigger,
    name: cmd.name,
    max: cmd.max,
    expiresIn,
    catchup: cmd.catchup,
    by: cmd.by,
    until: cmd.until,
    while: cmd.while,
  });
  log(`schedule #${s.id} created (${describeTrigger(s.trigger, now)}, ${s.by}) for session ${uuid}`);
  res(true, undefined, { schedule: viewOf(ctx, s, now), notes: parsed.notes, echo: echoOf(s, now) });
}

export async function handleScheduleList(ctx: DaemonContext, cmd: Cmd<"schedule_list">, res: Responder): Promise<void> {
  const now = new Date();
  res(true, undefined, { schedules: ctx.scheduler.list(scopeOf(ctx, cmd)).map((s) => viewOf(ctx, s, now)) });
}

/** The schedules `ref` names within `scope` (a session, or everyone's); throws on no match or an ambiguous name. */
function pick(ctx: DaemonContext, scope: string | undefined, ref: string): Schedule[] {
  const inScope = ctx.scheduler.list(scope);
  const key = ref.trim().replace(/^#/, "");
  if (/^\d+$/.test(key)) {
    const hit = inScope.find((s) => s.id === Number(key));
    if (!hit) {
      throw new Error(`no schedule #${key}${scope ? " in this session" : ""} (a one-shot is removed once it has run; /schedules lists the rest)`);
    }
    return [hit];
  }
  const named = inScope.filter((s) => s.name === key);
  if (named.length === 0) {
    throw new Error(`no schedule named "${key}"${scope ? " in this session" : ""} (a one-shot is removed once it has run; /schedules lists the rest)`);
  }
  if (named.length > 1) {
    throw new Error(`${named.length} schedules are named "${key}" (ids ${named.map((s) => `#${s.id}`).join(", ")}) - use the id`);
  }
  return named;
}

export async function handleScheduleOp(ctx: DaemonContext, cmd: Cmd<"schedule_op">, res: Responder): Promise<void> {
  const scope = scopeOf(ctx, cmd);
  let targets: Schedule[];
  if (cmd.all) {
    targets = ctx.scheduler.list(scope);
  } else if (cmd.ref) {
    targets = pick(ctx, scope, cmd.ref);
  } else {
    throw new Error(`${cmd.op} which schedule? Give an id or name (/schedules lists them)${scope ? ", or --all" : ""}`);
  }
  if (cmd.op === "fire" && targets.length !== 1) {
    throw new Error("fire takes exactly one schedule");
  }
  const now = new Date();
  const views = targets.map((s) => viewOf(ctx, s, now));
  for (const s of targets) {
    if (cmd.op === "cancel") {
      ctx.scheduler.cancel(s.id);
    } else if (cmd.op === "pause") {
      ctx.scheduler.pause(s.id);
    } else if (cmd.op === "resume") {
      ctx.scheduler.resume(s.id);
    } else {
      await ctx.scheduler.fireNow(s.id);
    }
  }
  log(`schedule ${cmd.op}: ${targets.map((s) => `#${s.id}`).join(", ") || "(none)"}`);
  res(true, undefined, { schedules: views, count: targets.length });
}
