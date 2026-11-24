// `toriel --timing` (ticket 225): an opt-in log of the moments that felt slow, so the next one explains itself. Off, every call here is
// a cheap no-op. On, an event that takes longer than the threshold (150 ms, TORIEL_TIMING_MS) becomes one JSON line in timing.jsonl in the
// state directory, with what else was going on: items on screen, whether the session was streaming, the
// load average and the CPU the process used meanwhile. That is what separates "the session is big" from "a run was streaming" from
// "the machine was busy" (the 2026-11-15 slowdown that was gone minutes later). The controller and the daemon both write to the file
// (`proc` says which); the flag sets TORIEL_TIMING=1, which the daemon the controller starts inherits.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { STATE_DIR } from "./config.ts";

export const DEFAULT_THRESHOLD_MS = 150;
/** The file is moved aside (to .1) once it passes this, so a long-lived --timing run cannot fill the disk. */
export const MAX_BYTES = 2 * 1024 ** 2;
/** Renders slower than the threshold are logged at most this often: while a reply streams, every frame can be slow. */
const RENDER_EVERY_MS = 1000;
/** A key press this recent is where a pending event started (the handler runs before the render it asks for). */
const STAMP_MAX_AGE_MS = 2000;

export interface TimingOptions {
  enabled: boolean;
  file: string;
  thresholdMs: number;
  proc: string;
  now?: () => number;
  write?: (line: string) => void;
  /** What else was going on, added to every line (tests pin it). */
  context?: () => Record<string, number>;
}

interface Pending {
  event: string;
  start: number;
  cpu: NodeJS.CpuUsage;
  fields: Record<string, unknown>;
}

export class Timing {
  readonly enabled: boolean;
  private readonly opts: TimingOptions;
  private readonly now: () => number;
  private readonly pending: Pending[] = [];
  private stampAt = -Infinity;
  private lastRenderLog = -Infinity;
  /** Rotation is checked on this process's first write only: a mid-run write past the limit keeps appending until the next start. */
  private rotated = false;

  constructor(opts: TimingOptions) {
    this.opts = opts;
    this.enabled = opts.enabled;
    this.now = opts.now ?? (() => performance.now());
  }

  /** Remember that input arrived now: an event begun within a moment is timed from here. */
  stamp(): void {
    if (this.enabled) {
      this.stampAt = this.now();
    }
  }

  /** Time `fn` (synchronous) and log it when slow. */
  time<T>(event: string, fields: Record<string, unknown>, fn: () => T): T {
    if (!this.enabled) {
      return fn();
    }
    const start = this.now();
    const cpu = process.cpuUsage();
    try {
      return fn();
    } finally {
      this.finish({ event, start, cpu, fields });
    }
  }

  /** Time `fn` (asynchronous) and log it when slow. */
  async timeAsync<T>(event: string, fields: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
    if (!this.enabled) {
      return fn();
    }
    const start = this.now();
    const cpu = process.cpuUsage();
    try {
      return await fn();
    } finally {
      this.finish({ event, start, cpu, fields });
    }
  }

  /** Something the user asked for happened (a toggle, a switch): it is over when the next frame has been drawn, see `rendered`. */
  begin(event: string, fields: Record<string, unknown> = {}): void {
    if (!this.enabled) {
      return;
    }
    const t = this.now();
    this.pending.push({ event, start: t - this.stampAt <= STAMP_MAX_AGE_MS ? this.stampAt : t, cpu: process.cpuUsage(), fields });
  }

  /** A frame was drawn, taking `renderMs`: closes what `begin` opened, and logs a slow frame of its own (rarely). */
  rendered(renderMs: number, fields: Record<string, unknown> = {}): void {
    if (!this.enabled) {
      return;
    }
    const closed = this.pending.splice(0);
    for (const p of closed) {
      this.finish({ ...p, fields: { ...p.fields, ...fields, render_ms: round(renderMs) } });
    }
    const t = this.now();
    // A frame that closed an event is already in the log as that event (with render_ms); it gets no line of its own.
    if (closed.length === 0 && renderMs >= this.opts.thresholdMs && t - this.lastRenderLog >= RENDER_EVERY_MS) {
      this.lastRenderLog = t;
      this.write({ event: "render", ms: round(renderMs), ...fields, ...this.around(process.cpuUsage(), renderMs) });
    }
  }

  private finish(p: Pending): void {
    const ms = this.now() - p.start;
    if (ms >= this.opts.thresholdMs) {
      this.write({ event: p.event, ms: round(ms), ...p.fields, ...this.around(p.cpu, ms) });
    }
  }

  /** What else was going on: CPU used by this process during the event, load average, memory (event-loop lateness was tried and dropped: a stalled loop reports it only after the event is over, and it read its ~20 ms floor through 2 s stalls). */
  private around(cpu: NodeJS.CpuUsage, _ms: number): Record<string, number> {
    if (this.opts.context) {
      return this.opts.context();
    }
    const used = process.cpuUsage(cpu);
    return { cpu_ms: round((used.user + used.system) / 1000), load1: round(os.loadavg()[0] ?? 0), rss_mb: Math.round(process.memoryUsage.rss() / 1024 ** 2) };
  }

  private write(record: Record<string, unknown>): void {
    const line = `${JSON.stringify({ at: new Date().toISOString(), proc: this.opts.proc, pid: process.pid, ...record })}\n`;
    try {
      if (this.opts.write) {
        this.opts.write(line);
        return;
      }
      if (!this.rotated) {
        this.rotated = true;
        fs.mkdirSync(path.dirname(this.opts.file), { recursive: true });
        if ((fs.statSync(this.opts.file, { throwIfNoEntry: false })?.size ?? 0) > MAX_BYTES) {
          fs.renameSync(this.opts.file, `${this.opts.file}.1`);
        }
      }
      fs.appendFileSync(this.opts.file, line);
    } catch {
      // a diagnostic must never be the thing that breaks
    }
  }
}

const round = (n: number): number => Math.round(n * 10) / 10;

/** The process's own: on when `toriel --timing` (or TORIEL_TIMING=1) started it. */
export function timingFromEnv(env: NodeJS.ProcessEnv, proc: string): Timing {
  const ms = Number(env.TORIEL_TIMING_MS);
  return new Timing({
    enabled: env.TORIEL_TIMING === "1",
    file: env.TORIEL_TIMING_FILE ?? path.join(STATE_DIR, "timing.jsonl"),
    thresholdMs: Number.isFinite(ms) && ms >= 0 && env.TORIEL_TIMING_MS ? ms : DEFAULT_THRESHOLD_MS,
    proc,
  });
}

let shared: Timing | undefined;
/** This process's timing (made on first use; `proc` names the process in the log: "controller" or "daemon"). */
export function getTiming(proc: string): Timing {
  shared ??= timingFromEnv(process.env, proc);
  return shared;
}
