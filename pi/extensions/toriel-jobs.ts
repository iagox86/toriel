// toriel jobs: lets the agent start a shell command in the background. It
// replaces pi's `bash` tool with one that has the same name (so every
// pi-permission-system `bash` rule keeps applying, with no config) plus an
// optional `run_in_background`, and adds `toriel_job` to list jobs, read their
// output and stop them. A job is a detached process group owned by this pi
// process: it is killed when the session shuts down. When it exits, the agent
// is told with a message that wakes an idle session. Runs only in children the
// toriel daemon starts (TORIEL_CHILD), so plain pi keeps its own `bash`.
import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createBashToolDefinition, getAgentDir } from "@earendil-works/pi-coding-agent";

export const CUSTOM_TYPE = "toriel-job";
export const STATUS_KEY = "toriel-jobs";
/** The extension command the daemon sends to move running foreground commands to the background. */
export const BACKGROUND_COMMAND = "toriel-background";
export const MAX_RUNNING = 5;
export const MAX_LIFETIME_MS = 2 * 60 * 60 * 1000;
/** A job's log stops growing here; the rest of its output is dropped. */
export const MAX_LOG_BYTES = 8 * 1024 * 1024;
/** What `toriel_job output` returns at most, and how much of the tail an exit notice carries. */
export const OUTPUT_LIMIT = 8000;
export const NOTICE_TAIL = 1500;
const KILL_GRACE_MS = 3000;

export type JobState = "running" | "exited" | "stopped" | "timed out";

export interface Job {
  id: string;
  command: string;
  pid: number | undefined;
  startedAt: number;
  endedAt?: number;
  state: JobState;
  exitCode?: number | null;
  signal?: string | null;
  logPath: string;
}

/** A foreground command's link to the tool call waiting for it. */
interface Foreground {
  onData(chunk: Buffer): void;
  /** The process ended (`error` when it never started). */
  onClose(code: number | null, signal: NodeJS.Signals | null, error?: Error): void;
  /** The command became a background job; the tool call can return. */
  onPromoted(job: Job): void;
}

interface Running {
  child: ChildProcess;
  logged: number;
  truncated: boolean;
  timer?: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
  /** Set while a tool call is waiting for the command: not a background job yet. */
  fg?: Foreground;
}

export interface ForegroundOptions {
  onData(chunk: Buffer): void;
  signal?: AbortSignal;
  /** Seconds, as the bash tool takes it. */
  timeout?: number;
}

export interface RegistryOptions {
  /** Directory for the job logs; it must exist. */
  dir: string;
  maxRunning?: number;
  maxLifetimeMs?: number;
  /** Called once when a job ends on its own or hits the lifetime cap (not when it was stopped on request). */
  onEnd(job: Job): void;
  /** Called whenever the set of running jobs changes. */
  onChange?(): void;
  now?: () => number;
}

/** Jobs started by one session: spawn, log, stop. */
export class JobRegistry {
  private readonly jobs = new Map<string, Job>();
  private readonly running = new Map<string, Running>();
  private next = 1;
  private nextForeground = 1;

  private readonly opts: RegistryOptions;

  constructor(opts: RegistryOptions) {
    this.opts = opts;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  start(command: string, cwd: string, env: NodeJS.ProcessEnv = process.env): Job {
    const max = this.opts.maxRunning ?? MAX_RUNNING;
    if (this.runningCount() >= max) {
      throw new Error(`already running ${max} background jobs; stop one with toriel_job (action "stop") or wait for one to finish`);
    }
    return this.launch(command, cwd, env, undefined, `j${this.next++}`);
  }

  private launch(command: string, cwd: string, env: NodeJS.ProcessEnv, fg: Foreground | undefined, id: string): Job {
    const logPath = join(this.opts.dir, `${id}.log`);
    writeFileSync(logPath, "");
    const child = spawn("bash", ["-c", command], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const job: Job = { id, command, pid: child.pid, startedAt: this.now(), state: "running", logPath };
    const state: Running = { child, logged: 0, truncated: false, fg };
    if (!fg) {
      this.armLifetime(job, state);
    }
    this.jobs.set(id, job);
    this.running.set(id, state);
    const log = (chunk: Buffer): void => {
      const room = MAX_LOG_BYTES - state.logged;
      if (room > 0) {
        const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
        appendFileSync(logPath, part);
        state.logged += part.length;
      }
      // output past the cap: say so once, also when an earlier chunk ended exactly at the cap
      if (chunk.length > room && !state.truncated) {
        state.truncated = true;
        appendFileSync(logPath, "\n[output limit reached, the rest is dropped]\n");
      }
      state.fg?.onData(chunk);
    };
    child.stdout?.on("data", log);
    child.stderr?.on("data", log);
    child.on("error", (err) => {
      appendFileSync(logPath, `${err.message}\n`);
      this.finish(job, "exited", 127, null, err);
    });
    child.on("close", (code, signal) => {
      this.finish(job, job.state === "running" ? "exited" : job.state, code, signal);
    });
    this.opts.onChange?.();
    return job;
  }

  private armLifetime(job: Job, state: Running): void {
    state.timer = setTimeout(() => this.end(job, "timed out"), this.opts.maxLifetimeMs ?? MAX_LIFETIME_MS);
    state.timer.unref();
  }

  /**
   * Run a command for a bash tool call that is waiting for it (pi's bash tool,
   * through its `operations`). It is a registered process, so `backgroundAll` can
   * turn it into a job while the call waits; until then it is invisible (no id,
   * no listing, no notice, no cap) and behaves like pi's own: output streams to
   * `onData`, `signal` kills it, `timeout` kills it, and the promise settles with
   * the exit code (rejecting "aborted" / "timeout:N" as pi's tool expects).
   */
  runForeground(command: string, cwd: string, env: NodeJS.ProcessEnv, o: ForegroundOptions): Promise<{ exitCode: number }> {
    return new Promise((resolve, reject) => {
      if (o.signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      if (!existsSync(cwd)) {
        reject(new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`));
        return;
      }
      let aborted = false;
      let timedOut = false;
      let timeoutHandle: NodeJS.Timeout | undefined;
      let job: Job | undefined;
      const onAbort = (): void => {
        aborted = true;
        if (job) {
          this.signalGroup(job, "SIGKILL");
        }
      };
      const detach = (): void => {
        clearTimeout(timeoutHandle);
        o.signal?.removeEventListener("abort", onAbort);
      };
      job = this.launch(
        command,
        cwd,
        env,
        {
          onData: o.onData,
          onClose: (code, signal, error) => {
            detach();
            if (error) {
              reject(error);
            } else if (aborted) {
              reject(new Error("aborted"));
            } else if (timedOut) {
              reject(new Error(`timeout:${o.timeout}`));
            } else {
              resolve({ exitCode: code ?? (signal ? 128 + (osConstants.signals[signal] ?? 0) : 1) });
            }
          },
          onPromoted: (promoted) => {
            detach();
            o.onData(Buffer.from(movedNotice(promoted)));
            resolve({ exitCode: 0 });
          },
        },
        `fg${this.nextForeground++}`,
      );
      if (o.timeout !== undefined && Number.isFinite(o.timeout) && o.timeout > 0) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          if (job) {
            this.signalGroup(job, "SIGKILL");
          }
        }, o.timeout * 1000);
      }
      o.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * Turn every foreground command into a background job (the user's key). Commands
   * past the running limit stay in the foreground and are counted as refused.
   */
  backgroundAll(): { promoted: Job[]; refused: number } {
    const promoted: Job[] = [];
    let refused = 0;
    const max = this.opts.maxRunning ?? MAX_RUNNING;
    for (const [oldId, r] of [...this.running]) {
      const job = this.jobs.get(oldId);
      if (!r.fg || !job || job.state !== "running") {
        continue;
      }
      if (this.runningCount() >= max) {
        refused++;
        continue;
      }
      const fg = r.fg;
      const id = `j${this.next++}`;
      this.running.delete(oldId);
      this.jobs.delete(oldId);
      job.id = id;
      this.running.set(id, r);
      this.jobs.set(id, job);
      r.fg = undefined;
      this.armLifetime(job, r);
      promoted.push(job);
      this.opts.onChange?.();
      fg.onPromoted(job);
    }
    return { promoted, refused };
  }

  /** Ask a running job's process group to stop (SIGTERM, then SIGKILL). It is reported as stopped when it exits. */
  stop(id: string): Job | undefined {
    const job = this.get(id);
    if (job?.state === "running") {
      this.end(job, "stopped");
    }
    return job;
  }

  private end(job: Job, state: "stopped" | "timed out"): void {
    const r = this.running.get(job.id);
    if (!r || job.state !== "running") {
      return;
    }
    job.state = state;
    this.signalGroup(job, "SIGTERM");
    r.killTimer = setTimeout(() => this.signalGroup(job, "SIGKILL"), KILL_GRACE_MS);
    r.killTimer.unref();
  }

  private signalGroup(job: Job, signal: NodeJS.Signals): void {
    if (job.pid === undefined) {
      return;
    }
    try {
      process.kill(-job.pid, signal);
    } catch {
      // already gone
    }
  }

  private finish(job: Job, state: JobState, code: number | null, signal: NodeJS.Signals | null, error?: Error): void {
    const r = this.running.get(job.id);
    if (!r) {
      return;
    }
    clearTimeout(r.timer);
    clearTimeout(r.killTimer);
    this.running.delete(job.id);
    if (r.fg) {
      // a foreground command is the tool call's business: no job record, no notice
      this.jobs.delete(job.id);
      rmSync(job.logPath, { force: true });
      r.fg.onClose(code, signal, error);
      return;
    }
    const asked = job.state === "stopped";
    job.state = state;
    job.exitCode = code;
    job.signal = signal;
    job.endedAt = this.now();
    this.opts.onChange?.();
    if (!asked) {
      this.opts.onEnd(job);
    }
  }

  /** A background job by id; a foreground command is not one (so it cannot be read or stopped by the agent that is waiting for it). */
  get(id: string): Job | undefined {
    return this.running.get(id)?.fg ? undefined : this.jobs.get(id);
  }

  list(): Job[] {
    return [...this.jobs.values()].filter((j) => !this.running.get(j.id)?.fg);
  }

  /** Running background jobs (a foreground command is not one until it is moved). */
  runningCount(): number {
    return [...this.running.values()].filter((r) => !r.fg).length;
  }

  /** A slice of the job's log from byte `since`; `next` is where to continue. Only the last `limit` bytes are returned. */
  output(id: string, since = 0, limit = OUTPUT_LIMIT): { text: string; next: number; skipped: number } | undefined {
    const job = this.jobs.get(id);
    if (!job) {
      return undefined;
    }
    const all = readFileSync(job.logPath);
    const from = Math.min(Math.max(0, since), all.length);
    const start = Math.max(from, all.length - limit);
    return { text: all.subarray(start).toString("utf8"), next: all.length, skipped: start - from };
  }

  /** Session shutdown: SIGKILL every running job's process group at once, with no notices. */
  killAll(): void {
    for (const [id, r] of this.running) {
      clearTimeout(r.timer);
      clearTimeout(r.killTimer);
      const job = this.jobs.get(id);
      if (job) {
        job.state = "stopped";
        this.signalGroup(job, "SIGKILL");
      }
    }
    this.running.clear();
  }
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) {
    return `${s}s`;
  }
  if (s < 3600) {
    return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  }
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

/** What the waiting bash call returns after its command was moved to the background. */
export function movedNotice(job: Job): string {
  return `\n[The user moved this command to the background as job ${job.id}; it keeps running and the output above is what it printed so far. You will be told when it exits; read its output with toriel_job (action "output", id "${job.id}").]\n`;
}

function describeEnd(job: Job): string {
  if (job.state === "timed out") {
    return "was stopped after reaching the lifetime limit";
  }
  if (job.signal) {
    return `was killed by ${job.signal}`;
  }
  return `exited with code ${job.exitCode ?? "?"}`;
}

/** The message the agent receives when a job ends; the tail is cut at a line boundary. */
export function endNotice(job: Job, tail: string): string {
  const took = formatDuration((job.endedAt ?? job.startedAt) - job.startedAt);
  const lines = tail.trimEnd();
  const cut = lines.length > NOTICE_TAIL ? lines.slice(lines.indexOf("\n", lines.length - NOTICE_TAIL) + 1) : lines;
  const body = cut ? `\nLast output:\n${cut}` : "\n(no output)";
  return `Background job ${job.id} (${job.command}) ${describeEnd(job)} after ${took}.${body}\nRead the full output with toriel_job (action "output", id "${job.id}").`;
}

/** One line per job for `toriel_job list`. */
export function describeJob(job: Job, now: number): string {
  const age = formatDuration((job.endedAt ?? now) - job.startedAt);
  const status = job.state === "running" ? `running ${age}` : `${job.state}${job.exitCode !== undefined && job.exitCode !== null ? ` (code ${job.exitCode})` : ""} after ${age}`;
  return `${job.id}  ${status}  ${job.command}`;
}

const BASH_ADDENDUM =
  ' Set run_in_background to true for a command that keeps running (a dev server, a watcher, a long build or test run): it starts at once and returns a job id, you carry on, and you are told when it exits. Read its output or stop it with toriel_job. Do not use it for commands that finish quickly, and do not poll in a loop: the exit notice arrives on its own.';

interface Ctx {
  cwd?: string;
  model?: { provider: string; id: string };
  thinkingLevel?: string;
  sessionManager?: { getSessionId(): string; getSessionFile(): string | undefined };
  ui?: { setStatus(key: string, text: string | undefined): void; notify?(message: string, type?: string): void };
}
interface Pi {
  registerTool(tool: Record<string, unknown>): void;
  registerCommand?(name: string, options: { description?: string; handler: (args: string, ctx: Ctx) => Promise<void> | void }): void;
  on(event: string, handler: (event: unknown, ctx: Ctx) => void): void;
  sendMessage(message: { customType: string; content: string; display: boolean; details: unknown }, options?: { triggerTurn?: boolean; deliverAs?: string }): Promise<void> | void;
}

type Params = { command: string; timeout?: number; run_in_background?: boolean };

/**
 * pi's `getShellEnv()` (not exported): the process environment with pi's own bin
 * directory (the vendored rg, fd, ...) in front of PATH, so a background command
 * finds the same tools a foreground one does.
 */
export function shellEnv(env: NodeJS.ProcessEnv = process.env, binDir: string = join(getAgentDir(), "bin")): NodeJS.ProcessEnv {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const current = env[pathKey] ?? "";
  const entries = current.split(delimiter).filter(Boolean);
  return { ...env, [pathKey]: entries.includes(binDir) ? current : [binDir, current].filter(Boolean).join(delimiter) };
}

/** The environment pi gives its own bash tool: its PATH, and the session's PI_* variables so a job can tell which session started it (stale ones inherited from the pi process are dropped first, as pi does). */
export function jobEnv(ctx: Ctx, env: NodeJS.ProcessEnv = shellEnv()): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const key of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) {
    delete out[key];
  }
  if (ctx.thinkingLevel) {
    out.PI_REASONING_LEVEL = ctx.thinkingLevel;
  }
  if (ctx.sessionManager) {
    out.PI_SESSION_ID = ctx.sessionManager.getSessionId();
    const file = ctx.sessionManager.getSessionFile();
    if (file) {
      out.PI_SESSION_FILE = file;
    }
  }
  if (ctx.model) {
    out.PI_PROVIDER = ctx.model.provider;
    out.PI_MODEL = ctx.model.id;
  }
  return out;
}

const text = (t: string, details: unknown = undefined) => ({ content: [{ type: "text" as const, text: t }], details });

export default function (pi: Pi) {
  if (!process.env.TORIEL_CHILD) {
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "toriel-jobs-"));
  let ui: Ctx["ui"] | undefined;
  const registry: JobRegistry = new JobRegistry({
    dir,
    onChange: () => {
      const n = registry.runningCount();
      ui?.setStatus(STATUS_KEY, JSON.stringify({ v: 1, running: n }));
    },
    onEnd: (job) => {
      const out = registry.output(job.id, 0, NOTICE_TAIL * 2);
      void Promise.resolve(
        pi.sendMessage({ customType: CUSTOM_TYPE, content: endNotice(job, out?.text ?? ""), display: true, details: { id: job.id, state: job.state, exitCode: job.exitCode } }, { triggerTurn: true, deliverAs: "followUp" }),
      ).catch(() => {});
    },
  });

  pi.on("session_start", (_event, ctx) => {
    ui = ctx.ui;
  });
  pi.on("session_shutdown", () => {
    registry.killAll();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // temp dir; the OS cleans it up
    }
  });

  // pi's bash tool with our process runner: a foreground command is a registered process, so the
  // user can move it to the background while the call waits (everything else is pi's code)
  const operations = {
    exec: (command: string, cwd: string, o: { onData: (chunk: Buffer) => void; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv }) =>
      registry.runForeground(command, cwd, o.env ?? shellEnv(), { onData: o.onData, signal: o.signal, timeout: o.timeout }),
  };
  const base = createBashToolDefinition(process.cwd(), { operations } as never) as unknown as {
    description: string;
    execute(id: string, params: Params, signal: unknown, onUpdate: unknown, ctx: Ctx): Promise<unknown>;
  };
  pi.registerTool({
    ...base,
    description: base.description + BASH_ADDENDUM,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        timeout: { type: "number", description: "Timeout in seconds (optional, no default timeout); not used with run_in_background" },
        run_in_background: { type: "boolean", description: "Start the command in the background and return a job id at once" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    async execute(id: string, params: Params, signal: unknown, onUpdate: unknown, ctx: Ctx) {
      if (!params.run_in_background) {
        return base.execute(id, params, signal, onUpdate, ctx);
      }
      try {
        const job = registry.start(params.command, ctx.cwd ?? process.cwd(), jobEnv(ctx));
        return text(`Started background job ${job.id} (pid ${job.pid}). You will be told when it exits. Read output: toriel_job {"action":"output","id":"${job.id}"}.`, { job: job.id });
      } catch (err) {
        return { ...text(`Could not start the job: ${err instanceof Error ? err.message : String(err)}`), isError: true };
      }
    },
  });

  pi.registerCommand?.(BACKGROUND_COMMAND, {
    description: "toriel: move the running foreground bash command(s) to the background",
    handler: async (_args, ctx) => {
      const { promoted, refused } = registry.backgroundAll();
      const parts = promoted.map((j) => `${j.id} (${j.command})`);
      const stayed = `${refused} stayed in the foreground: already ${MAX_RUNNING} background jobs.`;
      let message = "No command is running in the foreground.";
      if (promoted.length > 0) {
        message = `Moved to the background: ${parts.join(", ")}${refused > 0 ? `. ${stayed}` : ""}`;
      } else if (refused > 0) {
        message = stayed;
      }
      ctx.ui?.notify?.(message, promoted.length > 0 ? "info" : "warning");
    },
  });

  pi.registerTool({
    name: "toriel_job",
    label: "Job",
    description:
      'Manage this session\'s background shell jobs (started with bash and run_in_background). action "list": every job with its state. action "output": the job\'s output (id required; the last part of it, or from byte offset `since` where a previous call said to continue). action "stop": stop a running job (id required).',
    promptSnippet: "toriel_job: list, read the output of, or stop background shell jobs",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "output", "stop"] },
        id: { type: "string", description: 'Job id such as "j1"' },
        since: { type: "number", description: "output: byte offset to read from (the next offset is printed after each read)" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(_id: string, params: { action: string; id?: string; since?: number }) {
      const now = Date.now();
      if (params.action === "list") {
        const jobs = registry.list();
        return text(jobs.length === 0 ? "No background jobs." : jobs.map((j) => describeJob(j, now)).join("\n"));
      }
      const job = params.id ? registry.get(params.id) : undefined;
      if (!job) {
        return { ...text(`No job ${params.id ?? "(no id given)"}. Use action "list".`), isError: true };
      }
      if (params.action === "stop") {
        if (job.state !== "running") {
          return text(`${describeJob(job, now)} - not running.`);
        }
        registry.stop(job.id);
        return text(`Stopping ${job.id}.`);
      }
      if (params.action === "output") {
        const out = registry.output(job.id, params.since);
        const skipped = out && out.skipped > 0 ? `[${out.skipped} earlier bytes not shown]\n` : "";
        const state = job.state === "running" ? "still running" : `${job.state}${job.exitCode !== undefined && job.exitCode !== null ? `, code ${job.exitCode}` : ""}`;
        return text(`${skipped}${out?.text.trimEnd() || "(no output yet)"}\n[${job.id} ${state}; continue from byte ${out?.next ?? 0}]`);
      }
      return { ...text(`Unknown action ${params.action}.`), isError: true };
    },
  });
}
