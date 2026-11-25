// The /commands toriel handles itself inside a session (SESSION_COMMANDS);
// anything else typed with a leading slash goes to pi.
import { readdirSync, type Dirent } from "node:fs";
import * as path from "node:path";
import { type Invocation, listing, parseCommandLine } from "./cli.ts";
import { SESSION_COMMANDS, type SessionCommandName } from "./commands.ts";
import { fmtTokens } from "./format.ts";
import { detachFromParent, loadLineage } from "./lineage.ts";
import { relationOf } from "./session-tree.ts";
import { piAgentDir } from "./pi-dir.ts";
import { ModeNoticeDebounce, modeOf, nextMode, switches } from "./mode-cycle.ts";
import { probeEntry, parseStatusDetailed, readConfigs, statusReport } from "./mcp-doctor.ts";
import { addMcpServer, readMcpYaml, removeMcpServer, setMcpServerHeaders } from "./mcp-config.ts";
import { bearerEnvHeader, bearerTokenHeader, MCP_ACTIONS, type McpAuthOptions, type McpEntry, mcpConfigFile, mcpEntry, mcpListLines, mcpServerConnected, parseHeaderArg, withHeaders } from "./mcp.ts";
import { mcpExplorePrompt } from "./mcp-explore-prompt.ts";
import { gatewayKind, probeLitellmAsync } from "./litellm-models.ts";
import { addProvider, apiKeyValue, checkProviderId, DEFAULT_API, fetchModels, listProviders, MAX_MODELS, type NewModel, type ProviderOptions, type ProviderRow, removeProvider, resolveForProbe, setProviderKey } from "./providers.ts";
import { readHeader } from "./session-file.ts";
import { mayWake } from "./wake-on-type.ts";
import { forkName, placeFork } from "./fork-placement.ts";
import { loadGroups, saveGroups, withComment, withParked } from "./groups.ts";
import type { Host } from "./host.ts";
import { displayName } from "./session-list.ts";
import { runFeedback } from "./feedback-command.ts";
import { askBtw, saveBtw } from "./btw.ts";
import { runPerformance, savePerformance } from "./performance.ts";
import { loadSettings, resolveChildConfig } from "./settings.ts";
import { explainLastThinking } from "./why.ts";
import { listing as taskListing } from "../pi/extensions/lib/tasks.ts";
import { newView } from "./transcript.ts";
import { continuePrompt } from "./continue-prompt.ts";
import { styleHelp, styleListing } from "./help-format.ts";
import { INIT_PROMPT } from "./init-prompt.ts";
import type { SessionMeta } from "./shared.ts";
import { runDoctorCommand } from "./doctor-commands.ts";
import { renameNotice } from "./session-id.ts";
import { runPermissions } from "./permission-commands.ts";
import { addSchedule, addWatch, operateSchedule, showSchedules } from "./schedule-commands.ts";
import { errText } from "./util.ts";
import { fmtClock, fmtDuration } from "./when.ts";
import { log } from "./log.ts";

const COMPACT_TIMEOUT_MS = 10 * 60_000;

/** The name of the review session /performance opens: `performance review <YYYY-MM-DD HH:MM>`, local time. */
export function performanceReviewName(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `performance review ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`;
}

/**
 * The opening message of the review session /performance opens. The report
 * itself follows as a delivered message once the analysis completes, so the
 * seed only frames the session and asks for a brief hold.
 * Lives here (not controller.ts) so tests can import it - controller.ts runs
 * main() on import and cannot be loaded by a test.
 */
export function performanceReviewSeed(): string {
  return `Performance review of a toriel session (created by /performance). The analysis is running; the report will be delivered to this session as a message when it completes. Treat it as this session's starting context: when you act on it, work from the findings rather than re-running the analysis. Until it arrives, just acknowledge briefly that you are waiting for it.`;
}

export class SessionCommands {
  private readonly h: Host;
  /** The throwaway analysis run; injectable so tests do not spawn pi. */
  private readonly runPerf: typeof runPerformance;

  /** The one "which mode" line after a burst of shift+tab presses (ticket 236). */
  readonly modeNotice: ModeNoticeDebounce;

  constructor(host: Host, runPerf: typeof runPerformance = runPerformance, modeNotice?: ModeNoticeDebounce) {
    this.h = host;
    this.modeNotice = modeNotice ?? new ModeNoticeDebounce((session) => this.announceMode(session));
    this.runPerf = runPerf;
  }

  /** Run a "/name args" line; false when it is not one of ours (send it to pi). */
  run(text: string): boolean {
    const parsed = parseCommandLine(SESSION_COMMANDS, text);
    switch (parsed.kind) {
      case "unknown":
        return false;
      case "help":
        this.h.infoPanel.show(styleHelp(parsed.text));
        this.h.tui.requestRender();
        break;
      case "error":
        // the line stays in the editor so it can be corrected
        this.h.notify(`/${parsed.spec.name}: ${parsed.message} (/${parsed.spec.name} --help)`);
        return true;
      case "run":
        // a handler that throws (a failed saveGroups, say) must show a notice, not become an unhandled rejection
        // the executor form, so a synchronous throw from a handler rejects the promise too
        new Promise<void>((resolve) => resolve(this.handlers()[parsed.spec.name as SessionCommandName](parsed.call))).catch((err: unknown) => {
          this.h.notify(`/${parsed.spec.name} failed: ${errText(err)}`);
        });
        if (parsed.spec.name === "exit") {
          return true;
        }
        break;
      default:
        parsed satisfies never;
    }
    this.h.editor.setText("");
    return true;
  }

  /** One handler per SESSION_COMMANDS entry (the Record type makes a missing one a compile error). */
  private handlers(): Record<SessionCommandName, (call: Invocation) => void | Promise<void>> {
    const rename = (c: Invocation) => this.rename(c.args.join(" "));
    return {
      mouse: (c) => this.h.setMouse(c.args[0] ?? ""),
      exit: () => this.h.dispose(),
      quit: () => this.h.switching.open(),
      park: () => this.park(),
      publish: (c) => this.publish(c.args[0]),
      btw: (c) => this.btw(c.args.join(" "), c.opts.model as string | undefined),
      performance: (c) => this.performance(c.opts.model as string | undefined),
      comment: (c) => this.comment(c.args.join(" "), c.opts.clear === true),
      help: () => {
        this.h.infoPanel.show(styleListing(listing(SESSION_COMMANDS)));
        this.h.tui.requestRender();
      },
      abort: () => this.abort(),
      auto: (c) => this.auto(c.args.join(" ")),
      "deny-after": (c) => this.denyAfter(c.args.join(" ")),
      background: () => this.background(),
      parent: () => this.parent(),
      detach: () => this.detach(),
      name: rename,
      rename,
      reload: () => this.reload(),
      cd: (c) => this.cd(c.args.join(" ")),
      model: (c) => this.model(c.args.join(" "), c.opts.list === true),
      think: (c) => this.think(c.args.join(" "), c.opts.list === true),
      fork: (c) => this.fork(c.opts.name as string | undefined, c.opts.switch !== false, c.args.join(" "), c.opts.keepPermissions === true),
      feedback: (c) => runFeedback(this.h, c, this.h.viewing ?? undefined),
      why: (c) => this.why(c.opts.model as string | undefined),
      init: () => this.init(),
      continue: (c) => this.continueAfterAbort(c.args.join(" ")),
      clear: () => this.clear(),
      compact: (c) => this.compact(c.args.join(" ")),
      provider: (c) => this.provider(c.args[0], c.args[1], c.args[2], { keyEnv: c.opts.keyEnv as string | undefined, noKey: c.opts.key === false, noModels: c.opts.models === false, api: c.opts.api as string | undefined }),
      login: (c) => this.login(c.args[0], c.opts.keyEnv as string | undefined),
      mcp: (c) => this.mcp(c.args[0], c.args[1], c.args.slice(2), { token: c.opts.token === true, bearerEnv: c.opts.bearerEnv as string | undefined, headers: (c.opts.header as string[] | undefined) ?? [] }),
      in: (c) => addSchedule(this.h, "in", "in", c, this.viewedMeta()?.id),
      at: (c) => addSchedule(this.h, "at", "at", c, this.viewedMeta()?.id),
      every: (c) => addSchedule(this.h, "every", "every", c, this.viewedMeta()?.id),
      loop: (c) => addSchedule(this.h, "loop", "loop", c, this.viewedMeta()?.id),
      cron: (c) => addSchedule(this.h, "cron", "cron", c, this.viewedMeta()?.id),
      watch: (c) => addWatch(this.h, c, this.viewedMeta()?.id),
      tasks: () => this.tasks(),
      plan: (c) => this.plan(c.args.join(" ")),
      schedules: (c) => showSchedules(this.h, c.opts.all === true ? undefined : this.viewedMeta()?.id),
      cancel: (c) => operateSchedule(this.h, "cancel", c, this.viewedMeta()?.id),
      pause: (c) => operateSchedule(this.h, "pause", c, this.viewedMeta()?.id),
      resume: (c) => operateSchedule(this.h, "resume", c, this.viewedMeta()?.id),
      fire: (c) => operateSchedule(this.h, "fire", c, this.viewedMeta()?.id),
      permissions: (c) => runPermissions(this.h, c, this.viewedMeta()?.id),
      doctor: (c) => runDoctorCommand(this.h, c),
    };
  }

  /**
   * Show, set (`text`) or remove (`clear`) the viewed session's comment. Only
   * toriel's own state: does not wake the session.
   */
  private comment(text: string, clear: boolean): void {
    const meta = this.viewedMeta();
    const sessionId = meta?.sessionId ?? (this.h.viewing ? this.h.local.get(this.h.viewing)?.id : undefined);
    if (!sessionId) {
      this.h.notify("nothing to comment on yet - send a message first");
      return;
    }
    const groups = loadGroups();
    if (!clear && !text.trim()) {
      const current = groups.comments?.[sessionId];
      this.h.notify(current ? `comment: ${current}` : "no comment - /comment <text> to set one");
      return;
    }
    groups.comments = withComment(groups, sessionId, clear ? "" : text);
    saveGroups(groups);
    this.h.notify(clear ? "comment removed" : "comment saved");
  }

  /**
   * Publish the viewed session to chat, or stop (ticket 269). Does NOT wake a sleeping session: it only sets the daemon's flag,
   * keyed by the session's id.
   */
  private async publish(state: string | undefined): Promise<void> {
    const word = state?.trim().toLowerCase();
    if (word !== undefined && word !== "" && word !== "off" && word !== "on") {
      this.h.notify("publish: say /publish or /publish off");
      return;
    }
    const key = this.h.viewing;
    const sessionId = this.viewedMeta()?.sessionId ?? (key ? this.h.local.get(key)?.id : undefined);
    if (!sessionId) {
      this.h.notify("nothing to publish yet - send a message first");
      return;
    }
    try {
      const on = word !== "off";
      await this.h.request({ type: "publish", sessionId, on });
      this.h.notify(on ? "published to chat (shows once the chat bridge runs; /park or /publish off stops)" : "no longer published to chat");
    } catch (err) {
      this.h.notify(`publish failed: ${errText(err)}`);
    }
  }

  /** Mark the viewed session parked, stop its process unless it is busy, and return to the switcher. */
  private async park(): Promise<void> {
    const key = this.h.viewing;
    const meta = this.viewedMeta();
    const sessionId = meta?.sessionId ?? (key ? this.h.local.get(key)?.id : undefined);
    if (!sessionId) {
      this.h.notify("nothing to park yet - send a message first");
      return;
    }
    const groups = loadGroups();
    groups.parked = withParked(groups, sessionId, true);
    saveGroups(groups);
    if (meta?.published) {
      // parking closes the chat channel and the session stays unpublished until /publish says otherwise (ticket 269)
      await this.h.request({ type: "publish", sessionId, on: false }).catch(() => undefined);
    }
    let note = "parked";
    if (meta?.active) {
      if (meta.streaming || meta.pendingDialog) {
        note = "parked (still running: it is working or waiting on you)";
      } else {
        try {
          await this.h.request({ type: "deactivate", session: meta.id });
          note = "parked and stopped";
        } catch (err) {
          note = `parked, but stopping it failed: ${errText(err)}`;
        }
      }
    }
    this.h.switching.open();
    this.h.switcher.hint = `${note} (using it again unparks it)`;
    this.h.tui.requestRender();
  }

  private viewedMeta(): SessionMeta | undefined {
    return this.h.viewing ? this.h.metaForPath(this.h.viewing) : undefined;
  }

  /**
   * The viewed session with a child we may drive. A session that is only a file
   * (after a controller or daemon restart, or stopped) is started first, so
   * commands work without sending a throwaway message; says why when it cannot.
   */
  async liveMeta(): Promise<SessionMeta | undefined> {
    let meta = this.viewedMeta();
    if (meta?.attachedElsewhere) {
      this.h.notify("view-only: this session is attached in another controller");
      return undefined;
    }
    if (!meta?.active) {
      meta = await this.startViewed();
    }
    return meta;
  }

  /**
   * The user is typing a /command or !command into the viewed session: start it if it sleeps, so pi's command
   * list and completions that ask the child exist by the time they are wanted (ticket 68). Quiet when the
   * session may not be woken (see `mayWake`; the daemon also refuses a file another pi may have open) and
   * on failure: sending the message starts it the ordinary way and reports what went wrong.
   */
  async wakeForTyping(): Promise<void> {
    const key = this.h.viewing;
    // no `known` requirement: after a daemon restart a session file the daemon has not
    // registered yet has no meta here either, and the daemon applies its own refusal checks
    // (presence, the 60 s fresh-mtime check, wasHandled) to unregistered files (ticket 202)
    const known = this.viewedMeta() ?? (key ? this.h.local.get(key) : undefined);
    if (!key || !mayWake(key, this.viewedMeta(), this.h.switching.isOpen)) {
      log(`wake-on-type: wakeForTyping guard: key=${key ?? "none"} meta=${JSON.stringify(this.viewedMeta())} switcherOpen=${this.h.switching.isOpen}`);
      return;
    }
    try {
      log(`wake-on-type: sending spawn for ${key}`);
      this.h.notify("starting session...");
      // the file's own header knows the session's cwd; the storage directory is a last resort
      const header = readHeader(key);
      const headerCwd = typeof header?.cwd === "string" ? (header.cwd as string) : undefined;
      const r = (await this.h.request({ type: "spawn", sessionFile: key, cwd: known?.cwd || headerCwd || path.dirname(key), ready: true, wake: true })) as { woke?: boolean; reason?: string };
      log(`wake-on-type: spawn answered woke=${String(r?.woke)} reason=${r?.reason ?? "-"}`);
      if (r?.woke === false) {
        this.h.notify(`session not started: ${r.reason ?? "refused"}`);
        return;
      }
      this.h.refreshPiCommands();
    } catch (err) {
      log(`wake-on-type: spawn failed: ${errText(err)}`);
      // the message will start it, and say what is wrong
    }
  }

  /** Resume the viewed session's file in a fresh child, without prompting it. */
  private async startViewed(): Promise<SessionMeta | undefined> {
    const key = this.h.viewing;
    const known = this.viewedMeta() ?? (key ? this.h.local.get(key) : undefined);
    if (!key?.startsWith("/") || !known) {
      this.h.notify("nothing to start yet - send a message first");
      return undefined;
    }
    try {
      this.h.notify("starting session...");
      const r = (await this.h.request({
        type: "spawn",
        sessionFile: key,
        cwd: known.cwd || path.dirname(key),
        ready: true,
      })) as { sessionId?: number };
      const meta = typeof r?.sessionId === "number" ? this.h.sessions.get(r.sessionId) : undefined;
      if (!meta?.active) {
        throw new Error("the session did not start");
      }
      return meta;
    } catch (err) {
      this.fail("start", err);
      return undefined;
    }
  }

  private fail(what: string, err: unknown): void {
    this.h.notify(`${what} failed: ${errText(err)}`);
  }

  /**
   * Move the command(s) the agent is waiting for to the background (ctrl-b while the
   * agent works, or /background). Needs a running child but never wakes a sleeping
   * session: with nothing running there is nothing to move. The session's pi answers
   * with the notice that says what moved.
   */
  background(): void {
    const meta = this.viewedMeta();
    const view = this.h.viewing ? this.h.views.get(this.h.viewing) : undefined;
    const working = Boolean(meta?.streaming) || (view?.echoes.length ?? 0) > 0;
    if (meta?.id === undefined || !meta.attachedToYou || !working) {
      this.h.notify("nothing is running here to move to the background");
      return;
    }
    // short timeout: an answer takes milliseconds, and a daemon older than this controller never answers a request it does not know
    this.h.request({ type: "background", session: meta.id }, 5000).catch((err: unknown) => {
      const stale = err instanceof Error && /timed out/.test(err.message);
      this.h.notify(stale ? "background: no answer from the daemon (is it older than this toriel? restart it: toriel kill-server)" : `background failed: ${errText(err)}`);
    });
  }

  /**
   * /auto (ticket 213; shift+tab is `cycleMode`): switch auto mode for the viewed session. The daemon says what happened in the transcript
   * (a durable notice), so nothing is announced here on success. Needs no child: it is a flag the daemon keeps.
   */
  async auto(text = ""): Promise<void> {
    const meta = this.viewedMeta();
    if (meta?.id === undefined) {
      this.h.notify("auto mode needs a session - send a message first");
      return;
    }
    const words = text.trim().split(/\s+/).filter(Boolean);
    const head = words[0]?.toLowerCase();
    if (head === "status") {
      this.h.notify(meta.auto ? `auto mode is ON${meta.autoUntil !== undefined ? ` until ${fmtClock(meta.autoUntil, new Date())}` : ""} (/auto off)` : "auto mode is off (/auto, or shift+tab, turns it on)");
      return;
    }
    let on: boolean | undefined;
    let duration: string | undefined;
    if (head === "on") {
      on = true;
      duration = words.slice(1).join(" ") || undefined;
    } else if (head === "off") {
      on = false;
    } else if (head) {
      on = true;
      duration = words.join(" ");
    }
    try {
      await this.h.request({ type: "auto_mode", session: meta.id, on, for: duration }, 5000);
    } catch (err) {
      const stale = err instanceof Error && /timed out/.test(err.message);
      this.h.notify(stale ? "auto mode: no answer from the daemon (is it older than this toriel? restart it: toriel kill-server)" : `auto mode failed: ${errText(err)}`);
    }
  }

  /**
   * shift+tab (tickets 213, 233): the next mode of normal -> auto -> plan -> normal for the viewed session. Each flag change is the same
   * command /auto and /plan send, so the daemon announces it in the transcript; nothing is said here on success. Needs no child.
   */
  async cycleMode(): Promise<void> {
    const meta = this.viewedMeta();
    if (meta?.id === undefined) {
      this.h.notify("modes need a session - send a message first");
      return;
    }
    try {
      // quiet: the mode applies now, the line saying so waits until the presses stop (one line for the mode settled on, ticket 236);
      // the before/after pair tells the debounce which bursts wrapped back to the mode they started in, which announce nothing
      const target = nextMode(meta);
      for (const change of switches(meta, target)) {
        await this.h.request(change.flag === "plan" ? { type: "plan_mode", session: meta.id, on: change.on, quiet: true } : { type: "auto_mode", session: meta.id, on: change.on, quiet: true }, 5000);
        this.modeNotice.poke(meta.id, { before: modeOf(meta), after: target });
      }
    } catch (err) {
      const stale = err instanceof Error && /timed out|unknown command/i.test(err.message);
      this.h.notify(stale ? "mode: no answer from the daemon (is it older than this toriel? restart it: toriel kill-server)" : `mode change failed: ${errText(err)}`);
    }
  }

  private announceMode(session: number): void {
    this.h.request({ type: "mode_notice", session }, 5000).catch((err: unknown) => {
      const stale = err instanceof Error && /timed out|unknown command/i.test(err.message);
      this.h.notify(stale ? "mode: no answer from the daemon (is it older than this toriel? restart it: toriel kill-server)" : `mode notice failed: ${errText(err)}`);
    });
  }

  /** `/deny-after <duration|off|default|status>` (ticket 88). */
  private async denyAfter(text: string): Promise<void> {
    const meta = this.viewedMeta();
    if (meta?.id === undefined) {
      this.h.notify("deny-after: open a session first");
      return;
    }
    try {
      const reply = (await this.h.request({ type: "deny_after", session: meta.id, after: text.trim() || "status" }, 5000)) as { ms?: number } | undefined;
      if (text.trim() === "" || text.trim().toLowerCase() === "status") {
        this.h.notify(reply?.ms === undefined ? "deny-after is off: permission prompts wait until you answer" : `deny-after is ${fmtDuration(reply.ms)}: an unanswered permission prompt is denied after that`);
      }
    } catch (err) {
      const stale = err instanceof Error && /timed out/.test(err.message);
      this.h.notify(stale ? "deny-after: no answer from the daemon (is it older than this toriel? restart it: toriel kill-server)" : `deny-after failed: ${errText(err)}`);
    }
  }

  private abort(): void {
    const meta = this.viewedMeta();
    if (meta?.id !== undefined && meta.attachedToYou) {
      this.h.send({ type: "abort", session: meta.id });
      this.h.notify("abort sent");
    } else {
      this.h.notify("nothing to abort here");
    }
  }

  private async rename(name: string): Promise<void> {
    const meta = this.viewedMeta();
    if (!name) {
      this.h.notify(meta?.sessionName ? `name: ${meta.sessionName}${meta.sessionId ? ` (id ${meta.sessionId})` : ""}` : "unnamed - /name <name> to set one");
      return;
    }
    const key = this.h.viewing;
    if (!meta && !key?.startsWith("/")) {
      this.h.notify("nothing to name yet - send a message first");
      return;
    }
    try {
      const unique = this.h.uniqueSessionName(name, key ?? undefined);
      const r = (await this.h.request(meta ? { type: "rename", session: meta.id, name: unique } : { type: "rename", path: key!, name: unique })) as { name?: string; nameVerified?: boolean } | undefined;
      this.h.notify(renameNotice(name, r?.name ?? unique, r?.nameVerified));
    } catch (err) {
      this.fail("rename", err);
    }
  }

  private async reload(): Promise<void> {
    if (!this.viewedMeta()?.active) {
      // starting it loads everything fresh already
      if (await this.startViewed()) {
        this.h.notify("started - extensions, skills and settings loaded");
      }
      return;
    }
    const meta = await this.liveMeta();
    if (!meta) {
      return;
    }
    try {
      this.h.notify("reloading...");
      await this.h.request({ type: "reload", session: meta.id });
      this.h.notify("reloaded - extensions, skills and settings re-read");
    } catch (err) {
      this.fail("reload", err);
    }
  }

  private async cd(dir: string): Promise<void> {
    const key = this.h.viewing;
    if (!dir.trim()) {
      this.h.notify(key ? `this session runs in ${this.h.cwdFor(key)}` : "no session open");
      return;
    }
    const meta = await this.liveMeta();
    if (!meta) {
      return;
    }
    try {
      const r = (await this.h.request({ type: "cd", session: meta.id, dir })) as { cwd: string; changed: boolean };
      this.h.notify(r.changed ? `moved to ${r.cwd} - pi restarted there; the conversation is unchanged` : `already in ${r.cwd}`);
    } catch (err) {
      this.fail("cd", err);
    }
  }

  private async model(query: string, list: boolean): Promise<void> {
    const meta = await this.liveMeta();
    if (!meta) {
      return;
    }
    try {
      if (list || !query) {
        const r = (await this.h.request({ type: "model", session: meta.id })) as { current: string; models: string[] };
        if (list) {
          const rows = r.models.map((m) => `${m === r.current ? "*" : " "} ${m}`);
          this.h.infoPanel.show(`Models (* = current)\n\n${rows.join("\n")}\n\n/model <words> switches to the one that matches`);
        } else {
          this.h.choicePanel.open("Switch model", r.models, r.current, (choice) => void this.model(choice, false));
        }
        this.h.tui.requestRender();
        return;
      }
      const r = (await this.h.request({ type: "model", session: meta.id, query })) as { model: string };
      this.h.notify(`model: ${r.model}`);
    } catch (err) {
      this.fail("model", err);
    }
  }

  /** Show or set the thinking level. Needs a running pi child (it asks and sets over RPC), so it starts a sleeping session. */
  private async think(level: string, list: boolean): Promise<void> {
    const meta = await this.liveMeta();
    if (!meta) {
      return;
    }
    try {
      if (!level.trim()) {
        const r = (await this.h.request({ type: "think", session: meta.id })) as { current: string; levels: string[] };
        if (list) {
          this.h.notify(`thinking level: ${r.current} (available: ${r.levels.join(", ")})`);
        } else {
          this.h.choicePanel.open("Thinking level", r.levels, r.current, (choice) => void this.think(choice, false));
          this.h.tui.requestRender();
        }
        return;
      }
      const r = (await this.h.request({ type: "think", session: meta.id, level: level.trim() })) as { level: string };
      this.h.notify(`thinking level: ${r.level}`);
    } catch (err) {
      this.fail("think", err);
    }
  }

  private async fork(name: string | undefined, enter: boolean, prompt: string, keepPermissions: boolean): Promise<void> {
    const meta = this.viewedMeta();
    const key = this.h.viewing;
    if (!key?.startsWith("/")) {
      this.h.notify("nothing to fork yet - send a message first");
      return;
    }
    // a busy session is forked too: the daemon copies it up to its last finished step and the original runs on
    const busy = Boolean(meta?.streaming);
    try {
      const cwd = this.h.cwdFor(key);
      const parentName = displayName(meta, this.h.local.get(key));
      const r = (await this.h.request({
        type: "adopt",
        path: key,
        cwd,
        fork: true,
        name: this.h.uniqueSessionName(name ?? forkName(parentName)),
        parentName,
        keepPermissions,
      })) as { sessionId?: number; sessionUuid?: string; grantsCopied?: number; name?: string; nameVerified?: boolean };
      if (typeof r?.sessionId !== "number") {
        throw new Error("no session id");
      }
      this.placeInSwitcher(meta?.sessionId ?? this.h.local.get(key)?.id, r.sessionUuid);
      const extras = [
        r.nameVerified === false ? `pi has not confirmed the name ${r.name ?? ""}; toriel keeps asserting it` : "",
        busy ? "copied up to the last finished step; the original keeps running" : "",
        keepPermissions ? `${r.grantsCopied ?? 0} permission${r.grantsCopied === 1 ? "" : "s"} copied` : "",
      ].filter(Boolean);
      const note = extras.length > 0 ? ` (${extras.join("; ")})` : "";
      const forked = this.h.sessions.get(r.sessionId);
      if (!enter) {
        // the copy runs in the background; this view stays put
        if (prompt) {
          await this.h.request({ type: "prompt", session: r.sessionId, message: prompt });
        }
        this.h.notify(`forked${prompt ? " and prompted" : ""}${note} - still in the original; the copy is in the switcher`);
        return;
      }
      if (forked) {
        this.h.viewing = this.h.keyFor(forked);
        this.h.rebuildChat();
        if (prompt) {
          void this.h.session.prompt(prompt);
        }
      } else {
        this.h.pendingEnterId = r.sessionId;
        this.h.pendingPrompt = prompt || null;
      }
      this.h.notify(`forked${note} - you are in the copy; the original is unchanged`);
    } catch (err) {
      this.fail("fork", err);
    }
  }

  /** The fork sits right below its parent, in the parent's group. */
  private placeInSwitcher(parentId: string | undefined, forkId: string | undefined): void {
    if (!parentId || !forkId) {
      return;
    }
    const groups = loadGroups();
    placeFork(groups, parentId, forkId);
    saveGroups(groups);
  }

  private async clear(): Promise<void> {
    const meta = await this.liveMeta();
    const key = this.h.viewing;
    if (!meta || !key) {
      return;
    }
    if (meta.streaming) {
      this.h.notify("session is working; abort it first");
      return;
    }
    try {
      await this.h.request({ type: "clear", session: meta.id });
      this.h.views.set(key, newView());
      this.h.summaries.delete(key);
      this.h.rebuildChat();
      this.h.syncHistory(true);
      void this.h.loadLocal();
      this.h.notify("cleared - same session, empty conversation (old contents moved to trash)");
    } catch (err) {
      this.fail("clear", err);
    }
  }

  /**
   * /btw: a copy of the session answers one question without tools while the
   * user carries on. Reads the session file only, so a sleeping session stays asleep.
   */
  private async btw(question: string, model: string | undefined): Promise<void> {
    const key = this.h.viewing;
    if (!key?.startsWith("/")) {
      this.h.notify("nothing to ask about yet - send a message first");
      return;
    }
    const meta = this.viewedMeta();
    const asked = model ?? (meta?.model.includes("/") ? meta.model : undefined);
    try {
      this.h.notify("btw: asking...");
      const answer = await askBtw({ piCli: resolveChildConfig(loadSettings().settings).piCli, file: key, question, model: asked, cwd: meta?.cwd });
      this.h.notify("");
      this.h.infoPanel.show(`btw: ${question}\n\n${answer}`, [
        { key: "c", label: "copies", run: () => void this.h.copyText(answer).then((r) => this.h.notify(r === true ? "btw: answer copied" : `btw: copy failed (${r})`)) },
        { key: "s", label: "saves to a file", run: () => this.h.notify(`btw: saved to ${saveBtw(question, answer)}`) },
      ]);
      this.h.tui.requestRender();
    } catch (err) {
      this.fail("btw", err);
    }
  }

  /**
   * /performance: a throwaway analysis of this session's transcript. Like /btw it
   * only reads the session file and spawns pi itself, so it needs no liveMeta() and
   * a sleeping session stays asleep. On completion the report also opens as a new
   * top-level review session (its opening context; it starts asleep).
   */
  private async performance(model: string | undefined): Promise<void> {
    const key = this.h.viewing;
    if (!key?.startsWith("/")) {
      this.h.notify("nothing to analyze yet - send a message first");
      return;
    }
    const meta = this.viewedMeta();
    const asked = model ?? (meta?.model.includes("/") ? meta.model : undefined);
    // Open the review session FIRST: the view switches at command time (never
    // abruptly mid-work later), and the session sits visible while the
    // analysis runs. The report is delivered into it when it completes.
    let target: { name: string; uuid?: string } | undefined;
    try {
      target = await this.h.openReviewSession(this.h.cwdFor(key), performanceReviewName());
      this.h.notify(`performance: review session - ${target.name}; the report lands in it when the analysis completes`);
    } catch (err) {
      this.h.notify(`performance: review session not created: ${errText(err)} - analyzing anyway`);
    }
    try {
      this.h.notify("performance: analyzing the transcript...");
      const r = await this.runPerf({ piCli: resolveChildConfig(loadSettings().settings).piCli, file: key, model: asked, cwd: meta?.cwd });
      this.h.notify("");
      // Auto-save: the report outlives the transient notify (and the analysis).
      const saved = savePerformance(r.answer);
      if (target) {
        try {
          await this.h.request({
            type: "message",
            to: target.uuid ?? target.name,
            text: `The performance report (saved to ${saved}${r.truncated ? ", tail excerpt capped" : ""}):\n\n${r.answer}`,
          });
          this.h.notify(`performance: report delivered to ${target.name} (also saved to ${saved})`);
        } catch (err) {
          this.h.notify(`performance: report not delivered: ${errText(err)} (saved to ${saved})`);
        }
      } else {
        this.h.notify(`performance: report saved to ${saved}`);
      }
    } catch (err) {
      this.fail("performance", err);
    }
  }

  /** Explain the last thinking block with the summary model; nothing is sent to the session. */
  /**
   * /plan [on|off|status] (ticket 229). The daemon announces the change in the transcript (a durable notice). Needs no child: the mode is a
   * marker file the daemon writes, and a child that wakes finds it; but it needs the session's id, so a brand-new session must have started.
   */
  private async plan(text: string): Promise<void> {
    const meta = this.viewedMeta();
    if (meta?.id === undefined) {
      this.h.notify("plan mode needs a session - send a message first");
      return;
    }
    const word = text.trim().toLowerCase();
    if (word === "status") {
      this.h.notify(meta.plan ? "plan mode is ON: the agent can only look until you approve its plan (/plan off ends it)" : "plan mode is off (/plan turns it on)");
      return;
    }
    if (word !== "" && word !== "on" && word !== "off") {
      this.h.notify("/plan takes on, off or status");
      return;
    }
    try {
      await this.h.request({ type: "plan_mode", session: meta.id, on: word === "" ? undefined : word === "on" }, 5000);
    } catch (err) {
      const stale = err instanceof Error && /timed out|unknown command/i.test(err.message);
      this.h.notify(stale ? "plan mode: no answer from the daemon (is it older than this toriel? restart it: toriel kill-server)" : `plan mode failed: ${errText(err)}`);
    }
  }

  /** /tasks (ticket 228): the agent's task list as the daemon last had it. Reads the session list only, so it does not wake a sleeping session. */
  private tasks(): void {
    const meta = this.viewedMeta();
    this.h.infoPanel.show(taskListing(meta?.tasks ?? [], meta?.tasksStaleSince ? Date.now() - meta.tasksStaleSince : 0).join("\n"));
    this.h.tui.requestRender();
  }

  private async why(model: string | undefined): Promise<void> {
    const key = this.h.viewing;
    if (!key?.startsWith("/")) {
      this.h.notify("nothing to explain yet - send a message first");
      return;
    }
    try {
      this.h.notify("reading the last thinking block...");
      this.h.infoPanel.show(await explainLastThinking(key, model));
      this.h.notify("");
      this.h.tui.requestRender();
    } catch (err) {
      this.fail("why", err);
    }
  }

  /** /mcp: our own list (pi shows its status as a one-line notice); the other actions are pi's, so they go to it. */
  private async mcp(action = "list", server?: string, target: string[] = [], auth: McpAuthOptions = { token: false, headers: [] }): Promise<void> {
    if (!(MCP_ACTIONS as readonly string[]).includes(action)) {
      this.h.notify(`/mcp: unknown action "${action}" - use ${MCP_ACTIONS.join(", ")}`);
      return;
    }
    if (action === "add") {
      await this.mcpAdd(server, target, auth);
      return;
    }
    if (action === "token") {
      await this.mcpToken(server, auth);
      return;
    }
    if (action === "remove") {
      await this.mcpRemove(server);
      return;
    }
    if (action === "status") {
      await this.mcpStatus(server);
      return;
    }
    if (action === "explore") {
      await this.mcpExplore(server);
      return;
    }
    if (action !== "list") {
      this.h.editor.setText("");
      await this.h.session.prompt(`/mcp ${action}${server ? ` ${server}` : ""}`);
      return;
    }
    const meta = await this.liveMeta();
    if (!meta) {
      return;
    }
    try {
      this.h.notify("asking the MCP servers...");
      const r = (await this.h.request({ type: "mcp_status", session: meta.id }, 60_000)) as { text: string };
      const skillsDirs = [path.join(piAgentDir(), "skills"), ...readdirSync(piAgentDir(), { withFileTypes: true }).filter((e: Dirent) => e.isDirectory()).map((e: Dirent) => path.join(piAgentDir(), e.name, "skills"))];
      this.h.infoPanel.show(["MCP servers", "", ...mcpListLines(r.text, skillsDirs), "", "/mcp reconnect <server> - tab completes the names"].join("\n"));
      this.h.notify("");
      this.h.tui.requestRender();
    } catch (err) {
      this.fail("mcp", err);
    }
  }

  /** /detach: forget who this session was forked from. */
  private detach(): void {
    const meta = this.viewedMeta();
    const key = this.h.viewing;
    const uuid = meta?.sessionId ?? (key ? this.h.local.get(key)?.id : undefined);
    const parent = uuid ? detachFromParent(uuid) : undefined;
    if (!parent) {
      this.h.notify("this session was not started by an agent - nothing to detach");
      return;
    }
    this.h.forgetLineage();
    this.h.notify(`detached from ${parent.name} - it is a session of its own now`);
  }

  /** /parent: open the session this one came from. */
  private async parent(): Promise<void> {
    const meta = this.viewedMeta();
    const key = this.h.viewing;
    const uuid = meta?.sessionId ?? (key ? this.h.local.get(key)?.id : undefined);
    const rel = relationOf(loadLineage(), uuid);
    if (!rel) {
      this.h.notify("this session was not started by an agent");
      return;
    }
    if (!(await this.h.switching.openSession(rel.parentId))) {
      this.h.notify(`parent ${rel.parentName} is not in the list (deleted?)`);
    }
  }

  /** /init: an ordinary prompt asking the agent to write the project's AGENTS.md. */
  private async init(): Promise<void> {
    this.h.editor.setText("");
    await this.h.session.prompt(INIT_PROMPT);
  }

  /** /continue: an ordinary prompt (it wakes a stopped session like any other) saying the interruption was a mistake. */
  private async continueAfterAbort(extra: string): Promise<void> {
    this.h.editor.setText("");
    await this.h.session.prompt(continuePrompt(extra));
  }

  /** /mcp add: write the server into toriel's mcp.yaml, then reload so the session picks it up. */
  private async mcpAdd(name: string | undefined, target: string[], auth: McpAuthOptions): Promise<void> {
    if (!name) {
      this.h.notify("/mcp add <name> <url | command args...> [--token | --bearer-env VAR | --header NAME=VALUE]");
      return;
    }
    let entry: McpEntry;
    try {
      entry = mcpEntry(target);
      // validated before anything is asked or written
      entry = withHeaders(entry, await this.authHeaders(auth, name, entry, false));
    } catch (err) {
      this.h.notify(`/mcp add: ${errText(err)}`);
      return;
    }
    if (auth.token && entry.headers?.Authorization === undefined) {
      return; // the token prompt was cancelled: nothing is added
    }
    try {
      addMcpServer(mcpConfigFile(), name, entry);
    } catch (err) {
      this.h.notify(`/mcp add: ${errText(err)}`);
      return;
    }
    this.h.editor.setText("");
    this.h.notify(`added "${name}" to ${mcpConfigFile()}${entry.headers ? " with its Authorization header (values hidden)" : ""}`);
    await this.reload();
  }

  /**
   * The headers `--token`, `--bearer-env` and `--header` ask for. `--token` asks for the secret here, so the text never goes through
   * the chat box, the history or the transcript. An empty or cancelled token prompt gives none (the caller stops).
   */
  private async authHeaders(auth: McpAuthOptions, name: string, entry: McpEntry, tokenOnly: boolean): Promise<Record<string, string>> {
    if (auth.token && auth.bearerEnv !== undefined) {
      throw new Error("give --token or --bearer-env, not both");
    }
    const headers: Record<string, string> = {};
    if (!tokenOnly) {
      for (const h of auth.headers) {
        const [key, value] = parseHeaderArg(h);
        headers[key] = value;
      }
    }
    if (auth.bearerEnv !== undefined) {
      Object.assign(headers, bearerEnvHeader(auth.bearerEnv));
    }
    if (auth.token) {
      if (entry.url === undefined) {
        throw new Error("a token is for a server given as a URL");
      }
      const token = await this.h.askSecret(`bearer token for ${name}`);
      if (token === undefined) {
        this.h.notify(`no token entered - ${tokenOnly ? "nothing changed" : "the server was not added"}`);
      } else {
        Object.assign(headers, bearerTokenHeader(token));
      }
    }
    return headers;
  }

  /** /mcp token <server>: put a bearer token (asked for here, or --bearer-env VAR) on a URL server already in mcp.yaml, then reload. */
  private async mcpToken(name: string | undefined, auth: McpAuthOptions): Promise<void> {
    if (!name) {
      this.h.notify("/mcp token <server> [--bearer-env VAR] (tab completes the names)");
      return;
    }
    const known = readMcpYaml(mcpConfigFile()).servers[name];
    if (known === undefined) {
      this.h.notify(`/mcp token: "${name}" is not in ${mcpConfigFile()} (/mcp add ${name} <url> --token adds it)`);
      return;
    }
    try {
      const headers = await this.authHeaders({ ...auth, token: auth.bearerEnv === undefined }, name, known, true);
      if (headers.Authorization === undefined) {
        return;
      }
      setMcpServerHeaders(mcpConfigFile(), name, { Authorization: headers.Authorization });
    } catch (err) {
      this.h.notify(`/mcp token: ${errText(err)}`);
      return;
    }
    this.h.editor.setText("");
    this.h.notify(`"${name}" now sends an Authorization header (value hidden)`);
    await this.reload();
  }

  /** /provider [list|add|remove]: pi's model providers (models.json) without editing the file. */
  private async provider(action = "list", name?: string, baseUrl?: string, opts: ProviderOptions = { noKey: false, noModels: false }): Promise<void> {
    if (action === "list") {
      this.providerList();
    } else if (action === "add") {
      await this.providerAdd(name, baseUrl, opts);
    } else if (action === "remove") {
      this.providerRemove(name);
    } else {
      this.h.notify(`/provider: unknown action "${action}" - use list, add or remove`);
    }
  }

  private providerList(): void {
    try {
      const rows = listProviders(piAgentDir());
      const keyText = (r: ProviderRow): string => (r.key === "env" ? `key from $${r.keyEnv}` : r.key === "command" ? "key from a command" : r.key === "literal" ? "key stored" : "no key");
      const lines = rows.length === 0 ? ["No providers are configured in models.json (pi's built-in providers work with an environment variable or /login)."] : rows.map((r) => `${r.id}: ${r.baseUrl ?? "(built-in URL)"} - ${keyText(r)}, ${r.models} model${r.models === 1 ? "" : "s"}${r.api ? `, ${r.api}` : ""}`);
      this.h.infoPanel.show(["Providers (models.json)", "", ...lines, "", "/provider add <name> <base-url> adds one; /login <name> sets a key; /provider remove <name>"].join("\n"));
      this.h.tui.requestRender();
    } catch (err) {
      this.h.notify(`/provider: ${errText(err)}`);
    }
  }

  /** /provider add: asks for the key (masked), asks the endpoint for its models, writes models.json, reloads. */
  private async providerAdd(name: string | undefined, baseUrl: string | undefined, opts: ProviderOptions): Promise<void> {
    if (!name || !baseUrl) {
      this.h.notify("/provider add <name> <base-url> [--key-env VAR | --no-key] [--no-models] [--api <api>]");
      return;
    }
    const dir = piAgentDir();
    let apiKey: string | undefined;
    try {
      checkProviderId(name);
      if (listProviders(dir).some((p) => p.id === name)) {
        throw new Error(`provider "${name}" is already in models.json (/login ${name} changes its key; /provider remove ${name} first to replace it)`);
      }
      if (opts.keyEnv !== undefined && opts.noKey) {
        throw new Error("give --key-env or --no-key, not both");
      }
      if (opts.keyEnv !== undefined) {
        apiKey = apiKeyValue({ env: opts.keyEnv });
      }
    } catch (err) {
      this.h.notify(`/provider add: ${errText(err)}`);
      return;
    }
    if (opts.keyEnv === undefined && !opts.noKey) {
      const key = await this.h.askSecret(`API key for ${name}`);
      if (key === undefined) {
        this.h.notify("no key entered - the provider was not added (--no-key for an endpoint without one)");
        return;
      }
      try {
        apiKey = apiKeyValue({ literal: key });
      } catch (err) {
        this.h.notify(`/provider add: ${errText(err)}`);
        return;
      }
    }
    let models: NewModel[] = [];
    let modelsNote = "no models asked for";
    if (!opts.noModels) {
      this.h.notify(`asking ${baseUrl} what it serves...`);
      // a litellm or bifrost gateway (by its name) is asked the way /doctor asks it, which also brings the context window, output limit and cost
      const kind = gatewayKind(name);
      const asked = kind === undefined ? await fetchModels(baseUrl, resolveForProbe(apiKey)) : await probeLitellmAsync({ baseUrl, apiKey, kind });
      const got = typeof asked === "string" || Array.isArray(asked) ? asked : Object.entries(asked.routes).map(([id, r]): NewModel => ({ id, ...r }));
      if (typeof got === "string") {
        modelsNote = `no models written: ${got}`;
      } else {
        models = got;
        modelsNote = `${Math.min(got.length, MAX_MODELS)} model${got.length === 1 ? "" : "s"}${got.length > MAX_MODELS ? ` (the first ${MAX_MODELS} of ${got.length})` : ""}`;
      }
    }
    try {
      addProvider(dir, { id: name, baseUrl, api: opts.api ?? DEFAULT_API, apiKey, models });
    } catch (err) {
      this.h.notify(`/provider add: ${errText(err)}`);
      return;
    }
    this.h.editor.setText("");
    this.h.notify(`added provider "${name}" to models.json: ${modelsNote}${gatewayKind(name) !== undefined ? " (/doctor will compare the numbers with the gateway's)" : ""}`);
    await this.reload();
  }

  /** /provider remove: after a confirmation, since the key goes with it (the file's original is kept). */
  private providerRemove(name: string | undefined): void {
    if (!name) {
      this.h.notify("/provider remove <name>");
      return;
    }
    try {
      if (!listProviders(piAgentDir()).some((p) => p.id === name)) {
        this.h.notify(`/provider remove: "${name}" is not in models.json`);
        return;
      }
    } catch (err) {
      this.h.notify(`/provider remove: ${errText(err)}`);
      return;
    }
    this.h.choicePanel.open(`Remove provider "${name}" from models.json? (the original is kept as models.json.bak-<time>)`, ["Remove", "Cancel"], undefined, (choice) => {
      if (choice !== "Remove") {
        return;
      }
      try {
        removeProvider(piAgentDir(), name);
      } catch (err) {
        this.h.notify(`/provider remove: ${errText(err)}`);
        return;
      }
      this.h.notify(`removed provider "${name}"`);
      void this.reload();
    });
  }

  /** /login <provider>: set an API key in models.json (asked for, masked), then reload. */
  private async login(provider: string | undefined, keyEnv: string | undefined): Promise<void> {
    if (!provider) {
      this.providerList();
      return;
    }
    let apiKey: string;
    try {
      checkProviderId(provider);
      if (keyEnv !== undefined) {
        apiKey = apiKeyValue({ env: keyEnv });
      } else {
        const key = await this.h.askSecret(`API key for ${provider}`);
        if (key === undefined) {
          this.h.notify("no key entered - nothing changed");
          return;
        }
        apiKey = apiKeyValue({ literal: key });
      }
      const { created } = setProviderKey(piAgentDir(), provider, apiKey);
      this.h.editor.setText("");
      this.h.notify(`${created ? `"${provider}" was not in models.json: added it with just its key. ` : ""}set the key of "${provider}"${keyEnv !== undefined ? ` to $${keyEnv}` : ""}`);
    } catch (err) {
      this.h.notify(`/login: ${errText(err)}`);
      return;
    }
    await this.reload();
  }

  /** /mcp status [server]: why servers are not working - pi's state and errors, the configuration, cheap local checks, what to try. */
  private async mcpStatus(only: string | undefined): Promise<void> {
    const meta = await this.liveMeta();
    if (!meta) {
      return;
    }
    try {
      this.h.notify("checking the MCP servers...");
      const r = (await this.h.request({ type: "mcp_status", session: meta.id }, 60_000)) as { text: string };
      const parsed = parseStatusDetailed(r.text);
      const configs = readConfigs([mcpConfigFile()]);
      // probe only what needs it: the named server, or every one that is not connected
      const findings = new Map<string, string[]>();
      await Promise.all(
        parsed.servers
          .filter((s) => (only ? s.name === only : !/^connected/i.test(s.detail)))
          .map(async (s) => {
            const cfg = configs.get(s.name);
            if (cfg) {
              findings.set(s.name, await probeEntry(cfg.entry));
            }
          }),
      );
      this.h.infoPanel.show(statusReport(parsed, configs, findings, only));
      this.h.notify("");
      this.h.tui.requestRender();
    } catch (err) {
      this.fail("mcp", err);
    }
  }

  /** /mcp explore <server>: the agent introspects the server and writes a skill for it. Needs a live child (liveMeta); refuses with a notice if the server is not a configured mcp.yaml server or not connected, then an ordinary prompt. */
  private async mcpExplore(server: string | undefined): Promise<void> {
    if (!server) {
      this.h.notify("/mcp explore <server> (tab completes the names)");
      return;
    }
    const meta = await this.liveMeta();
    if (!meta) {
      return;
    }
    const configs = readConfigs([mcpConfigFile()]);
    if (!configs.has(server)) {
      this.h.notify(`"${server}" is not a configured mcp.yaml server - /mcp status shows what is available`);
      return;
    }
    try {
      const r = (await this.h.request({ type: "mcp_status", session: meta.id }, 60_000)) as { text: string };
      if (!mcpServerConnected(r.text, server)) {
        this.h.notify(`"${server}" is not connected - /mcp reconnect ${server} (or /mcp status for the details)`);
        return;
      }
    } catch (err) {
      this.fail("mcp", err);
      return;
    }
    this.h.editor.setText("");
    await this.h.session.prompt(mcpExplorePrompt(server));
  }

  /** /mcp remove: take the server out of toriel's mcp.yaml and reload this session so it disconnects. */
  private async mcpRemove(name: string | undefined): Promise<void> {
    if (!name) {
      this.h.notify("/mcp remove <server> (tab completes the names)");
      return;
    }
    try {
      removeMcpServer(mcpConfigFile(), name);
    } catch (err) {
      this.h.notify(`/mcp remove: ${errText(err)}`);
      return;
    }
    this.h.editor.setText("");
    this.h.notify(`removed "${name}" from ${mcpConfigFile()}`);
    await this.reload();
  }

  private async compact(instructions: string): Promise<void> {
    const meta = await this.liveMeta();
    if (!meta) {
      return;
    }
    if (meta.streaming) {
      this.h.notify("session is working; abort it first");
      return;
    }
    try {
      this.h.notify("compacting...");
      const r = (await this.h.request(
        { type: "compact", session: meta.id, instructions },
        COMPACT_TIMEOUT_MS,
      )) as { tokensBefore?: number; tokensAfter?: number };
      const sizes =
        r?.tokensBefore !== undefined
          ? `: ${fmtTokens(r.tokensBefore)}${r.tokensAfter !== undefined ? ` -> ~${fmtTokens(r.tokensAfter)}` : ""} tokens`
          : "";
      this.h.notify(`compacted${sizes}`);
    } catch (err) {
      this.fail("compact", err);
    }
  }
}
