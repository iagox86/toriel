// toriel controller: a TUI over the daemon socket. Dumb by design - it
// renders, switches, and prompts; the daemon owns everything else.
//
// Session view: left-arrow on an empty editor opens the switcher; /abort and
// /exit are intercepted here (never forwarded to the child); everything else
// goes to the child. No ctrl chords in the session view.
// Switcher: up/down select, enter/right open, esc closes, ctrl-n/x/r/g
// manage, command box takes /new /kill /rename /group /exit /help.
//
// Run: node controller.ts
import * as fs from "node:fs";
import {
  Container,
  isKeyRelease,
  Key,
  matchesKey,
  ScrollView,
  Text,
  truncateToWidth,
  TuiAltScreen,
  type EditorTheme,
  type VStack,
} from "@earendil-works/pi-tui";
import { loadLineage, type Lineage } from "./lineage.ts";
import { bannerText, childCost, relationOf } from "./session-tree.ts";
import { uniqueName } from "./session-id.ts";
import { loadAgents } from "./agents.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { buildInfo } from "./build-id.ts";
import { explainMcpFailure } from "./mcp.ts";
import { performanceReviewSeed } from "./session-commands.ts";
import { DIALOG_METHODS, HISTORY_FILE, KEY_LOG, PROFILE } from "./config.ts";
import { DaemonLink } from "./daemon-link.ts";
import { buildLayouts } from "./layout.ts";

import { dialogOwner } from "./dialog-route.ts";
import { DEFAULT_GRANT_DURATIONS, type DialogRequest, DialogPanel, isTextDialog, withOrigin, withOwnLayout } from "./dialogs.ts";
import { configureEditorKeys, InputEditor, } from "./editor.ts";
import { type ImageBlock, lastLine } from "./format.ts";
import { RewindPicker } from "./rewind-picker.ts";
import { CommandAutocomplete } from "./autocomplete.ts";
import { HistorySearch } from "./history-search.ts";
import { loadSettings, settingsMtime } from "./settings.ts";
import { loadCommands, mergeHistory, recordCommand, trimCommands } from "./history.ts";
import { rewindTargets } from "./rewind.ts";
import { guardClicks } from "./click-guard.ts";
import { autocompleteMaxVisible, hideThinkingBlock, wheelScrollLines } from "./pi-settings.ts";
import { SessionActions } from "./session-actions.ts";
import { SwitcherActions } from "./switcher-actions.ts";
import { killServer } from "./lifecycle.ts";
import { compareDaemon, describeDaemon, type DaemonVerdict, type Hello } from "./version-check.ts";
import { selectListTheme } from "./pi-theme.ts";
import {
  displayName,
  sessionKey,
  type LocalSession,
} from "./session-list.ts";
import type { ClientCommand, DaemonMessage, DistributiveOmit, SessionMeta } from "./shared.ts";
import { drifted } from "./drift.ts";
import { MOUSE_OFF, MOUSE_ON, mouseNotice, nextMouse, parseMouseArg } from "./mouse.ts";
import { openUrl } from "./open-url.ts";
import { collectFindings } from "./doctor.ts";
import { summarizeFindings } from "./resources.ts";
import { clearTransient, viewFromHistory } from "./resync.ts";
import { buildStatusLine, fleetStats, bridgeNotice, settingsNotice } from "./status.ts";
import { ActivityLine } from "./activity.ts";
import { Dimmed } from "./components.ts";
import { ChoicePanel } from "./choice-panel.ts";
import { Attachments } from "./attachments.ts";
import { ClipboardActions } from "./clipboard-actions.ts";
import { CompletionSources } from "./completion-sources.ts";
import { ClipboardTerminal } from "./clipboard-terminal.ts";
import { InfoPanel } from "./info-panel.ts";
import type { ToolRun } from "./tool-run.ts";
import { accent, assertTruecolor, attention, dim, OSC_RESET_BG, OSC_SET_BG, streaming } from "./theme.ts";
import { Switcher, } from "./switcher.ts";
import {
  applyEvent,
  dropEcho,
  echoUser,
  type Item,
  itemsFromFile,
  itemsFromMessages,
  newView,
  noteRow,
  type SessionView,
  showRawError,
} from "./transcript.ts";
import { errText, fireAndReport } from "./util.ts";

configureEditorKeys();
const editorTheme: EditorTheme = {
  borderColor: dim,
  selectList: selectListTheme,
};

/** Only the newest tool run advertises ctrl-o; the hint on every line is noise. */
function markLatestRun(view: SessionView): void {
  const runs = view.items.filter((i) => i.kind === "tools");
  runs.forEach((run, i) => {
    (run.component as ToolRun).showHint = i === runs.length - 1;
  });
}

const SWITCHER_HISTORY = "<switcher>";
// How long a reason typed on the select waits for the chained input dialog.
const REASON_FRESH_MS = 10_000;

class Controller {
  tui: TuiAltScreen;
  chatRoot = new Container();
  chatLayout: VStack;
  switcherLayout: VStack;
  scroll: ScrollView;
  statusLine = new Text("", 0, 0);
  /** "FORK of X" above the chat box while viewing a child session; empty otherwise. */
  banner = new Text("", 0, 0);
  scheduleStrip = new Text("", 0, 0);
  /** Viewing an agent-started session: its chat box gets the accent border. */
  private childBorder = false;
  private lineageCache: { at: number; data: Lineage } = { at: 0, data: {} };
  activityLine = new ActivityLine();
  dialogPanel = new DialogPanel();
  infoPanel = new InfoPanel();
  choicePanel = new ChoicePanel();
  rewindPicker = new RewindPicker();
  historySearch = new HistorySearch();
  /** Show full tool blocks instead of one summary line per run. */
  toolsExpanded = false;
  /** Session whose messages currently back the editor's up-arrow history. */
  private historyFor: string | null = null;
  /** Hide assistant thinking blocks (ctrl-t); starts from pi's setting. */
  thinkingHidden = hideThinkingBlock();
  private activityTimer?: ReturnType<typeof setInterval>;
  editor: InputEditor;
  switcher = new Switcher();
  private readonly link: DaemonLink;

  /** Daemon-known sessions by daemon id. */
  sessions = new Map<number, SessionMeta>();
  /** Sessions from the filesystem (listAll), by session file path. */
  local = new Map<string, LocalSession>();
  /** Transcript state by canonical key (session file path, or daemon:N). */
  views = new Map<string, SessionView>();
  /** Last message text per session key, for the switcher description. */
  summaries = new Map<string, string>();
  readonly attachments = new Attachments();
  private readonly clip: ClipboardActions;
  private readonly completions: CompletionSources;
  /** Path key of the session on screen; null = none (switcher behind). */
  viewing: string | null = null;

  switching: SwitcherActions;
  session: SessionActions;
  /** Spawn/adopt resolved by the daemon's next session list: enter it then. */
  pendingEnterId: number | null = null;
  /** Text to send once pendingEnterId resolves (adopt-then-prompt flow). */
  pendingPrompt: string | null = null;
  /** pi's slash commands for the viewed session (from the daemon). */
  piCommands: Array<{ name: string; description?: string }> = [];
  private commandsFor: string | null = null;
  /** Editor text from before ctrl-r, restored on cancel. */
  private searchDraft = "";
  /** The daemon's initial session list has arrived (false while connecting or reconnecting). */
  private sessionsLoaded = false;
  /** Views still to be replaced by the daemon's replay after a reconnect. */
  private staleViews = new Set<string>();
  /** toriel has the mouse (reporting on); /mouse off hands it to the terminal. */
  private mouseOn = true;
  /** Required toriel resources missing from the pi agent dir; re-checked with the session list. */
  private resourceNotice = "";
  /** This controller's own code and the daemon's, as last compared (on every connect). */
  private readonly build = buildInfo();
  private daemonVerdict: DaemonVerdict = { level: "ok" };
  private daemonHello?: Hello;
  private flash = "";
  private flashTimer?: ReturnType<typeof setTimeout>;
  private listTimer?: ReturnType<typeof setInterval>;

  constructor() {
    this.switching = new SwitcherActions(this);
    this.session = new SessionActions(this);
    this.link = new DaemonLink({
      message: (msg) => this.handleDaemonMessage(msg),
      loaded: () => this.sessionsLoaded,
      lost: () => this.onDaemonLost(),
      retrying: () => {
        this.sessionsLoaded = false;
      },
      reconnected: () => {
        this.renderChrome();
        this.notify("reconnected to the toriel daemon");
      },
      gaveUp: () => {
        process.stdout.write("\ntoriel daemon disconnected and did not come back; exiting.\n");
        this.dispose();
      },
      notify: (text) => this.notify(text),
      daemonChecked: (verdict, hello) => this.onDaemonChecked(verdict, hello),
    }, this.build);
    this.clip = new ClipboardActions(this, () => this.canPaste());
    this.completions = new CompletionSources(this);
    this.tui = guardClicks(
      new TuiAltScreen(new ClipboardTerminal(() => this.clip.onMiddleClick()), true, undefined, {
        wheelScrollLines: wheelScrollLines(),
        copySelection: (text) => this.clip.copyText(text),
        openUrl: (url) => openUrl(url, (text) => this.notify(text)),
      }),
    );
    this.scroll = new ScrollView(this.chatRoot, { follow: "end", primary: true, overscroll: "chain", scrollbar: "auto" });
    this.editor = new InputEditor(this.tui, editorTheme, { paddingX: 1 });
    this.editor.setAutocompleteMaxVisible(autocompleteMaxVisible());
    // looked up at every redraw: a leading `!` (a shell command, not a message) turns the border to the warning colour as it is typed
    this.editor.borderColor = (s) => {
      if (!this.switching.isOpen && /^\s*!/.test(this.editor.getText())) {
        return streaming(s);
      }
      return this.childBorder ? accent(s) : dim(s);
    };
    this.editor.setAutocompleteProvider(
      new CommandAutocomplete(() => ({
        switcher: this.switching.isOpen,
        headerSelected: this.switching.isOpen && this.switcher.currentIsHeader(),
        piCommands: this.piCommands,
        cwd: (this.viewing && (this.metaForPath(this.viewing)?.cwd ?? this.local.get(this.viewing)?.cwd)) || process.cwd(),
        sources: {
          models: () => this.completions.models(),
          thinkingLevels: () => this.completions.thinkingLevels(),
          groups: () => this.switching.groups.groups,
          mcpServers: () => this.completions.mcpServers(),
          agents: () => loadAgents(process.cwd()).agents,
        },
      })),
    );
    this.editor.debugLog = KEY_LOG;
    this.editor.onSubmit = (text) => this.submit(text);
    this.editor.onKey = (data) => this.keys(data);
    const layouts = buildLayouts(this);
    this.chatLayout = layouts.chat;
    this.switcherLayout = layouts.switcher;
    this.tui.setLayoutRoot(this.chatLayout);
    this.tui.setFocus(this.editor);

    this.switcher.heightProvider = () => this.tui.terminal.rows || 24;
    this.switcher.debugLog = KEY_LOG;
    this.switcher.onShiftSession = (delta, s) => fireAndReport(this.switching.moveSession(delta, s), "moving the session", (t) => this.notify(t));
    this.switcher.onShiftGroup = (delta, title) => fireAndReport(this.switching.moveGroup(delta, title), "moving the group", (t) => this.notify(t));
  }

  async run(): Promise<void> {
    trimCommands(HISTORY_FILE);
    await this.link.open();
    await this.loadLocal();
    this.renderChrome();
    try {
      this.tui.start();
      // Make the terminal's own background the page color, so rows no
      // component draws into (below short transcripts, around boxes) match.
      process.stdout.write(OSC_SET_BG);
      process.on("exit", () => process.stdout.write(OSC_RESET_BG));
      this.switching.open(false); // loadLocal ran just above
      // The scan parses every session file on disk, and only the switcher shows what it finds: scan while it is open (and once on each open).
      this.listTimer = setInterval(() => {
        if (!this.switching.isOpen) {
          return;
        }
        void this.loadLocal().then(() => {
          if (this.switching.isOpen) {
            this.switching.refresh();
            this.renderChrome(); // picks up a changed settings file
          }
        });
      }, 10_000);
      this.listTimer.unref?.();
      this.switching.startAutoSummary();
      // park the process; the TUI owns the loop from here
      await new Promise<never>(() => {});
    } finally {
      this.tui.stop();
    }
  }

  /** The daemon of a new connection has been compared with this controller: keep the result for the status line and /doctor, and say it once. */
  private onDaemonChecked(verdict: DaemonVerdict, hello: Hello | undefined): void {
    this.daemonVerdict = verdict;
    this.daemonHello = hello;
    if (verdict.level !== "ok") {
      this.notify(verdict.text);
    }
    this.renderChrome();
  }

  /** The "Daemon" block of /doctor: what runs where and what differs. */
  daemonReport(): string {
    return describeDaemon(this.build, this.daemonHello, compareDaemon(this.build, this.daemonHello));
  }

  /** Always-visible tags before the status line: an isolated instance, and a daemon that is not this toriel's code. */
  private statusTags(): string {
    const tags: string[] = [];
    if (PROFILE) {
      tags.push(`[isolated: ${PROFILE}]`);
    }
    if (this.daemonVerdict.level === "blocked") {
      tags.push("[daemon protocol differs: nothing is sent, see /doctor]");
    } else if (this.daemonVerdict.level === "warn") {
      tags.push("[daemon runs other code, see /doctor]");
    }
    return tags.length > 0 ? `${attention(tags.join(" "))} ` : "";
  }

  /** The connection dropped: keep the UI and the editor text; views are replaced by the daemon's replay on reconnect. */
  private onDaemonLost(): void {
    for (const [key, view] of this.views) {
      clearTransient(view);
      this.staleViews.add(key);
    }
    this.syncActivity(true);
    this.renderChrome();
  }

  /** /mouse: report (no argument), turn on, off or toggle mouse reporting by writing the codes pi-tui wrote at start; pi-tui's own flag stays set so stop still resets the terminal. */
  setMouse(arg: string): void {
    const choice = parseMouseArg(arg);
    if (!choice) {
      this.notify(`mouse: "${arg.trim()}" is not on, off or toggle`);
      return;
    }
    const next = nextMouse(this.mouseOn, choice);
    const changed = next !== this.mouseOn;
    if (changed) {
      this.tui.terminal.write(next ? MOUSE_ON : MOUSE_OFF);
      this.mouseOn = next;
    }
    this.notify(mouseNotice(next, changed));
  }

  dispose(): void {
    this.link.close(); // first: a closing socket must not start a reconnect
    process.stdout.write(OSC_RESET_BG);
    try {
      this.tui.stop();
    } catch {
      // best effort
    }
    process.exit(0);
  }

  send(msg: Record<string, unknown>): void {
    this.link.send(msg);
  }

  request(cmd: DistributiveOmit<ClientCommand, "id">, timeoutMs?: number): Promise<unknown> {
    return this.link.request(cmd, timeoutMs);
  }

  handleDaemonMessage(msg: DaemonMessage): void {
    switch (msg.type) {
      case "sessions":
        this.onSessions(msg.sessions);
        return;
      case "history":
        this.onHistory(msg.session, msg.messages);
        return;
      case "event": {
        const key = this.keyById(msg.session);
        if (key) {
          this.applyEvent(key, this.viewFor(key), msg.event);
        }
        return;
      }
      case "digest": {
        const key = this.keyById(msg.session);
        if (key && drifted(this.views.get(key)?.messages, msg)) {
          this.send({ type: "resync", session: msg.session, seen: this.views.get(key)?.messages });
        }
        return;
      }
      case "ui_request":
        this.onUiRequest(msg.session, msg.request as unknown as DialogRequest);
        return;
      case "notice": {
        const meta = this.sessions.get(msg.session);
        if (meta && msg.durable) {
          this.noteInTranscript(meta, msg.text);
        } else if (meta && this.keyFor(meta) === this.viewing) {
          this.notify(msg.text);
        }
        return;
      }
      case "exited": {
        const meta = this.sessions.get(msg.session);
        if (meta) {
          this.noteInTranscript(meta, msg.reason ? `child exited - ${msg.reason}` : "child exited");
        }
        return;
      }
    }
  }

  private onSessions(metas: SessionMeta[]): void {
    this.sessionsLoaded = true;
    this.sessions.clear();
    for (const meta of metas) {
      this.sessions.set(meta.id, meta);
      // Migrate item keys once a session gains its file path.
      const tmpKey = `daemon:${meta.id}`;
      if (meta.sessionFile) {
        const tmpView = this.views.get(tmpKey);
        if (tmpView && !this.views.has(meta.sessionFile)) {
          this.views.set(meta.sessionFile, tmpView);
          this.views.delete(tmpKey);
        }
        if (this.viewing === tmpKey) {
          this.viewing = meta.sessionFile;
        }
      }
    }
    // Resolved spawn: enter the session we just created.
    if (this.pendingEnterId !== null && this.sessions.has(this.pendingEnterId)) {
      const meta = this.sessions.get(this.pendingEnterId)!;
      this.pendingEnterId = null;
      const queuedPrompt = this.pendingPrompt;
      this.pendingPrompt = null;
      this.viewing = this.keyFor(meta);
      if (queuedPrompt) {
        void this.session.prompt(queuedPrompt);
      }
      this.switching.close();
    }
    for (const meta of metas) {
      this.syncDialog(meta);
    }
    if (this.switching.isOpen) {
      this.switching.refresh();
    }
    this.renderChrome();
  }

  /**
   * Keep the open dialog in step with the daemon's record of it: one the child
   * has settled itself (timeout, abort, turn over) is dropped, and one the
   * daemon holds for us but we never saw (it arrived before we knew the
   * session) is asked for again.
   */
  private syncDialog(meta: SessionMeta): void {
    const key = this.keyFor(meta);
    const view = this.views.get(key);
    if (!meta.pendingDialog && view?.dialog) {
      view.dialog = undefined;
    } else if (meta.pendingDialog && meta.attachedToYou && !view?.dialog) {
      this.send({ type: "attach", session: meta.id });
    }
  }

  private onHistory(sessionId: number, messages: unknown[]): void {
    const key = this.keyById(sessionId);
    if (!key) {
      return;
    }
    const old = this.views.get(key);
    const items = itemsFromMessages(messages, this.tui, this.metaForPath(key)?.cwd ?? "");
    const fresh = viewFromHistory(old, items, this.staleViews.delete(key), messages.length);
    this.views.set(key, fresh);
    if (key === this.viewing) {
      this.rebuildChat();
    }
  }

  private onUiRequest(sessionId: number, request: DialogRequest | undefined): void {
    const key = this.keyById(sessionId);
    if (!key) {
      return;
    }
    const view = this.viewFor(key);
    if (request && DIALOG_METHODS.has(request.method)) {
      const reason = view.pendingReason;
      view.pendingReason = undefined;
      if (reason && isTextDialog(request) && Date.now() - reason.at < REASON_FRESH_MS) {
        this.send({
          type: "ui_response",
          session: sessionId,
          response: { type: "extension_ui_response", id: request.id, value: reason.text },
        });
      } else {
        // Name the session that is blocked, so the dialog says who is asking.
        view.dialog = withOwnLayout(withOrigin(request, sessionId, this.sessions.get(sessionId)?.sessionName, this.sessions.get(sessionId)?.subagent ? "Subagent" : "Session"), loadSettings().settings.permissionGrantDurations ?? DEFAULT_GRANT_DURATIONS);
      }
    } else if (request && request.method === "notify") {
      const message = String(request.message ?? "notification");
      const explained = explainMcpFailure(message);
      if (explained) {
        // a panel, not the one-line flash: the explanation and what to check do not fit on the status line
        this.infoPanel.show(explained);
        this.tui.requestRender();
        this.notify("MCP sign-in failed (details in the panel)");
      } else {
        this.notify(message);
      }
    }
    if (key === this.viewing || this.dialogOwnerKey(this.viewing) === key) {
      this.renderChrome();
    }
  }

  /** Whether a paste has somewhere to go: not while a panel or dialog is waiting for its own keys. */
  private canPaste(): boolean {
    return !(this.choicePanel.isOpen || this.infoPanel.isOpen || this.historySearch.isOpen || this.openDialog(this.viewing));
  }

  copyText(text: string): Promise<boolean | string> {
    return this.clip.copyText(text);
  }

  keyById(sessionId: number): string | null {
    const meta = this.sessions.get(sessionId);
    return meta ? this.keyFor(meta) : null;
  }

  keyFor(meta: SessionMeta): string {
    return sessionKey(meta);
  }

  metaForPath(key: string): SessionMeta | undefined {
    return [...this.sessions.values()].find((m) => this.keyFor(m) === key);
  }

  cwdFor(key: string): string {
    return this.metaForPath(key)?.cwd ?? this.local.get(key)?.cwd ?? process.cwd();
  }

  reloadView(key: string): void {
    this.views.set(key, { ...newView(), items: itemsFromFile(key, this.tui, this.cwdFor(key)) });
    this.summaries.delete(key);
    this.rebuildChat();
    this.syncHistory(true); // the dropped messages are no longer history
  }

  viewFor(key: string): SessionView {
    let view = this.views.get(key);
    if (!view) {
      view = newView();
      this.views.set(key, view);
    }
    return view;
  }

  async loadLocal(): Promise<void> {
    this.resourceNotice = summarizeFindings(collectFindings({ permissionSystem: loadSettings().settings.warnNoPermissionSystem !== false, startup: [] })) ?? "";
    try {
      const infos = await SessionManager.listAll();
      this.local.clear();
      for (const info of infos) {
        this.local.set(info.path, {
          path: info.path,
          id: info.id,
          name: info.name,
          cwd: info.cwd,
          firstMessage: info.firstMessage ?? "",
          lastActivity: lastLine(info.allMessagesText ?? ""),
          modified: info.modified instanceof Date ? info.modified.getTime() : Date.parse(String(info.modified)) || 0,
        });
      }
    } catch (err) {
      console.error(`listAll failed: ${err}`);
    }
  }

  /**
   * Host.openReviewSession: seed a session file whose opening message frames
   * the session, then spawn a session on it. The report follows later as a
   * delivered message (the seed asks the session to wait for it), so the view
   * can enter the session immediately - the switch happens at command time,
   * not after the analysis.
   */
  async openReviewSession(cwd: string, name: string): Promise<{ name: string; uuid?: string }> {
    const mgr = SessionManager.create(cwd);
    mgr.appendMessage({ role: "user", content: performanceReviewSeed(), timestamp: Date.now() });
    const file = mgr.getSessionFile();
    if (!file || !fs.existsSync(file)) {
      throw new Error("could not create the review session's file");
    }
    const unique = this.uniqueSessionName(name);
    // ready: only report success once the child is actually up (startViewed waits the same way)
    let uuid: string | undefined;
    try {
      const r = (await this.request({ type: "spawn", cwd, sessionFile: file, name: unique, ready: true })) as { sessionId?: number; sessionUuid?: string };
      uuid = r?.sessionUuid;
      // Enter the session right away (the /fork flow): switch now when the
      // child's meta is loaded, otherwise the next sessions message enters it.
      const id = r?.sessionId;
      const meta = typeof id === "number" ? this.sessions.get(id) : undefined;
      if (meta) {
        this.viewing = this.keyFor(meta);
        this.rebuildChat();
      } else if (typeof id === "number") {
        this.pendingEnterId = id;
      }
    } catch (err) {
      // No child means no session: remove the seeded file or it lingers in pi's
      // session dir as an unnamed ghost in the switcher list.
      fs.rmSync(file, { force: true });
      throw err;
    }
    return { name: unique, uuid };
  }

  // ---------------- switcher ----------------


  // ---------------- key + submit routing ----------------

  /** Editor key hook: dialog answers first, then the active view's keys. */
  keys(data: string): boolean {
    if (isKeyRelease(data)) {
      return true;
    }
    // a dialog owns the keys (and the screen): panels opened before it, e.g. a /btw answer, wait behind it
    const dialogUp = this.dialogOpen();
    if (this.choicePanel.isOpen && !dialogUp) {
      const handled = this.choicePanel.keys(data);
      this.tui.requestRender();
      return handled;
    }
    if (this.infoPanel.isOpen && !dialogUp) {
      if (this.infoPanel.act(data)) {
        this.tui.requestRender();
        return true;
      }
      // arrows, page keys, home and end scroll text taller than the screen
      if (this.infoPanel.scrollKey(data)) {
        this.tui.requestRender();
        return true;
      }
      // any other key dismisses command output; esc/enter are only for that
      this.infoPanel.close();
      this.tui.requestRender();
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
        return true;
      }
    }
    const ownerKey = this.dialogOwnerKey(this.viewing);
    const view = ownerKey ? this.views.get(ownerKey) : undefined;
    if (ownerKey && view?.dialog && dialogUp && this.session.dialogKeys(view, data, ownerKey)) {
      return true;
    }
    if (this.historySearch.isOpen) {
      return this.searchKeys(data);
    }
    if (matchesKey(data, Key.ctrl("v"))) {
      void this.clip.paste();
      return true;
    }
    if (matchesKey(data, Key.ctrl("r")) && !this.rewindPicker.isOpen && !this.switching.isOpen) {
      this.searchDraft = this.editor.getText();
      this.historySearch.open(this.currentHistory());
      this.editor.setText(this.historySearch.promptText());
      this.notify("ctrl-r older - ctrl-s newer - enter use - esc cancel");
      this.tui.requestRender();
      return true;
    }
    if (this.switching.isOpen) {
      return this.switching.keys(data);
    }
    if (this.rewindPicker.isOpen) {
      return this.session.pickerKeys(data);
    }
    if (matchesKey(data, Key.ctrl("o"))) {
      this.toggleTools();
      return true;
    }
    if (matchesKey(data, Key.ctrl("t"))) {
      this.toggleThinking();
      return true;
    }
    return this.session.keys(data);
  }

  submit(text: string): void {
    if (KEY_LOG) {
      try {
        fs.appendFileSync(KEY_LOG, `SUBMIT ${JSON.stringify(text)} open=${this.switching.isOpen}\n`);
      } catch {
        // debug only
      }
    }
    const command = text.trim();
    // a `!command` is remembered too (up-arrow), even when it cannot run yet
    if (command.length > 1 && (command.startsWith("/") || (command.startsWith("!") && !this.switching.isOpen))) {
      recordCommand(HISTORY_FILE, command);
      this.editor.addToHistory(command);
    }
    if (this.switching.isOpen) {
      this.switching.submit(text.trim());
    } else {
      this.session.submit(text);
    }
  }

  applyEvent(key: string, view: SessionView, ev: Record<string, unknown>): void {
    const effects = applyEvent(view, ev, {
      tui: this.tui,
      cwd: this.cwdFor(key),
      addItem: (item) => this.addItem(view, key, item),
    });
    if (effects.summary) {
      this.summaries.set(key, effects.summary);
    }
    const info = this.local.get(key);
    if (effects.messageEnded && info) {
      info.modified = Date.now();
    }
    if (key === this.viewing) {
      this.syncActivity();
      this.tui.requestRender();
    }
  }

  /**
   * Point the activity strip at the viewed session and run the animation
   * timer only while there is something to animate (no idle redraws).
   */
  syncActivity(opened = false): void {
    const view = this.viewing ? this.views.get(this.viewing) : undefined;
    if (opened && view && !view.activity && this.viewing && this.metaForPath(this.viewing)?.streaming) {
      // opened mid-run: the start event predates us. Only on open - the
      // daemon's streaming flag lags behind events and would resurrect a
      // spinner after agent_settled.
      view.activity = { label: "working", since: Date.now() };
    }
    this.activityLine.state = view ?? { queue: [] };
    // the transcript spinner, or (switcher open) the spinner on streaming rows
    const switcherBusy = this.switching.isOpen && [...this.sessions.values()].some((m) => m.streaming);
    const animate = (Boolean(view?.activity) && !this.switching.isOpen) || switcherBusy;
    if (animate && !this.activityTimer) {
      this.activityTimer = setInterval(() => this.tui.requestRender(), 100);
    } else if (!animate && this.activityTimer) {
      clearInterval(this.activityTimer);
      this.activityTimer = undefined;
    }
  }

  echoPrompt(key: string, text: string, images: ImageBlock[] = []): void {
    const view = this.viewFor(key);
    echoUser(view, text, { addItem: (item) => this.addItem(view, key, item) }, images);
    if (key === this.viewing) {
      this.scroll.scrollToEnd();
      this.syncActivity();
      this.tui.requestRender();
    }
  }

  uniqueSessionName(wanted: string, selfKey?: string): string {
    const taken: string[] = [];
    for (const m of this.sessions.values()) {
      if (m.sessionName && this.keyFor(m) !== selfKey) {
        taken.push(m.sessionName);
      }
    }
    for (const [key, info] of this.local) {
      if (info.name && key !== selfKey) {
        taken.push(info.name);
      }
    }
    return uniqueName(wanted, taken);
  }

  dropEcho(key: string, text: string): void {
    const view = this.views.get(key);
    if (view && dropEcho(view, text)) {
      if (key === this.viewing) {
        this.rebuildChat();
      }
    }
  }

  /**
   * Something the daemon did that the user should be able to read back later (a grant answered a prompt, a child died): a dim
   * row in that session's transcript, next to the tool call it explains, not a flash. Kept on the view so a history reload
   * does not lose it. A session whose transcript was never loaded here has nothing to attach it to, and must not get a view
   * made just for the note: an existing view is what stops the switcher replaying that session's file when it is opened.
   */
  private noteInTranscript(meta: SessionMeta, text: string): void {
    const key = this.keyFor(meta);
    const view = this.views.get(key);
    if (!view) {
      if (key === this.viewing) {
        this.notify(text);
      }
      return;
    }
    const item = noteRow(text);
    view.notes = [...(view.notes ?? []), item];
    this.addItem(view, key, item);
    if (key === this.viewing) {
      this.renderChrome();
    }
  }

  /** Mount new items immediately on the viewed session; rebuildChat() mounts the rest. */
  addItem(view: SessionView, key: string, item: Item): void {
    this.applyDisplay(item);
    view.items.push(item);
    if (item.kind === "tools") {
      markLatestRun(view);
    }
    if (key === this.viewing) {
      this.chatRoot.addChild(item.component);
    }
  }

  /** Apply the global display toggles (tools expanded, thinking hidden) to one item. */
  private applyDisplay(item: Item): void {
    if (item.kind === "tools") {
      item.component.expanded = this.toolsExpanded;
    } else if (item.kind === "compaction") {
      item.component.setExpanded(this.toolsExpanded);
    } else if (item.kind === "assistant") {
      // Blank label: the working indicator already says "thinking", so a hidden block leaves no line behind.
      item.component.setHiddenThinkingLabel("");
      item.component.setHideThinkingBlock(this.thinkingHidden);
      item.component.setShowRawError(this.toolsExpanded);
    } else if (item.kind === "bash") {
      item.component.setExpanded(this.toolsExpanded);
    } else if (item.kind === "other") {
      showRawError(item, this.toolsExpanded);
    }
  }

  /** Re-apply the display toggles everywhere without moving the scroll position. */
  private redisplay(): void {
    for (const view of this.views.values()) {
      for (const item of view.items) {
        this.applyDisplay(item);
      }
    }
    this.chatRoot.invalidate();
    this.tui.requestRender(true);
  }

  /** Show/hide thinking blocks (ctrl-t); applies to all sessions. */
  toggleThinking(): void {
    this.thinkingHidden = !this.thinkingHidden;
    this.redisplay();
  }

  /** Expand/collapse every tool run (ctrl-o); applies to all sessions. */
  toggleTools(): void {
    this.toolsExpanded = !this.toolsExpanded;
    this.redisplay();
  }

  /**
   * Up-arrow history for what is on screen: the viewed session's own prompts
   * (read from its file, so it survives restarts) merged with the shared
   * command log; in the switcher, commands only. `force` re-reads even when
   * the context has not changed (after a rewind).
   */
  /** Keys while the ctrl-r search line is open; it swallows everything. */
  private searchKeys(data: string): boolean {
    const result = this.historySearch.handleKey(data);
    if (result === "none") {
      this.editor.setText(this.historySearch.promptText());
    } else {
      this.editor.setText(result === "accept" ? (this.historySearch.current() ?? "") : this.searchDraft);
      this.historySearch.close();
    }
    this.tui.requestRender();
    return true;
  }

  /** History texts (oldest first) for what is on screen. */
  private currentHistory(): string[] {
    let prompts: Array<{ ts: number; text: string }> = [];
    const key = this.viewing;
    if (!this.switching.isOpen && key && fs.existsSync(key)) {
      try {
        // `!command` runs are in the command log already (as typed); their results in the file are not history
        prompts = rewindTargets(key).filter((t) => !t.local);
      } catch {
        // unreadable file: commands only
      }
    }
    return mergeHistory(prompts, loadCommands(HISTORY_FILE));
  }

  syncHistory(force = false): void {
    const token = this.switching.isOpen ? SWITCHER_HISTORY : this.viewing;
    if (!force && token === this.historyFor) {
      return;
    }
    this.editor.setHistory(this.currentHistory());
    this.historyFor = token;
  }

  /** Fetch pi's slash commands for the viewed session, once per session on screen. */
  private syncCommands(): void {
    const key = this.viewing;
    if (!key || key === this.commandsFor) {
      return;
    }
    this.commandsFor = key;
    const session = this.metaForPath(key)?.id;
    this.request({ type: "commands", session })
      .then((list) => {
        if (key === this.commandsFor && Array.isArray(list)) {
          this.piCommands = list as Array<{ name: string; description?: string }>;
          if (list.length === 0) {
            this.commandsFor = null; // no child to ask yet; try again next time
          }
        }
      })
      .catch(() => {
        this.commandsFor = null; // retry on the next view change
      });
  }

  rebuildChat(): void {
    this.syncHistory();
    this.syncCommands();
    this.chatRoot.clear();
    const view = this.viewing ? this.views.get(this.viewing) : undefined;
    if (view) {
      markLatestRun(view);
      for (const item of view.items) {
        this.applyDisplay(item);
        this.chatRoot.addChild(item.dimmed ? new Dimmed(item.component) : item.component);
      }
    }
    this.scroll.scrollToEnd();
    this.syncActivity(true);
    this.tui.requestRender(true);
  }

  notify(message: string): void {
    this.flash = message;
    this.renderChrome();
    if (this.flashTimer) {
      clearTimeout(this.flashTimer);
    }
    this.flashTimer = setTimeout(() => {
      this.flash = "";
      this.renderChrome();
    }, 4000);
  }

  forgetLineage(): void {
    this.lineageCache = { at: 0, data: {} };
    this.renderChrome();
  }

  /** lineage.json, re-read at most every two seconds (the status line renders often). */
  private lineage(): Lineage {
    if (Date.now() - this.lineageCache.at > 2000) {
      this.lineageCache = { at: Date.now(), data: loadLineage() };
    }
    return this.lineageCache.data;
  }

  /** Display name of the session with this UUID, when we know it. */
  nameOfSession(uuid: string): string | undefined {
    const live = [...this.sessions.values()].find((m) => m.sessionId === uuid);
    const file = [...this.local.values()].find((l) => l.id === uuid);
    return live?.sessionName ?? file?.name ?? (file ? displayName(live, file) : undefined);
  }

  /** The dialog waiting in the session on screen; none while the switcher is up (it stays pending, and is shown again on re-entering). */
  private openDialog(key: string | null): DialogRequest | undefined {
    const owner = this.dialogOwnerKey(key);
    return owner && !this.switching.isOpen ? this.views.get(owner)?.dialog : undefined;
  }

  /** The view holding the dialog shown with `key` on screen: its own, else one a subagent it started is waiting on (dialog-route.ts). */
  private dialogOwnerKey(key: string | null): string | undefined {
    return dialogOwner(key, this.views, this.sessions.values(), (m) => this.keyFor(m));
  }

  /** Whether a dialog is waiting in the session on screen. */
  dialogOpen = (): boolean => this.openDialog(this.viewing) !== undefined;

  renderChrome(): void {
    this.syncActivity();
    this.dialogPanel.sync(this.openDialog(this.viewing));
    const width = this.tui.terminal.columns || process.stdout.columns || 80;
    const key = this.viewing;
    const stats = fleetStats(this.sessions.values());
    this.switcher.counts = { running: stats.running, waiting: stats.waiting };
    this.switcher.budget = { cost: stats.cost, tokens: stats.tokens };
    this.switcher.height = this.tui.terminal.rows || 24;
    const meta = key ? this.metaForPath(key) : undefined;
    const lineage = this.lineage();
    const uuid = meta?.sessionId ?? (key ? this.local.get(key)?.id : undefined);
    const rel = relationOf(lineage, uuid);
    const parentName = rel ? this.nameOfSession(rel.parentId) ?? rel.parentName : undefined;
    this.banner.setText(rel && parentName && !this.switching.isOpen ? accent(truncateToWidth(` ${bannerText(rel, parentName)}`, width)) : "");
    this.scheduleStrip.setText(meta?.scheduleLines?.length && !this.switching.isOpen ? meta.scheduleLines.map((l) => dim(truncateToWidth(` ${l}`, width))).join("\n") : "");
    this.childBorder = !!rel && !this.switching.isOpen;
    const costOf = (id: string): number => [...this.sessions.values()].find((m) => m.sessionId === id)?.cost ?? 0;
    const status = buildStatusLine({
      relation: rel && parentName ? { kind: rel.kind, parentName } : undefined,
      childCost: childCost(lineage, uuid, costOf),
      switcherOpen: this.switching.isOpen,
      selectedName: this.switcher.current()?.name,
      viewing: key,
      meta: key ? this.metaForPath(key) : undefined,
      info: key ? this.local.get(key) : undefined,
      stats,
      flash: this.flash,
      dialog: this.openDialog(key),
      mouseOff: !this.mouseOn,
      activity: key ? this.views.get(key)?.activity?.label : undefined,
      width,
      // a clipboard problem is worth a standing note while the switcher is up; it is not an error
      notice: (this.link.down ? "daemon connection lost - reconnecting (your input is kept)" : "") || this.resourceNotice || settingsNotice(this.sessions.values(), settingsMtime()) || bridgeNotice(this.sessions.values()) || (this.clip.clipboard.problem ? `clipboard: ${this.clip.clipboard.problem}` : ""),
    });
    this.statusLine.setText(truncateToWidth(`${this.statusTags()}${status}`, width));
    this.tui.requestRender();
  }
}

function main(): void {
  if (process.argv[2] === "kill-server") {
    void killServer();
    return;
  }
  try {
    assertTruecolor();
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  }
  const controller = new Controller();
  process.on("SIGINT", () => controller.dispose());
  process.on("SIGTERM", () => controller.dispose());
  // A promise nobody awaited that rejects (a failed save, a dead socket) is reported, not fatal: node's default would
  // turn it into an uncaught exception and take the whole TUI down.
  process.on("unhandledRejection", (reason) => {
    controller.notify(`something went wrong: ${errText(reason)}`);
  });
  process.on("uncaughtException", (err) => {
    try {
      controller.tui.stop();
    } catch {
      // best effort
    }
    throw err;
  });
  controller.run().catch((err) => {
    process.stderr.write(`${errText(err)}\n`);
    process.exit(1);
  });
}

main();
