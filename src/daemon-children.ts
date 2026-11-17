// Starting, stopping and listening to the pi child processes behind sessions.
import * as fs from "node:fs";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { childEnv, sandboxWritableRoots } from "./child-env.ts";
import { mcpYamlFile } from "./config-dir.ts";
import { scopeForSession } from "./scope-root.ts";
import { DIALOG_METHODS, FILE_HISTORY_DIR, PLAN_DIR, SANDBOX_TMP_DIR, SHARED_DIR, SOCK } from "./config.ts";
import { answerablePrompt, touchesProtected } from "./daemon-permissions.ts";
import { type GrantStore, ruleFor, withSuggestion } from "./permissions.ts";
import { type BridgeTracker, INJECT_COMMAND, injectedId, mergedQueueTexts, parseBridgeReport } from "./daemon-bridge.ts";
import type { ClientHub } from "./daemon-hub.ts";
import { autoOn, type DaemonSession } from "./daemon-session.ts";
import { randomUUID } from "node:crypto";
import { type AgentProfile, loadAgents, profileArgs, profileHasMcp, withResolvedModel } from "./agents.ts";
import { recordHandled } from "./handled-files.ts";
import { brief, type DecisionBase, recordDecision } from "./decision-log.ts";
import { exitNote, stderrTail } from "./subagent-exit.ts";
import { historyLength } from "./daemon-history.ts";
import { bundledArgs, bundledTools } from "./bundled-packages.ts";
import { piAgentDir } from "./pi-dir.ts";
import { resourceArgs, SESSION_TOOLS, SPAWN_TOOLS, TORIEL_TOOLS } from "./resources.ts";
import { lineageArgs, loadLineage, parentMap, subagentDepth } from "./lineage.ts";
import { sessionIdOfFile } from "./session-file.ts";
import { mayDelegate, type SubagentLimits } from "./subagents.ts";
import { profileOfSession, saveSessionAgent } from "./session-agents.ts";
import { log } from "./log.ts";
import { type AskRule, AUTO_ANSWERED_NOTICE, AUTO_DENIED_NOTICE, AUTO_DISMISSED_NOTICE, encodeLine, GRANT_ANSWERED_NOTICE, type UsageReport } from "./shared.ts";
import { floorReason, isPermissionPrompt, promptSubject } from "./auto-mode.ts";
import { type ChildConfig, loadSettings, resolveChildConfig, settingsMtime } from "./settings.ts";
import { fmtDuration, parseDurationText } from "./when.ts";
import { errText } from "./util.ts";
import { parseReport as parseTasksReport, STATUS_KEY as TASKS_KEY } from "../pi/extensions/lib/tasks.ts";
import { STATUS_KEY as PLAN_KEY } from "../pi/extensions/lib/plan-mode.ts";

export interface SlashCommand {
  name: string;
  description?: string;
  source: string;
}

export interface StartOptions {
  sessionFile?: string;
  forkPath?: string;
  name?: string;
  /** Text for pi's `--append-system-prompt` (a fork's note about its parent). */
  appendSystemPrompt?: string;
  /** Launch a new session as this agent profile (a respawn finds its profile on its own). */
  agent?: AgentProfile;
  /** Started by another session's toriel_agent call: its lineage is recorded only after it is up, so the start says so (ticket 232). */
  subagent?: boolean;
}


export class ChildManager {
  private readonly hub: ClientHub;
  /** Newest usage report per provider (all sessions on a provider share one account). */
  private readonly usage: Map<string, UsageReport>;
  /** Newest slash-command list any child reported; serves sessions with no child. */
  private lastCommands: SlashCommand[] = [];
  /** Sessions waiting for the notice pi's /mcp prints, by daemon session id (see mcpStatus). */
  private readonly noticeTaps = new Map<number, (text: string) => void>();
  /** Injects handed to session bridges and not yet seen in a transcript, so strip re-syncs keep them visible. */
  private readonly bridges: BridgeTracker;
  /** Called when a session's run settles or its compaction ends (the daemon uses it to wake waiting schedules). */
  onSettled?: (s: DaemonSession) => void;
  /** Called with the name pi reports for a session that has a wanted name, on every refresh (the naming authority re-asserts it when they differ). */
  onNameObserved?: (s: DaemonSession, observed: string | undefined) => void;
  /** Processes that have been spawned but whose start has not finished: not on any session yet, so a shutdown must find them here. */
  private readonly launching = new Set<RpcClient>();
  /** Called with each finished assistant message (the subagent manager counts turns and tokens with it). */
  onAssistantMessage?: (s: DaemonSession, message: { role?: string; stopReason?: string; errorMessage?: string; usage?: { input?: number; output?: number; cacheWrite?: number } } | undefined) => void;
  /** Called for every event a session's process emits (the subagent watchdog's clock). */
  onActivity?: (s: DaemonSession) => void;
  /** The limits that decide which sessions get the toriel_agent tools: the same object the subagent manager enforces. */
  private readonly subagentLimits: SubagentLimits;
  /** Called when a session's process is stopped or found dead (subagents end with their session; foreground ones with their parent). */
  /** A session's process went away; `crash` says why when nobody asked it to stop. */
  onStopped?: (s: DaemonSession, crash?: string) => void;

  /** The grant store, which answers file-path prompts it covers (see `answerCovered`). */
  private readonly grants: GrantStore | undefined;

  constructor(hub: ClientHub, usage: Map<string, UsageReport>, bridges: BridgeTracker, subagentLimits: SubagentLimits, grants?: GrantStore) {
    this.grants = grants;
    this.subagentLimits = subagentLimits;
    this.hub = hub;
    this.usage = usage;
    this.bridges = bridges;
  }

  /**
   * Settings for a child about to start, read fresh so edits apply to new and
   * respawned sessions. Records the file's mtime and any problems on the session
   * so the switcher can say which running sessions are behind.
   */
  configFor(s: DaemonSession): ChildConfig {
    const mtime = settingsMtime();
    const { settings, problems } = loadSettings();
    s.settingsMtime = mtime;
    s.settingsProblem = problems.length > 0 ? problems.join("; ") : undefined;
    if (problems.length > 0) {
      log(`settings problems: ${s.settingsProblem}`);
    }
    return resolveChildConfig(settings);
  }

  /** Whether `s` gets the toriel_agent tools: its profile allows spawning and it is not already too deep. */
  mayDelegate(s: DaemonSession): boolean {
    return mayDelegate(s.agent, subagentDepth(s.sessionId, parentMap(loadLineage())), this.subagentLimits);
  }

  /** The environment the toriel_agent tool reads: whether to register, and the agent types its description lists. */
  private delegationEnv(s: DaemonSession): Record<string, string> {
    if (!this.mayDelegate(s)) {
      return {};
    }
    const types = loadAgents(s.cwd).agents.map((a) => `- ${a.name}: ${a.description}`).join("\n");
    return { TORIEL_CAN_SPAWN: "1", TORIEL_AGENT_TYPES: types };
  }

  /**
   * Start a pi process for `s` with `args` and wire its events in, applying
   * toriel's queue preference: messages sent while a run is in flight are all
   * delivered together at the next turn boundary (pi's own default is one per
   * turn). Set steeringMode in the toriel settings to change.
   */
  async launch(s: DaemonSession, args: string[], cfg: ChildConfig): Promise<RpcClient> {
    // spawn reports a missing cwd as "spawn node ENOENT", which points at the wrong thing
    if (!fs.existsSync(s.cwd)) {
      throw new Error(`working directory no longer exists: ${s.cwd} (moved or deleted; recreate it or symlink it to the new location)`);
    }
    const scope = scopeForSession(s.cwd, s.agent !== undefined && s.agent.scope !== "none");
    s.scope = scope;
    if (scope !== undefined) {
      log(`scope for ${s.sessionId ?? s.id}: ${scope.root} (mode ${scope.mode})`);
    }
    // the per-command bash sandbox (board 190): only for a scoped session, on unless the setting says "off"; read now, so a change applies to sessions started after it
    const settings = loadSettings().settings;
    const sandbox = scope !== undefined && settings.sandbox !== "off" ? sandboxWritableRoots(settings, process.env.HOME ?? "") : undefined;
    if (sandbox !== undefined) {
      log(`sandbox for ${s.sessionId ?? s.id}: bwrap, writable ${[scope?.root, SHARED_DIR, ...sandbox].join(", ")}`);
    }
    const client = new RpcClient({
      cliPath: cfg.piCli,
      cwd: s.cwd,
      args,
      env: { ...childEnv(s, SOCK, process.env, scope, { sharedDir: SHARED_DIR, tmpDir: SANDBOX_TMP_DIR, sandboxWritable: sandbox, mcpFile: profileHasMcp(s.agent) ? mcpYamlFile() : undefined, fileHistoryDir: FILE_HISTORY_DIR, planDir: PLAN_DIR }), ...this.delegationEnv(s) },
    });
    client.onEvent((event) => this.onEvent(s, event as Record<string, unknown>));
    this.launching.add(client);
    try {
      await client.start();
    } finally {
      this.launching.delete(client);
    }
    // A crash is told by the process exiting, not found by polling it. A deliberate stop clears s.child first (deactivate), so only a child nobody stopped lands here.
    (client as unknown as { process?: { once(ev: "exit", cb: (code: number | null, signal: string | null) => void): void } }).process?.once("exit", (code, signal) => {
      if (s.child === client && !s.dead) {
        const note = exitNote(code, signal, client.getStderr());
        log(`session ${s.id} child exited unexpectedly: ${exitNote(code, signal)}; stderr tail: ${stderrTail(client.getStderr()) || "(none)"}`);
        this.markDead(s, "the session's process exited", note);
        this.hub.broadcastSessions();
      }
    });
    try {
      await client.setSteeringMode(cfg.steeringMode);
    } catch (err) {
      log(`setSteeringMode(${cfg.steeringMode}) failed: ${errText(err)}`);
    }
    return client;
  }

  /**
   * The pi arguments for starting `s` from a file, a fork source or fresh. Also settles
   * the session's id and profile, which the child's environment and later respawns need.
   */
  startArgs(s: DaemonSession, opts: StartOptions): { args: string[]; cfg: ChildConfig } {
    // a file that is gone (deleted, swept) is not resumed: pi refuses --session with --session-id, so it counts as a fresh session
    const wanted = opts.forkPath ? undefined : (opts.sessionFile ?? s.sessionFile);
    const useFile = wanted && fs.existsSync(wanted) ? wanted : undefined;
    const args: string[] = [];
    if (opts.forkPath) {
      args.push("--fork", opts.forkPath);
    } else if (useFile) {
      args.push("--session", useFile);
    }
    if (opts.name) {
      args.push("--name", opts.name);
    }
    if (opts.appendSystemPrompt) {
      args.push("--append-system-prompt", opts.appendSystemPrompt);
    }
    const fileId = useFile ? sessionIdOfFile(useFile) : undefined; // read once: the header is what every use below needs
    args.push(...lineageArgs(fileId));
    const cfg = this.configFor(s);
    // The toriel settings' provider/model/thinking are defaults for NEW sessions.
    // A session that already has a file resumes with its own (pi restores them
    // from the file), so a restart, /reload or /clear must not reset them.
    const isNew = !opts.forkPath && !(useFile && fs.existsSync(useFile));
    // The profile a session was started with is saved by UUID, so lazy respawns, /reload and /clear keep its loadout.
    // Known before pi starts, so the child's tools can say who it is: a new session
    // gets an id chosen here (pi takes --session-id), a resumed one has it in its file.
    if (isNew) {
      s.sessionId = randomUUID();
      args.push("--session-id", s.sessionId);
    } else if (useFile) {
      s.sessionId = fileId ?? s.sessionId;
    }
    const agent = opts.agent ?? profileOfSession(fileId) ?? s.agent;
    s.agent = agent;
    // a model tier (model: cheap) becomes a provider/id here, from the settings as they are now; only a new session takes the model, a resumed one keeps what its file says
    const launched = agent && isNew ? withResolvedModel(agent, loadSettings().settings.agentLanes, log) : agent;
    if (launched) {
      // a session the user drives (no parent) keeps the task list and plan mode whatever its profile lists (ticket 232)
      const driven = !opts.subagent && subagentDepth(s.sessionId, parentMap(loadLineage())) === 0;
      args.push(...profileArgs(launched, { isNew, extraTools: driven ? SESSION_TOOLS : [] }));
    }
    args.push(...resourceArgs({ skills: !agent?.minimal }));
    // the third-party pi packages toriel carries (ticket 230), unless the user has installed one themselves or switched it off
    const bundle = { agentDir: piAgentDir(), cwd: s.cwd, off: loadSettings().settings.bundledPackagesOff };
    args.push(...bundledArgs(agent, bundle));
    // A resume restores the tool list recorded in the transcript, so tools of extensions
    // installed since never reach the model. +name entries join them to that loadout. A
    // profile that lists tools owns the loadout (pi forbids mixing the two forms).
    if (!agent?.tools) {
      const mayDelegate = this.mayDelegate(s); // reads lineage.json: once per start, not once per tool
      args.push("--tools", [...TORIEL_TOOLS.filter((t) => mayDelegate || !SPAWN_TOOLS.includes(t.slice(1))), ...bundledTools(agent, bundle)].join(","));
    }
    if (isNew && cfg.thinking && !agent?.thinking) {
      args.push("--thinking", cfg.thinking);
    }
    if (isNew && cfg.model && !launched?.model) {
      args.push("--model", cfg.model);
    }
    if (isNew && cfg.provider && !launched?.model) {
      args.push("--provider", cfg.provider);
    }
    return { args, cfg };
  }

  /** Bring an inactive session's child up (from its file, a fork source, or fresh). */
  async start(s: DaemonSession, opts: StartOptions = {}): Promise<void> {
    if (s.child) {
      return;
    }
    s.spawning = true;
    this.hub.broadcastSessions();
    try {
      const { args, cfg } = this.startArgs(s, opts);
      s.sessionBridge = undefined;
      s.child = await this.launch(s, args, cfg);
      s.dead = false;
      // launch() hooks the exit event, but s.child is only set now: a process that died in between (during the steering-mode call) was missed
      const proc = (s.child as unknown as { process?: { exitCode?: number | null; signalCode?: string | null } }).process;
      if (typeof proc?.exitCode === "number" || typeof proc?.signalCode === "string") {
        this.markDead(s, "the session's process exited", exitNote(proc.exitCode, proc.signalCode, s.child.getStderr()));
        this.hub.broadcastSessions();
      }
      await this.refreshMeta(s);
      await this.detectBridge(s);
      if (opts.agent && s.sessionId) {
        saveSessionAgent(s.sessionId, opts.agent);
      }
      if (s.sessionFile) {
        try {
          recordHandled(s.sessionFile);
        } catch (err) {
          log(`could not record ${s.sessionFile} as handled: ${errText(err)}`);
        }
      }
      log(`session ${s.id} child started (file=${s.sessionFile ?? "new"})`);
    } finally {
      s.spawning = false;
      this.hub.broadcastSessions();
    }
  }

  /**
   * Signal every pi process: those of live sessions, and those still starting (a subagent spawned a moment
   * before shutdown has no `child` yet). Sends SIGTERM at once and does not wait, for the daemon is exiting.
   */
  stopAll(sessions: Iterable<DaemonSession>): void {
    for (const s of sessions) {
      if (s.child) {
        void s.child.stop().catch(() => {});
      }
    }
    for (const client of this.launching) {
      void client.stop().catch(() => {});
    }
  }

  async deactivate(s: DaemonSession): Promise<void> {
    const child = s.child;
    if (!child) {
      return;
    }
    s.child = undefined;
    s.attachedTo = undefined;
    this.clearDialog(s); // was a bare pendingDialog = false, which left a deny-after timer armed on the stopped session
    s.streaming = false;
    s.compacting = false;
    this.dropBridge(s, "the session was stopped");
    try {
      await child.stop();
    } catch {
      // best effort; the process is going away regardless
    }
    this.onStopped?.(s);
    log(`session ${s.id} deactivated`);
  }

  /** Restart an idle session's child on the same file, keeping its input attach. */
  async restart(s: DaemonSession): Promise<void> {
    await this.restartAround(s);
  }

  /**
   * Stop a live session's child, let `mutate` change its file while no process holds it, and start the
   * child again on that file, keeping the input attach. With `keepModel`, the model and thinking level in
   * use are put back afterwards: pi restores them only from a file that has messages, so a cleared (or
   * just-restored) file would otherwise start on the defaults.
   */
  async restartAround(s: DaemonSession, mutate?: () => void, opts: { keepModel?: boolean; file?: string } = {}): Promise<void> {
    const file = opts.file ?? s.sessionFile;
    const before = opts.keepModel && s.child ? await s.child.getState() : undefined;
    const attached = s.attachedTo;
    await this.deactivate(s);
    mutate?.();
    s.attachedTo = attached;
    await this.start(s, { sessionFile: file });
    if (before && s.child) {
      if (before.model) {
        await s.child.setModel(before.model.provider, before.model.id);
      }
      await s.child.setThinkingLevel(before.thinkingLevel);
      await this.refreshMeta(s);
    }
  }

  async refreshMeta(s: DaemonSession): Promise<void> {
    if (!s.child) {
      return;
    }
    try {
      const state = await s.child.getState();
      s.model = state.model ? `${state.model.provider}/${state.model.id}` : "default";
      s.sessionId = state.sessionId;
      s.sessionFile = state.sessionFile ?? s.sessionFile;
      s.messageCount = state.messageCount;
      s.streaming = state.isStreaming;
      // the registry shows the name toriel decided, not whatever pi resolves (a fork starts out reporting its parent's)
      s.sessionName = s.wantedName ?? state.sessionName;
      if (s.wantedName !== undefined) {
        this.onNameObserved?.(s, state.sessionName);
      }
      s.provider = state.model?.provider;
      s.thinkingLevel = state.thinkingLevel;
      s.ctxMax = state.model?.contextWindow;
      s.acceptsImages = state.model?.input ? state.model.input.includes("image") : undefined;
      s.dead = false;
      // pi's queue_update is the only source of strip state and is not replayed, so
      // one lost event would leave a controller showing "queued" lines forever (the
      // #47 symptom). When pi says nothing is pending, any strip entries beyond our
      // own (compaction-held and bridge-pending) are stale by definition.
      if (state.pendingMessageCount === 0) {
        this.hub.announceQueue(
          s.id,
          [
            ...(s.held ?? []).map((h) => h.text),
            ...this.bridges.texts(s.id),
          ],
        );
      }
      try {
        // whole-session figures from pi, so they survive a daemon restart (our own running sums would not)
        const stats = await s.child.getSessionStats();
        s.totalTokens = stats.tokens.total;
        s.totalCost = stats.cost;
        s.ctxTokens = stats.contextUsage?.tokens;
        s.ctxMax = stats.contextUsage?.contextWindow ?? s.ctxMax;
      } catch (err) {
        log(`session ${s.id} stats failed: ${err}`);
      }
    } catch (err) {
      this.markDead(s, "the session's process stopped answering");
      log(`session ${s.id} refreshMeta failed: ${err}`);
    }
  }

  private markDead(s: DaemonSession, reason: string, crash: string = reason): void {
    s.dead = true;
    s.streaming = false;
    s.compacting = false;
    this.clearDialog(s); // a dead child cannot answer its open prompt, and the deny-after timer must not fire on it (review of batch 7)
    this.dropBridge(s, reason);
    this.onStopped?.(s, crash);
  }

  /** Whether the child has the session bridge extension: it lists the inject command. Remembered on the session. */
  async detectBridge(s: DaemonSession): Promise<boolean> {
    if (!s.child) {
      return false;
    }
    try {
      const commands = await s.child.getCommands();
      s.sessionBridge = commands.some((c) => c.name === INJECT_COMMAND);
    } catch (err) {
      log(`session ${s.id}: could not look for the session bridge: ${errText(err)}`);
      s.sessionBridge = false;
    }
    return s.sessionBridge === true;
  }

  /** The strip: compaction-held messages first, then injects the bridge has not confirmed yet. */
  private announceQueue(s: DaemonSession): void {
    this.hub.announceQueue(s.id, mergedQueueTexts((s.held ?? []).map((h) => h.text), this.bridges.texts(s.id)));
  }

  /** Injects that never reached a transcript are gone with the process: say so rather than let the sender believe they landed. */
  private dropBridge(s: DaemonSession, why: string): void {
    const lost = this.bridges.clear(s.id);
    s.sessionBridge = undefined;
    if (lost.length === 0) {
      return;
    }
    const reason = `${lost.length} message${lost.length === 1 ? "" : "s"} from other sessions did not arrive (${why}): ${lost.map((p) => JSON.stringify(p.text.replace(/^\[from [^\]]*\]:\s*/, "").slice(0, 60))).join(", ")}`;
    log(`session ${s.id}: ${reason}`);
    this.hub.broadcast({ type: "exited", session: s.id, reason });
    this.announceQueue(s);
  }

  /** Act on a status record from the bridge extension; true if it was one. */
  private takeBridgeReport(s: DaemonSession, event: Record<string, unknown>): boolean {
    const report = parseBridgeReport(event);
    if (!report) {
      return false;
    }
    switch (report.kind) {
      case "injected":
        this.bridges.ack(s.id, report.id);
        this.announceQueue(s);
        break;
      case "failed": {
        const lost = this.bridges.fail(s.id, report.id);
        log(`session ${s.id}: bridge could not deliver ${report.id || "a request"}: ${report.error}`);
        this.announceQueue(s);
        if (lost && s.child) {
          // it never entered the transcript: hand it to pi's own queue so it is not lost
          s.child.prompt(lost.text, undefined, "steer").catch((err: unknown) => log(`session ${s.id}: steering fallback failed: ${errText(err)}`));
        }
        break;
      }
      case "requeued":
        log(`session ${s.id}: bridge put ${report.ids.join(", ")} back in its queue (not in the transcript yet)`);
        break;
    }
    return true;
  }

  /** The slash commands the session's child offers; falls back to the newest list seen. */
  async slashCommands(s: DaemonSession | undefined): Promise<SlashCommand[]> {
    if (s?.child) {
      try {
        this.lastCommands = await s.child.getCommands();
      } catch (err) {
        log(`get_commands failed: ${errText(err)}`);
      }
    }
    return this.lastCommands;
  }

  /**
   * The server list pi's /mcp prints. pi shows it as a notice, which we catch
   * here instead of passing on, so asking does not flash it at every controller.
   */
  async mcpStatus(s: DaemonSession, timeoutMs = 20_000): Promise<string> {
    const child = s.child;
    if (!child) {
      throw new Error("session is not active");
    }
    return new Promise<string>((resolve, reject) => {
      const done = (settle: () => void) => {
        clearTimeout(timer);
        this.noticeTaps.delete(s.id);
        settle();
      };
      const timer = setTimeout(
        () => done(() => reject(new Error("no answer from /mcp - is the MCP extension loaded?"))),
        timeoutMs,
      );
      this.noticeTaps.set(s.id, (text) => done(() => resolve(text)));
      child.prompt("/mcp").catch((err: unknown) => done(() => reject(err)));
    });
  }

  /** Keep a "toriel-usage" status record from a child's usage extension; true if it was one. */
  private takeUsageReport(event: Record<string, unknown>): boolean {
    if (event.method !== "setStatus" || event.statusKey !== "toriel-usage") {
      return false;
    }
    try {
      const report = JSON.parse(String(event.statusText)) as UsageReport;
      if (report?.v === 1 && typeof report.provider === "string" && Array.isArray(report.windows)) {
        this.usage.set(report.provider, report);
        this.hub.broadcastSessions();
      }
    } catch {
      log("ignored a malformed toriel-usage record");
    }
    return true;
  }

  /** Keep the agent's task list from a "toriel-tasks" status record (ticket 228); true if it was one. */
  private takeTasksReport(s: DaemonSession, event: Record<string, unknown>): boolean {
    if (event.method !== "setStatus" || event.statusKey !== TASKS_KEY) {
      return false;
    }
    const todos = parseTasksReport(event.statusText);
    if (todos === undefined) {
      log(`session ${s.id}: ignored a malformed toriel-tasks record`);
    } else {
      s.tasks = todos.length > 0 ? todos : undefined;
      this.hub.broadcastSessions();
    }
    return true;
  }

  /** Keep plan mode's state from a "toriel-plan" status record (ticket 229): the agent entered or left it, or a session started; true if it was one. */
  private takePlanReport(s: DaemonSession, event: Record<string, unknown>): boolean {
    if (event.method !== "setStatus" || event.statusKey !== PLAN_KEY) {
      return false;
    }
    try {
      const report = JSON.parse(String(event.statusText)) as { v?: number; on?: unknown };
      if (report?.v === 1 && typeof report.on === "boolean") {
        // a session that never was in plan mode has no state (undefined) and is off: only a real flip is announced (ticket 231)
        if ((s.plan ?? false) !== report.on) {
          s.plan = report.on || undefined;
          this.hub.broadcast({ type: "notice", session: s.id, text: report.on ? "plan mode ON: the agent asked to plan first; it can only look until you approve its plan" : "plan mode OFF: you approved the plan, the agent can change things again", durable: true });
        }
        this.hub.broadcastSessions();
      }
    } catch {
      log(`session ${s.id}: ignored a malformed toriel-plan record`);
    }
    return true;
  }

  /** pi settles a dialog with a `timeout` by itself and says nothing, so the record is dropped then too. */
  private expireDialog(s: DaemonSession, dialog: Record<string, unknown>): void {
    const timeout = Number(dialog.timeout);
    if (!(timeout > 0)) {
      return;
    }
    setTimeout(() => {
      if (s.lastDialog === dialog) {
        this.clearDialog(s);
      }
    }, timeout + 1000).unref();
  }

  /**
   * A file-path prompt a grant the user made from an earlier prompt covers is answered "Yes" here, before any controller sees
   * it: pi's chain will not let a grant allow a path ask, so the daemon, which sees every dialog first, does it. Says so in
   * the log and in a notice. False when the prompt is not covered (or not a file-path prompt) and must be shown.
   */
  private answerCovered(s: DaemonSession, request: Record<string, unknown>, value: string | undefined, rule?: AskRule): boolean {
    const covering = this.grants ? answerablePrompt(this.grants, s.sessionId, request, value) : undefined;
    const stdin = (s.child as unknown as { process?: { stdin?: { write(text: string): void } } } | undefined)?.process?.stdin;
    if (!covering || !stdin || typeof request.id !== "string") {
      return false;
    }
    stdin.write(encodeLine({ type: "extension_ui_response", id: request.id, value: "Yes" }));
    // one grant covers a compound command's several specs, so it comes back once per spec: name each grant once
    const ids = [...new Set(covering.map((g) => `#${g.id}`))].join(", ");
    log(`file-path prompt answered by ${ids} for session ${s.sessionId}: ${String(value ?? "")}`);
    recordDecision({ ...this.decisionBase(s, request, value, rule), by: "grant", answer: "yes" });
    this.hub.broadcast({ type: "notice", session: s.id, text: `${GRANT_ANSWERED_NOTICE} ${ids}: ${String(value ?? "a file path")}`, durable: true });
    return true;
  }

  /**
   * Auto mode (ticket 213): a permission prompt in a session with auto mode on is answered "Yes" here, before any controller sees
   * it, unless it is in the always-ask floor (auto-mode.ts), which is shown as usual with a flash saying why. Runs after
   * `answerCovered`, so a grant wins first. Says so in the log and in a notice that reads under the tool call it allowed.
   * "answered" when it did; otherwise the prompt must be shown, with the floor's reason when auto mode was on and stood aside.
   */
  private answerAuto(s: DaemonSession, request: Record<string, unknown>, value: string | undefined, rule: AskRule | undefined): "answered" | { floor?: string } {
    if (!autoOn(s) || !isPermissionPrompt(request)) {
      return {};
    }
    const title = typeof request.title === "string" ? request.title : "";
    const surfaces = (request.toriel as { grants?: Array<{ surface: string }> } | undefined)?.grants;
    const why = floorReason({ title, value, surfaces, rule });
    if (why) {
      log(`auto mode asks about a prompt for session ${s.sessionId}: ${why}`);
      this.hub.broadcast({ type: "notice", session: s.id, text: `auto mode still asks about this one: ${why}` });
      return { floor: why };
    }
    const stdin = (s.child as unknown as { process?: { stdin?: { write(text: string): void } } } | undefined)?.process?.stdin;
    if (!stdin) {
      return {};
    }
    stdin.write(encodeLine({ type: "extension_ui_response", id: request.id, value: "Yes" }));
    const what = promptSubject(title, value).slice(0, 160) || "a prompt";
    log(`prompt answered by auto mode for session ${s.sessionId}: ${what}`);
    this.hub.broadcast({ type: "notice", session: s.id, text: `${AUTO_ANSWERED_NOTICE}: ${what}`, durable: true });
    recordDecision({ ...this.decisionBase(s, request, value, rule), by: "auto", answer: "yes" });
    return "answered";
  }

  /** What the decision log says about a permission prompt before anyone has answered it (ticket 239). */
  private decisionBase(s: DaemonSession, request: Record<string, unknown>, value: string | undefined, rule?: AskRule, floor?: string): DecisionBase {
    const grants = (request.toriel as { grants?: Array<{ surface: string }> } | undefined)?.grants ?? [];
    const title = typeof request.title === "string" ? request.title : "";
    return {
      session: s.id,
      sessionId: s.sessionId,
      agent: s.agent?.name ?? null,
      title: brief(title.split("\n")[0], 100),
      surfaces: [...new Set(grants.map((g) => g.surface))],
      value: brief(value),
      ...(rule ? { rule: { explicit: rule.explicit, pattern: rule.pattern, origin: rule.origin } } : {}),
      auto: autoOn(s),
      ...(floor ? { floor } : {}),
      attended: s.attachedTo !== undefined,
      ...(s.scope ? { scope: s.scope.mode } : {}),
    };
  }

  /** How long a permission prompt or question of this session may wait before it is denied or dismissed (ticket 88): its own setting, else the global one; undefined = for ever. */
  denyAfterMs(s: DaemonSession): number | undefined {
    if (s.denyAfter !== undefined) {
      return s.denyAfter === null ? undefined : s.denyAfter;
    }
    const text = loadSettings().settings.permissionDenyAfter;
    const d = text === undefined ? undefined : parseDurationText(text);
    return d?.ok ? d.ms : undefined;
  }

  /**
   * Ticket 88: opt-in, never the default. A permission prompt still unanswered after the session's deny-after is answered "No" here,
   * the same way a user's No is, and a durable notice says it was automatic (and why), so a session nobody watches fails the action
   * instead of waiting for ever. A question an agent put to the user (the ask-the-user tool's dialogs, any other extension's picker)
   * is dismissed the same way, as if the user had cancelled it, so a run nobody watches goes on without an answer.
   */
  private armDeny(s: DaemonSession, request: Record<string, unknown>, value: string | undefined, ms: number | undefined): void {
    clearTimeout(s.denyTimer);
    if (ms === undefined) {
      return;
    }
    s.denyTimer = setTimeout(() => {
      s.denyTimer = undefined;
      const stdin = (s.child as unknown as { process?: { stdin?: { write(text: string): void } } } | undefined)?.process?.stdin;
      if (!s.pendingDialog || s.lastDialog !== request || !stdin || typeof request.id !== "string") {
        return;
      }
      const permission = isPermissionPrompt(request);
      stdin.write(encodeLine(permission ? { type: "extension_ui_response", id: request.id, value: "No" } : { type: "extension_ui_response", id: request.id, cancelled: true }));
      const title = typeof request.title === "string" ? request.title : "";
      const what = (permission ? promptSubject(title, value) : (title.split("\n")[0] ?? "")).slice(0, 160) || (permission ? "a prompt" : "a question");
      log(`${permission ? "prompt denied" : "question dismissed"} after ${fmtDuration(ms)} without an answer for session ${s.sessionId}: ${what}`);
      if (s.dialogInfo) {
        recordDecision({ ...s.dialogInfo.base, by: "deny-after", answer: permission ? "no" : "cancelled", waitMs: Date.now() - s.dialogInfo.at });
        s.dialogInfo = undefined;
      }
      this.clearDialog(s);
      this.hub.broadcast({ type: "notice", session: s.id, text: `${permission ? AUTO_DENIED_NOTICE : AUTO_DISMISSED_NOTICE}: nobody answered in ${fmtDuration(ms)}: ${what}`, durable: true });
    }, ms);
    s.denyTimer.unref();
  }

  private clearDialog(s: DaemonSession): void {
    clearTimeout(s.denyTimer);
    s.denyTimer = undefined;
    if (s.dialogInfo) {
      recordDecision({ ...s.dialogInfo.base, by: "dropped", waitMs: Date.now() - s.dialogInfo.at });
      s.dialogInfo = undefined;
    }
    if (s.pendingDialog) {
      s.pendingDialog = false;
      s.lastDialog = undefined;
      this.hub.broadcastSessions();
    }
  }

  private onEvent(s: DaemonSession, event: Record<string, unknown>): void {
    const type = event.type as string;
    this.onActivity?.(s);
    if (type === "extension_ui_request") {
      if (this.takeUsageReport(event) || this.takeBridgeReport(s, event) || this.takeTasksReport(s, event) || this.takePlanReport(s, event)) {
        return; // for the daemon, not for controllers
      }
      const tap = this.noticeTaps.get(s.id);
      if (tap && event.method === "notify") {
        tap(String(event.message ?? ""));
        return;
      }
      // a select dialog may carry the grant the toriel-grants link saw for it
      const asked = s.suggestion?.value;
      const suggested = DIALOG_METHODS.has(event.method as string) ? withSuggestion(event, s.suggestion, Date.now()) : event;
      // an ask about the grants file or pi's config is always asked: say so instead of offering rows that could only be refused
      const request = event.method === "select" && touchesProtected(typeof event.title === "string" ? event.title : "") ? { ...suggested, toriel: { protectedAsk: true } } : suggested;
      let shown: Record<string, unknown> = request;
      if (DIALOG_METHODS.has(event.method as string)) {
        // the reason for the ask (ticket 213) is read before the suggestion is used up below: most asks carry a grant to suggest, so it is cleared for them
        const rule = ruleFor(event, s.suggestion, Date.now());
        // only the dialog that took the suggestion uses it up: an unrelated one arriving first must not lose it
        if (suggested !== event || rule !== undefined) {
          s.suggestion = undefined;
        }
        if (this.answerCovered(s, request, asked, rule)) {
          return; // answered from a grant: nobody is asked
        }
        const auto = this.answerAuto(s, request, asked, rule);
        if (auto === "answered") {
          return; // answered by auto mode
        }
        // the decision log says who answers this one when somebody does (handleUiResponse, the deny-after timer, clearDialog)
        s.dialogInfo = isPermissionPrompt(request) ? { at: Date.now(), base: this.decisionBase(s, request, asked, rule, auto.floor) } : undefined;
        // ticket 220: the dialog says when it will be denied, so the wait is not silent; the same request is kept as lastDialog (a reattach sends it again)
        const denyMs = this.denyAfterMs(s);
        shown = denyMs === undefined ? request : { ...request, toriel: { ...(request.toriel as object | undefined), denyAt: Date.now() + denyMs } };
        s.pendingDialog = true;
        s.lastDialog = shown;
        this.hub.broadcastSessions();
        this.expireDialog(s, shown);
        this.armDeny(s, shown, asked, denyMs);
      }
      // Dialogs go to the attached controller; fire-and-forget records and
      // unattached dialogs broadcast so somebody can pick them up.
      const message = { type: "ui_request" as const, session: s.id, request: shown };
      if (s.attachedTo) {
        this.hub.send(s.attachedTo, message);
      } else {
        this.hub.broadcast(message);
      }
      return;
    }
    this.hub.broadcast({ type: "event", session: s.id, event });
    // the append itself: the transcript, not an inference, says an inject landed
    const injected = injectedId(event);
    if (injected !== undefined) {
      this.bridges.ack(s.id, injected);
      this.announceQueue(s);
    }
    if (type === "message_end") {
      const usage = (event.message as { usage?: { totalTokens?: number; cost?: { total?: number } } } | undefined)?.usage;
      if (usage) {
        s.totalTokens += usage.totalTokens ?? 0;
        s.totalCost += usage.cost?.total ?? 0;
      }
      this.onAssistantMessage?.(s, event.message as Parameters<NonNullable<ChildManager["onAssistantMessage"]>>[1]);
    }
    if (type === "message_start" || type === "message_end" || type === "agent_start" || type === "agent_settled") {
      log(
        `session ${s.id} event: ${type}${type === "message_end" ? ` stop=${(event.message as { stopReason?: string })?.stopReason}` : ""}`,
      );
    }
    if (type === "queue_update") {
      // queue events were invisible here, which is exactly where a stuck strip hides
      const steering = (event.steering as string[] | undefined) ?? [];
      log(`session ${s.id} event: queue_update steering=${steering.length}`);
    }
    if (type === "agent_start") {
      s.streaming = true;
      this.hub.broadcastSessions();
    } else if (type === "agent_settled") {
      s.streaming = false;
      this.onSettled?.(s);
      // no tool can still be asking once the turn is over
      this.clearDialog(s);
      void this.refreshMeta(s).then(() => this.hub.broadcastSessions());
      void this.announceDigest(s);
    } else if (type === "compaction_start") {
      s.compacting = true;
      this.hub.broadcastSessions();
    } else if (type === "compaction_end") {
      // a manual compaction runs outside any agent run, so agent_settled would not clear it
      s.compacting = false;
      this.hub.broadcastSessions();
      this.onSettled?.(s);
      // compaction can move the active branch off the name entry, so pi reports an older name: look now, not at the next settle
      if (s.wantedName !== undefined) {
        void this.refreshMeta(s).then(() => this.hub.broadcastSessions());
      }
    }
  }

  /** Tell controllers how many messages pi holds so one that drifted can ask for a resync. */
  private async announceDigest(s: DaemonSession): Promise<void> {
    try {
      // counted the way a history replay is built, so a resync always lands on the same number
      const messages = s.child ? await historyLength(s) : undefined;
      if (messages !== undefined) {
        this.hub.broadcast({ type: "digest", session: s.id, messages, streaming: s.streaming });
      }
    } catch (err) {
      log(`session ${s.id}: digest failed: ${errText(err)}`);
    }
  }
}
