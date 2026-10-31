// One-line session summaries in the switcher: the unattended pass that runs
// while toriel is open, and the /summarize command.
import type { Invocation } from "./cli.ts";
import type { GroupsFile } from "./groups.ts";
import { loadGroups, saveGroups } from "./groups.ts";
import type { Host } from "./host.ts";
import { log } from "./log.ts";
import { loadSettings } from "./settings.ts";
import { autoSummaryFailure, DEFAULT_INTERVAL_MINUTES, needsResummary, type SummaryEntry, summarizeFile, summaryModel, transcriptOf } from "./summarize.ts";
import type { SwitcherSession } from "./switcher.ts";
import { errText } from "./util.ts";

/** Most sessions one automatic pass will summarize (a local model is slow). */
const MAX_AUTO_PER_RUN = 10;

/** What the summaries need from the switcher that owns them. */
export interface SummaryDeps {
  refresh(): void;
  isOpen(): boolean;
  groups(): GroupsFile;
}

export class SwitcherSummaries {
  private summarizing = false;
  /** The reason the last unattended summary pass failed, so it is announced once. */
  private autoError: string | null = null;
  private autoLast = 0;

  private readonly h: Host;
  private readonly deps: SummaryDeps;

  constructor(host: Host, deps: SummaryDeps) {
    this.h = host;
    this.deps = deps;
  }

  /** Read-modify-write on a fresh copy, so a group edit made meanwhile is not lost. */
  private save(sessionId: string, entry: SummaryEntry): void {
    const groups = loadGroups();
    groups.summaries = { ...groups.summaries, [sessionId]: entry };
    saveGroups(groups);
  }

  /**
   * While toriel is open, every `summaryIntervalMinutes` (settings; default 60, 0 = off)
   * summarize sessions that have no summary yet or have changed since theirs.
   */
  startAuto(): void {
    const timer = setInterval(() => void this.autoTick(), 60_000);
    timer.unref?.();
  }

  private async autoTick(): Promise<void> {
    const cfg = loadSettings().settings;
    const minutes = cfg.summaryIntervalMinutes ?? DEFAULT_INTERVAL_MINUTES;
    if (!minutes || this.summarizing || Date.now() - this.autoLast < minutes * 60_000) {
      return;
    }
    this.autoLast = Date.now();
    const saved = loadGroups().summaries ?? {};
    const live = new Map([...this.h.sessions.values()].map((m) => [m.sessionFile, m]));
    const todo = [...this.h.local.values()].filter((info) => {
      try {
        return needsResummary({
          entry: saved[info.id],
          messages: transcriptOf(info.path, 1).messages,
          modifiedMs: info.modified,
          now: Date.now(),
          streaming: live.get(info.path)?.streaming ?? false,
          minNew: cfg.summaryMinNewMessages,
        });
      } catch {
        return false;
      }
    });
    if (todo.length === 0) {
      return;
    }
    // most recently touched first, so live sessions are covered before a backlog of old ones
    todo.sort((a, b) => b.modified - a.modified);
    this.summarizing = true;
    try {
      const model = summaryModel();
      for (const info of todo.slice(0, MAX_AUTO_PER_RUN)) {
        this.save(info.id, await summarizeFile(info.path, model));
      }
      this.autoError = null;
    } catch (err) {
      // unattended: log every failure, but tell the user only when the reason changes
      log(`auto-summary failed: ${errText(err)}`);
      const { notify, seen } = autoSummaryFailure(this.autoError, err);
      this.autoError = seen;
      if (notify) {
        this.h.notify(notify);
      }
    } finally {
      this.summarizing = false;
    }
    if (this.deps.isOpen()) {
      this.deps.refresh();
      this.h.tui.requestRender();
    }
  }

  /** /summarize: one session (the highlighted one) or `--all`. */
  async run(call: Invocation, target: SwitcherSession | undefined): Promise<void> {
    const model = (call.opts.model as string | undefined) ?? summaryModel();
    const chars = call.opts.chars as number | undefined;
    if (chars !== undefined && !(chars >= 200)) {
      this.h.switcher.hint = "summarize: --chars must be a number, at least 200";
      return;
    }
    if (this.summarizing) {
      this.h.switcher.hint = "summarize: already running - wait for it to finish";
      return;
    }
    this.summarizing = true;
    try {
      if (call.opts.all === true) {
        await this.summarizeAll(model, chars);
      } else if (!target) {
        this.h.switcher.hint = "summarize: highlight a session first";
      } else {
        this.h.switcher.hint = `summarizing ${target.name} with ${model} (a slow model can take minutes)...`;
        this.h.tui.requestRender();
        if (await this.summarizeOne(target, model, chars)) {
          this.h.switcher.hint = `summarized ${target.name}`;
        }
      }
    } finally {
      this.summarizing = false;
    }
  }

  /** Summarize one session and save it; returns false (with a hint) on failure. */
  private async summarizeOne(t: SwitcherSession, model: string, chars?: number): Promise<boolean> {
    if (!t.key.startsWith("/") || !t.sessionId) {
      this.h.switcher.hint = `summarize: ${t.name} has no session file yet`;
      return false;
    }
    try {
      this.save(t.sessionId, await summarizeFile(t.key, model, chars));
      this.deps.refresh();
      return true;
    } catch (err) {
      this.h.switcher.hint = `summarize ${t.name} failed: ${errText(err)}`;
      return false;
    }
  }

  /** Sessions with no summary, or one for a different message count, one at a time (local models are slow). */
  private async summarizeAll(model: string, chars?: number): Promise<void> {
    const todo = this.h.switcher.sessions.filter((s) => {
      if (!s.key.startsWith("/") || !s.sessionId) {
        return false;
      }
      try {
        return this.deps.groups().summaries?.[s.sessionId]?.messages !== transcriptOf(s.key).messages;
      } catch {
        return false;
      }
    });
    if (todo.length === 0) {
      this.h.switcher.hint = "summarize: every session already has a current summary";
      return;
    }
    for (const [i, t] of todo.entries()) {
      this.h.switcher.hint = `summarizing ${i + 1}/${todo.length}: ${t.name} (${model})...`;
      this.h.tui.requestRender();
      if (!(await this.summarizeOne(t, model, chars))) {
        return; // the hint says why; the same model would likely fail again
      }
    }
    this.h.switcher.hint = `summarized ${todo.length} session${todo.length === 1 ? "" : "s"} with ${model}`;
  }
}
