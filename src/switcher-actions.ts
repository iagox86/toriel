// Switcher-side actions of the controller: opening/closing the list, row
// actions (enter/new/kill/rename/group/move), the command line and its keys.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { KEY_LOG } from "./config.ts";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { type Invocation, listing, parseCommandLine } from "./cli.ts";
import { SWITCHER_COMMANDS, type SwitcherCommandName } from "./commands.ts";
import type { Host } from "./host.ts";
import { loadGroups, pruneStale, resolveGroup, saveGroups, type GroupsFile, withComment, withParked } from "./groups.ts";
import {
  buildSessionList,
  appendUnranked,
  deleteEmptyGroup,
  moveGroup,
  moveSession,
  sortSessions,
  type MutationResult,
} from "./session-list.ts";
import { detachFromParent, loadLineage, parentMap } from "./lineage.ts";
import { arrangeTree } from "./session-tree.ts";
import { INIT_PROMPT } from "./init-prompt.ts";
import { loadAgentsChecked } from "./agents.ts";
import { agentListing } from "./agents-completion.ts";
import { runFeedback } from "./feedback-command.ts";
import { SwitcherFilter } from "./switcher-filter.ts";
import { SwitcherSummaries } from "./switcher-summaries.ts";
import { restoreFromTrash } from "./switcher-trash.ts";
import { isLiveState, type SwitcherSession } from "./switcher.ts";
import { itemsFromFile, newView } from "./transcript.ts";
import { errText } from "./util.ts";

const LOCK_BITS = 64 | 128; // kitty caps_lock / num_lock, reported in the modifier field

/**
 * pi-tui misses the kitty-protocol spelling of F2 (CSI 1;mods Q). Lock keys
 * add to the modifier (num lock on = 129), so ignore them; no other modifier
 * counts as plain F2.
 */
export function isF2(data: string): boolean {
  if (matchesKey(data, "f2") || data === "\x1b[Q") {
    return true;
  }
  const m = /^\x1b\[1;(\d+)(?::([12]))?Q$/.exec(data);
  return m !== null && ((Number(m[1]) - 1) & ~LOCK_BITS) === 0;
}

/** What runs a switcher /command: its parsed call and the highlighted session, if any. */
type CommandHandler = (call: Invocation, target: SwitcherSession | undefined) => Promise<void>;

export class SwitcherActions {
  groups: GroupsFile = { groups: [], assignments: {} };
  isOpen = false;

  /** The temporary list filter (/filter, ctrl-f). */
  readonly filter: SwitcherFilter;

  private lastRefused: string | null = null;
  private armedDelete: string | null = null;
  /** Session key order captured when the switcher opened; frozen while open. */
  private switchOrder: string[] | null = null;

  private readonly h: Host;
  private readonly summaries: SwitcherSummaries;

  constructor(host: Host) {
    this.h = host;
    this.filter = new SwitcherFilter(host, () => this.refresh());
    this.summaries = new SwitcherSummaries(host, { refresh: () => this.refresh(), isOpen: () => this.isOpen, groups: () => this.groups });
  }

  open(): void {
    // Release input on the session we were driving; re-enter re-attaches.
    if (this.h.viewing) {
      const meta = this.h.metaForPath(this.h.viewing);
      if (meta?.attachedToYou) {
        this.h.send({ type: "detach", session: meta.id });
      }
    }
    this.groups = loadGroups();
    this.filter.reset();
    this.switchOrder = null;
    this.armedDelete = null;
    this.lastRefused = null;
    this.h.session.resetArmed();
    // Land on the session we were just in, else the first session.
    this.h.switcher.selectedKey = this.h.viewing;
    this.refresh();
    this.h.switcher.height = this.h.tui.terminal.rows || 24;
    this.h.switcher.hint = "type / for commands, or a message to start a session - enter open - ctrl-n new - ctrl-k stop - ctrl-x delete - ctrl-r rename - ctrl-g group - ctrl-f filter";
    this.h.switcher.heightProvider = () => Math.max(6, (this.h.tui.terminal.rows || 24) - 4);
    this.isOpen = true;
    this.h.tui.setLayoutRoot(this.h.switcherLayout);
    this.h.editor.setText("");
    this.h.syncHistory();
    this.h.renderChrome();
    this.h.tui.requestRender(true);
  }

  close(): void {
    this.isOpen = false;
    this.filter.reset();
    this.h.tui.setLayoutRoot(this.h.chatLayout);
    this.h.rebuildChat();
    this.h.renderChrome();
    this.h.tui.requestRender(true);
  }

  refresh(): void {
    this.groups = loadGroups();
    let list = buildSessionList({
      daemon: this.h.sessions.values(),
      local: this.h.local,
      groups: this.groups,
      summaries: this.h.summaries,
      now: Date.now(),
    });
    // Freeze the display order while the switcher is open.
    if (this.switchOrder === null) {
      this.switchOrder = list.map((s) => s.key);
    }
    sortSessions(list, this.groups.order ?? [], this.switchOrder);
    list = arrangeTree(list, parentMap(loadLineage()));
    const order = appendUnranked(this.groups.order, list);
    if (order) {
      this.groups.order = order;
    }
    // an empty file list means the listing has not loaded, not that every session is gone
    const pruned = this.h.local.size > 0 && pruneStale(this.groups, new Set(list.flatMap((s) => (s.sessionId ? [s.sessionId] : []))));
    if (order || pruned) {
      saveGroups(this.groups);
    }
    if (KEY_LOG) {
      try {
        fs.appendFileSync(KEY_LOG, `REFRESH_SWITCHER paths=${list.length} local=${this.h.local.size} daemon=${this.h.sessions.size}: ${list.map((x) => x.key.split("/").pop()).join(",")}\n`);
      } catch {
        // debug only
      }
    }
    const filter = this.filter.current;
    const shown = filter ? list.filter((x) => filter.test(x)) : list;
    this.h.switcher.filterNote = filter
      ? `filter${filter.regex ? " (regex)" : ""}: ${filter.text}  -  ${shown.length} of ${list.length}  -  /filter clears`
      : "";
    this.h.switcher.groupMatches = filter ? (title) => filter.testGroup(title) : undefined;
    this.h.switcher.sessions = shown;
    this.h.switcher.groups = this.groups.groups;
    this.h.switcher.collapsed = new Set(this.groups.collapsed);
    this.h.switcher.height = this.h.tui.terminal.rows || 24;
    this.h.switcher.refresh();
    this.h.tui.requestRender();
  }

  /** Open the session with this UUID from outside the switcher (/parent). False when it is not in the list. */
  async openSession(uuid: string): Promise<boolean> {
    this.refresh();
    const row = this.h.switcher.sessions.find((s) => s.sessionId === uuid);
    if (!row) {
      return false;
    }
    await this.enter(row);
    return true;
  }

  async enter(s: SwitcherSession): Promise<void> {
    if (s.daemonId !== undefined && isLiveState(s.state)) {
      try {
        await this.h.request({ type: "attach", session: s.daemonId, force: this.lastRefused === s.key });
        this.lastRefused = null;
      } catch (err) {
        this.lastRefused = s.key;
        this.h.switcher.hint = `${errText(err)} - enter again to take over`;
        this.h.tui.requestRender();
        return;
      }
    }
    this.h.viewing = s.key;
    if (!this.h.views.has(s.key)) {
      this.h.views.set(s.key, { ...newView(), items: itemsFromFile(s.key, this.h.tui, s.cwd ?? process.cwd()) });
    }
    this.close();
    this.h.rebuildChat();
  }

  /** Spawn a session; `firstMessage` is prompted once it is entered. */
  async newSession(firstMessage?: string, name?: string, cwd = process.cwd(), agent?: string): Promise<void> {
    try {
      const data = (await this.h.request({ type: "spawn", cwd, name: name ? this.h.uniqueSessionName(name) : name, agent })) as { sessionId?: number };
      if (typeof data?.sessionId === "number") {
        const meta = this.h.sessions.get(data.sessionId);
        if (meta) {
          this.h.viewing = this.h.keyFor(meta);
          this.close();
          if (firstMessage) {
            void this.h.session.prompt(firstMessage);
          }
        } else {
          this.h.pendingEnterId = data.sessionId;
          this.h.pendingPrompt = firstMessage ?? null;
          this.h.switcher.hint = "starting session...";
        }
      }
    } catch (err) {
      if (firstMessage) {
        this.h.editor.setText(firstMessage);
      }
      this.h.switcher.hint = `spawn failed: ${errText(err)}`;
      this.h.tui.requestRender();
    }
  }

  /** Stop a live session's child; the file stays and it respawns on the next prompt. */
  async stop(s: SwitcherSession): Promise<void> {
    try {
      if (!isLiveState(s.state)) {
        this.h.switcher.hint = `${s.name} is not running`;
      } else if (s.daemonId === undefined) {
        throw new Error("no daemon session");
      } else {
        await this.h.request({ type: "deactivate", session: s.daemonId });
        this.h.switcher.hint = `stopped ${s.name} (file kept; respawns on next prompt)`;
        this.refresh();
      }
    } catch (err) {
      this.h.switcher.hint = `stop failed: ${errText(err)}`;
    }
    this.h.tui.requestRender();
  }

  /** Move to trash, with a press-twice confirm; a live child is stopped first (by the daemon). */
  async remove(s: SwitcherSession, confirmed = false): Promise<void> {
    try {
      if (!confirmed && this.armedDelete !== s.key) {
        this.armedDelete = s.key;
        const live = isLiveState(s.state);
        const kids = s.descendants ?? 0;
        const orphans = kids > 0 ? ` (its ${kids} ${kids === 1 ? "child stays" : "children stay"}, listed on their own)` : "";
        this.h.switcher.hint = `${s.name}: press ctrl-x again to ${live ? "stop it and " : ""}move to trash${orphans}`;
        this.h.tui.requestRender();
        return;
      }
      this.armedDelete = null;
      // keep the cursor where it is: select the next entry (or the
      // previous one at the end) before the row disappears
      this.h.switcher.selectNextAfter(s.key);
      await this.h.request({ type: "delete", path: s.key.startsWith("daemon:") ? undefined : s.key, session: s.daemonId });
      this.h.views.delete(s.key);
      await this.h.loadLocal();
      this.h.switcher.hint = `${s.name} moved to trash (/restore brings it back)`;
      this.refresh();
    } catch (err) {
      this.h.switcher.hint = `delete failed: ${errText(err)}`;
    }
    this.h.tui.requestRender();
  }

  /** Start the unattended summary pass (while toriel is open). */
  startAutoSummary(): void {
    this.summaries.startAuto();
  }

  /** Persist a group/order mutation and refresh; shows the mutation's hint. */
  private applyGroupChange(result: MutationResult): void {
    if (result.hint) {
      this.h.switcher.hint = result.hint;
    }
    if (result.changed) {
      saveGroups(this.groups);
      this.refresh();
    }
    this.h.tui.requestRender();
  }

  /** shift+up/down on a session row: relocate within/between sections. */
  async moveSession(delta: number, s: SwitcherSession): Promise<void> {
    if (!s.sessionId) {
      this.h.switcher.hint = "session has no id yet - prompt it once, then move it";
      this.h.tui.requestRender();
      return;
    }
    const result = moveSession(this.groups, this.h.switcher.sessions, s, delta);
    // a session dragged into a folded group would vanish into it: unfold the group so it stays selected in view
    const into = this.groups.assignments[s.sessionId] ?? "(ungrouped)";
    if (result.changed && this.groups.collapsed?.includes(into)) {
      this.groups.collapsed = this.groups.collapsed.filter((g) => g !== into);
    }
    this.applyGroupChange(result);
  }

  /** shift+up/down on a group header: swap with the neighboring group. */
  async moveGroup(delta: number, title: string): Promise<void> {
    this.applyGroupChange(moveGroup(this.groups, title, delta));
  }

  /** ctrl-x on a group header: delete it (only when it has no sessions). */
  async deleteGroupIfEmpty(title: string): Promise<void> {
    const armKey = `group:${title}`;
    const deletable = title !== "(ungrouped)" && !this.h.switcher.sessions.some((s) => s.group === title);
    // a group that cannot be deleted just gets the explanation; an empty one needs a second ctrl-x
    if (deletable && this.armedDelete !== armKey) {
      this.armedDelete = armKey;
      this.h.switcher.hint = `${title}: press ctrl-x again to delete this group`;
      this.h.tui.requestRender();
      return;
    }
    this.armedDelete = null;
    this.applyGroupChange(deleteEmptyGroup(this.groups, this.h.switcher.sessions, title));
  }

  async runCommand(cmd: string, target: SwitcherSession | undefined): Promise<void> {
    const parsed = parseCommandLine(SWITCHER_COMMANDS, cmd);
    switch (parsed.kind) {
      case "unknown":
        this.h.switcher.hint = `unknown command: /${parsed.name} (/help)`;
        break;
      case "help":
        this.h.infoPanel.show(parsed.text);
        this.h.editor.setText("");
        break;
      case "error":
        this.h.switcher.hint = `/${parsed.spec.name}: ${parsed.message} (/${parsed.spec.name} --help)`;
        break;
      case "run":
        await this.commandHandlers()[parsed.spec.name as SwitcherCommandName](parsed.call, target);
        break;
      default:
        parsed satisfies never;
    }
    this.h.tui.requestRender();
  }

  /** The -C directory of /new and /init, `~` expanded: `{}` (the directory toriel started in) when not given, undefined (after saying why) when it is not a directory. */
  private startDir(verb: string, call: Invocation): { cwd?: string } | undefined {
    const dir = call.opts.cwd as string | undefined;
    if (dir === undefined) {
      return {};
    }
    const cwd = path.resolve(dir.replace(/^~(?=$|\/)/, os.homedir()));
    if (!(fs.existsSync(cwd) && fs.statSync(cwd).isDirectory())) {
      this.h.switcher.alert(`${verb}: ${cwd} is not a directory`);
      return undefined;
    }
    return { cwd };
  }

  /** The error for a session command run with no session highlighted: a group heading, or nothing. */
  private noTarget(verb: string): void {
    this.h.switcher.alert(this.h.switcher.currentIsHeader() ? `${verb}: select a session, not a heading` : `${verb}: highlight a session first`);
  }

  /** A handler for a command that works on the highlighted session. */
  private needsTarget(verb: string, run: (t: SwitcherSession, arg: string, call: Invocation) => Promise<void>): CommandHandler {
    return async (call, target) => {
      if (!target) {
        this.noTarget(verb);
        return;
      }
      await run(target, call.args.join(" "), call);
    };
  }

  /** One handler per SWITCHER_COMMANDS entry (the Record type makes a missing one a compile error). */
  private commandHandlers(): Record<SwitcherCommandName, CommandHandler> {
    return { ...this.sessionCommands(), ...this.groupCommands(), ...this.miscCommands() };
  }

  /** Commands on a session itself: starting, stopping, deleting, renaming, adopting. */
  private sessionCommands(): Pick<Record<SwitcherCommandName, CommandHandler>, "new" | "init" | "stop" | "delete" | "rename" | "adopt" | "detach" | "restore"> {
    const needsTarget = this.needsTarget.bind(this);
    return {
      new: async (call) => {
        const dir = this.startDir("new", call);
        if (dir) {
          await this.newSession(undefined, call.opts.name as string | undefined, dir.cwd, call.opts.agent as string | undefined);
        }
      },
      // a fresh session whose first message is the init prompt: /init is usually the first thing done in a project
      init: async (call) => {
        const dir = this.startDir("init", call);
        if (dir) {
          await this.newSession(INIT_PROMPT, (call.opts.name as string | undefined) ?? `init ${path.basename(dir.cwd ?? process.cwd())}`, dir.cwd);
        }
      },
      stop: needsTarget("stop", (t) => this.stop(t)),
      delete: async (call, target) => {
        if (!target) {
          this.noTarget("delete");
          return;
        }
        await this.remove(target, call.opts.yes === true);
      },
      rename: needsTarget("rename", async (t, arg) => {
        if (!arg) {
          this.h.editor.setText("/rename ");
          this.h.switcher.hint = `rename: ${t.name} - type the new name and press enter`;
          return;
        }
        try {
          const unique = this.h.uniqueSessionName(arg, t.key);
          await this.h.request({
            type: "rename",
            session: t.daemonId,
            path: t.daemonId === undefined ? t.key : undefined,
            name: unique,
          });
          await this.h.loadLocal();
          this.refresh();
          this.h.switcher.hint = unique === arg ? `renamed to ${arg}` : `renamed to ${unique} (${arg} is taken)`;
        } catch (err) {
          this.h.switcher.hint = `rename failed: ${errText(err)}`;
        }
      }),
      adopt: async (_call, target) => {
        const t = target ?? this.h.switcher.current();
        if (!t) {
          this.noTarget("adopt");
        } else if (!t.key.startsWith("/")) {
          this.h.switcher.hint = "adopt: not a file-backed session";
        } else {
          try {
            const data = (await this.h.request({ type: "adopt", path: t.key, cwd: t.cwd ?? process.cwd() })) as {
              sessionId?: number;
            };
            if (typeof data?.sessionId === "number") {
              const meta = this.h.sessions.get(data.sessionId);
              if (meta) {
                this.h.viewing = this.h.keyFor(meta);
                this.close();
              } else {
                this.h.pendingEnterId = data.sessionId;
                this.h.switcher.hint = "adopting...";
              }
            }
          } catch (err) {
            this.h.switcher.hint = `adopt failed: ${errText(err)}`;
          }
        }
      },
      detach: needsTarget("detach", async (t) => {
        const parent = t.sessionId ? detachFromParent(t.sessionId) : undefined;
        if (!parent) {
          this.h.switcher.hint = `${t.name} was not started by an agent - nothing to detach`;
        } else {
          this.h.forgetLineage();
          this.refresh();
          this.h.switcher.hint = `${t.name} detached from ${parent.name} - it is top-level now`;
        }
      }),
      restore: async (call) => restoreFromTrash(this.h, call.args.join(" "), () => this.refresh()),
    };
  }

  /** Commands that file sessions and shape the list: groups, parking, notes, the filter, summaries. */
  private groupCommands(): Pick<Record<SwitcherCommandName, CommandHandler>, "group" | "ungroup" | "park" | "comment" | "filter" | "summarize"> {
    const needsTarget = this.needsTarget.bind(this);
    return {
      group: needsTarget("group", async (t, arg) => {
        if (!arg) {
          this.h.editor.setText("/group ");
          this.h.switcher.hint = `group: ${t.name} - type a group name and press enter`;
        } else if (!t.sessionId) {
          this.h.switcher.hint = "group: session has no id yet";
        } else {
          try {
            const group = resolveGroup(this.groups, arg);
            this.groups.assignments[t.sessionId] = group;
            saveGroups(this.groups);
            this.refresh();
            this.h.switcher.hint = `${t.name} -> ${group}`;
          } catch (err) {
            this.h.switcher.hint = `group failed: ${errText(err)}`;
          }
        }
      }),
      ungroup: needsTarget("ungroup", async (t) => {
        if (!t.sessionId) {
          this.h.switcher.hint = "ungroup: session has no id yet";
        } else if (!t.group) {
          this.h.switcher.hint = `${t.name} is not in a group`;
        } else {
          this.groups.assignments[t.sessionId] = null;
          saveGroups(this.groups);
          this.refresh();
          this.h.switcher.hint = `${t.name} removed from ${t.group}`;
        }
      }),
      park: needsTarget("park", async (t, _arg, call) => {
        if (!t.sessionId) {
          this.h.switcher.hint = "park: session has no id yet";
          return;
        }
        const undo = call.opts.undo === true;
        this.groups.parked = withParked(this.groups, t.sessionId, !undo);
        saveGroups(this.groups);
        this.refresh();
        this.h.switcher.hint = undo ? `${t.name} unparked` : `${t.name} parked (using it again unparks it)`;
      }),
      comment: needsTarget("comment", async (t, arg, call) => {
        if (!t.sessionId) {
          this.h.switcher.hint = "comment: session has no id yet";
          return;
        }
        if (!arg && call.opts.clear !== true) {
          this.h.editor.setText(`/comment ${t.comment ?? ""}`);
          this.h.switcher.hint = `comment: ${t.name} - edit the note and press enter`;
          return;
        }
        this.groups.comments = withComment(this.groups, t.sessionId, call.opts.clear === true ? "" : arg);
        saveGroups(this.groups);
        this.refresh();
        this.h.switcher.hint = call.opts.clear === true ? `${t.name}: comment removed` : `${t.name}: comment saved (searchable with /filter)`;
      }),
      filter: async (call) => {
        const text = call.args.join(" ");
        if (!text.trim()) {
          this.filter.clear();
          this.h.switcher.hint = "filter cleared";
          return;
        }
        const error = this.filter.set(text, call.opts.regex === true);
        this.h.switcher.hint = error ? `filter: ${error}` : "";
      },
      summarize: async (call, target) => this.summaries.run(call, target),
    };
  }

  /** The rest: help, listings, feedback, leaving, stopping the daemon. */
  private miscCommands(): Pick<Record<SwitcherCommandName, CommandHandler>, "agents" | "feedback" | "mouse" | "help" | "exit" | "quit" | "kill-daemon"> {
    const leave = async () => {
      this.h.dispose();
    };
    return {
      agents: async () => {
        const { agents, problems } = loadAgentsChecked(process.cwd());
        this.h.infoPanel.show(agentListing(agents, problems));
      },
      feedback: async (call, target) => runFeedback(this.h, call, target?.key),
      mouse: async (call) => this.h.setMouse(call.args[0] ?? ""),
      help: async () => {
        this.h.infoPanel.show(listing(SWITCHER_COMMANDS));
      },
      exit: leave,
      quit: leave,
      "kill-daemon": async () => {
        this.h.send({ type: "shutdown" });
        this.h.switcher.hint = "daemon shutting down (children stop too)";
      },
    };
  }

  keys(data: string): boolean {
    if (this.filter.live && this.filter.liveKeys(data)) {
      return true;
    }
    if (matchesKey(data, Key.ctrl("f"))) {
      this.filter.startLive();
      return true;
    }
    const editorEmpty = this.h.editor.getText().trim().length === 0;
    if (matchesKey(data, Key.up) && editorEmpty) {
      this.h.switcher.move(-1);
      this.h.tui.requestRender();
      return true;
    }
    if (matchesKey(data, Key.down) && editorEmpty) {
      this.h.switcher.move(1);
      this.h.tui.requestRender();
      return true;
    }
    if (matchesKey(data, "shift+up")) {
      this.h.switcher.shiftMove(-1);
      return true;
    }
    if (matchesKey(data, "shift+down")) {
      this.h.switcher.shiftMove(1);
      return true;
    }
    if (matchesKey(data, Key.escape)) {
      // In the switcher, esc cancels the action in progress (a typed
      // command, else an active filter) - it never navigates. left is the "go back" key.
      if (this.h.editor.getText().trim().length > 0) {
        this.h.editor.setText("");
        this.h.switcher.hint = "";
      } else if (this.filter.current) {
        this.filter.clear();
        this.h.switcher.hint = "filter cleared";
        this.h.tui.requestRender();
      }
      return true;
    }
    // on a session, left is a no-op (furthest back level); on a group header it folds the group
    if (matchesKey(data, Key.left) && editorEmpty) {
      const here = this.h.switcher.current();
      if (this.h.switcher.currentIsHeader()) {
        this.setCollapsed(this.h.switcher.currentHeaderTitle(), true);
      } else if (here && (here.descendants ?? 0) > 0 && !this.isFolded(here)) {
        this.setSessionFolded(here, true);
      } else if (here?.parentId) {
        // like a file tree: left on a child goes up to its parent
        this.h.switcher.selectSessionId(here.parentId);
        this.h.tui.requestRender();
      }
      return true;
    }
    if (matchesKey(data, Key.right) && editorEmpty) {
      const target = this.h.switcher.current();
      if (target && (target.descendants ?? 0) > 0 && this.isFolded(target)) {
        this.setSessionFolded(target, false);
      } else if (target) {
        void this.enter(target);
      } else if (this.h.switcher.currentIsHeader()) {
        this.setCollapsed(this.h.switcher.currentHeaderTitle(), false);
      } else {
        this.h.switcher.hint = "nothing to open";
        this.h.tui.requestRender();
      }
      return true;
    }
    if (matchesKey(data, Key.ctrl("n"))) {
      void this.newSession();
      return true;
    }
    if (matchesKey(data, Key.ctrl("x"))) {
      if (this.h.switcher.currentIsHeader()) {
        void this.deleteGroupIfEmpty(this.h.switcher.currentHeaderTitle());
        return true;
      }
      const target = this.h.switcher.current();
      if (target) {
        void this.remove(target);
      }
      return true;
    }
    if (matchesKey(data, Key.ctrl("k"))) {
      const target = this.sessionRow("stop");
      if (target) {
        void this.stop(target);
      }
      return true;
    }
    if (isF2(data) || matchesKey(data, Key.ctrl("r"))) {
      const target = this.sessionRow("rename");
      if (target) {
        this.h.editor.setText(`/rename ${target.name}`);
        this.h.switcher.hint = "rename: edit the name and press enter";
      }
      return true;
    }
    if (matchesKey(data, Key.ctrl("g"))) {
      const target = this.sessionRow("group");
      if (target) {
        this.h.editor.setText(`/group ${target.group ?? ""}`);
        this.h.switcher.hint = `group: ${target.name} - edit or type a group name and press enter`;
      }
      return true;
    }
    return false;
  }

  private isFolded(s: SwitcherSession): boolean {
    return !this.filter.current && s.sessionId !== undefined && (this.groups.collapsed ?? []).includes(s.sessionId);
  }

  /** Fold or unfold the children of a session; remembered across runs (same list as folded groups). */
  private setSessionFolded(s: SwitcherSession, fold: boolean): void {
    if (this.filter.current) {
      this.h.switcher.hint = "children can't be folded while a filter is on";
      this.h.tui.requestRender();
      return;
    }
    if (!s.sessionId) {
      return;
    }
    const set = new Set(this.groups.collapsed);
    if (fold) {
      set.add(s.sessionId);
    } else {
      set.delete(s.sessionId);
    }
    this.groups.collapsed = [...set];
    saveGroups(this.groups);
    this.refresh();
  }

  /** Fold or unfold a group in the switcher; remembered across runs. */
  private setCollapsed(title: string, collapse: boolean): void {
    if (this.filter.current) {
      this.h.switcher.hint = "groups can't be folded while a filter is on";
      this.h.tui.requestRender();
      return;
    }
    if (collapse && this.h.switcher.currentHeaderEmpty()) {
      this.h.switcher.hint = `${title} is empty - nothing to fold (you can drag a session into it)`;
      this.h.tui.requestRender();
      return;
    }
    const set = new Set(this.groups.collapsed);
    if (collapse) {
      set.add(title);
    } else {
      set.delete(title);
    }
    this.groups.collapsed = [...set];
    saveGroups(this.groups);
    this.refresh();
    this.h.tui.requestRender();
  }

  /** The highlighted session row; on a group header (or nothing) it sets a hint saying `verb` needs a session. */
  private sessionRow(verb: string): SwitcherSession | undefined {
    const target = this.h.switcher.current();
    if (this.h.switcher.currentIsHeader() || !target) {
      this.h.switcher.hint = `${verb} works on sessions, not group headers`;
      return undefined;
    }
    return target;
  }


  /** Enter in the chat box while the switcher is open. */
  submit(trimmed: string): void {
    // The chat box doubles as the switcher's command line.
    this.h.editor.setText("");
    if (trimmed.startsWith("/")) {
      void this.runCommand(trimmed, this.h.switcher.current());
      return;
    }
    // plain text = the first message of a new session
    if (trimmed.length > 0) {
      void this.newSession(trimmed);
      return;
    }
    // enter opens the highlighted session; on a group header it folds or unfolds the group
    const target = this.h.switcher.current();
    if (target) {
      void this.enter(target);
      return;
    }
    const folded = this.h.switcher.currentHeaderFolded();
    if (folded !== undefined) {
      this.setCollapsed(this.h.switcher.currentHeaderTitle(), !folded);
    }
  }
}
