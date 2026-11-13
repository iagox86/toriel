// Session-side actions of the controller: keys in the chat view, permission
// dialog answers, and prompting (including the fork-confirm and adopt flows).
import * as fs from "node:fs";
import * as path from "node:path";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { coversPattern, isCappedSurface } from "./permissions.ts";
import { answerValue, type DialogRequest, dialogAnswer, editablePattern, grantGuarded, grantRowFor, isTextDialog, isTypingKey, optionTakesReason } from "./dialogs.ts";
import { isPlainLeft } from "./editor.ts";
import { fmtAge } from "./format.ts";
import { TRASH_DIR } from "./config.ts";
import { latestClearBackup, rewindTargets } from "./rewind.ts";
import type { Host } from "./host.ts";
import type { SessionMeta } from "./shared.ts";
import { SessionCommands } from "./session-commands.ts";
import { SESSION_COMMANDS } from "./commands.ts";
import { checkSlash } from "./unknown-command.ts";
import type { SessionView } from "./transcript.ts";
import { errText } from "./util.ts";

const DOUBLE_ESC_MS = 600;

/** A prompt as it goes to the daemon. */
interface Outgoing {
  /** The text without image markers. */
  message: string;
  images: ReturnType<Host["attachments"]["take"]>["images"];
  /** What is sent (a placeholder when only an image was pasted). */
  sent: string;
  /** Show it in the transcript at once. */
  echo: boolean;
}
/** The daemon stops a command after 10 minutes; wait a little longer than that for its answer. */
const BANG_TIMEOUT_MS = 11 * 60_000;

export class SessionActions {
  /** Armed: prompting a recently-modified external session (fork warning). */
  armedFork: string | null = null;
  /** Prompts sent to sleeping sessions (by file) whose answer is still pending, with the text sent. */
  private readonly startingPrompts = new Map<string, string>();
  /** Session whose `!command` is running, so esc can stop it. */
  private bangSession: number | undefined;

  private readonly h: Host;
  private readonly commands: SessionCommands;
  private lastEsc = 0;

  constructor(host: Host) {
    this.h = host;
    this.commands = new SessionCommands(host);
  }

  resetArmed(): void {
    this.armedFork = null;
  }

  /** Keys in the chat view (the switcher is closed). */
  keys(data: string): boolean {
    if (matchesKey(data, Key.escape)) {
      // esc = interrupt the running agent (pi muscle memory); also
      // cancels an armed fork-confirm
      this.armedFork = null;
      const meta = this.h.viewing ? this.h.metaForPath(this.h.viewing) : undefined;
      const view = this.h.viewing ? this.h.views.get(this.h.viewing) : undefined;
      // A prompt just sent is working before the daemon reports streaming
      const working = Boolean(meta?.streaming) || (view?.echoes.length ?? 0) > 0;
      const now = Date.now();
      if (this.bangSession !== undefined && !working) {
        this.h.send({ type: "abort_bash", session: this.bangSession });
        return true;
      }
      if (working) {
        // esc while working only ever interrupts; it never arms the rewind double-tap
        this.lastEsc = 0;
        if (meta?.id !== undefined && meta.attachedToYou) {
          void this.abortRestoringQueue(meta.id);
        }
        return true;
      }
      // esc esc on an idle session with an empty editor = rewind
      if (now - this.lastEsc < DOUBLE_ESC_MS && this.h.editor.getText().length === 0) {
        this.lastEsc = 0;
        this.openRewind();
        return true;
      }
      this.lastEsc = now;
      return true;
    }
    // ctrl-b = move the running command to the background. Only while the agent
    // works (or a prompt was just sent): when idle it stays the editor's cursor-left.
    if (matchesKey(data, Key.ctrl("b"))) {
      const meta = this.h.viewing ? this.h.metaForPath(this.h.viewing) : undefined;
      const view = this.h.viewing ? this.h.views.get(this.h.viewing) : undefined;
      if (this.bangSession !== undefined) {
        this.h.notify("a ! command cannot move to the background (esc stops it)");
        return true;
      }
      if (meta?.streaming || (view?.echoes.length ?? 0) > 0) {
        this.commands.background();
        return true;
      }
      return false;
    }
    if (matchesKey(data, Key.up) && this.h.editor.getText().length === 0) {
      const meta = this.h.viewing ? this.h.metaForPath(this.h.viewing) : undefined;
      const view = this.h.viewing ? this.h.views.get(this.h.viewing) : undefined;
      if (meta?.id !== undefined && meta.attachedToYou && (view?.queue.length ?? 0) > 0) {
        void this.unqueue(meta.id);
        return true;
      }
      return false; // history
    }
    if (isPlainLeft(data) && this.h.editor.getText().trim().length === 0) {
      this.h.switching.open();
      return true;
    }
    return false;
  }


  /**
   * Abort the run. Messages still queued are pulled back into the editor
   * first (pi's own Esc behavior) - an abort alone would go on to deliver them.
   */
  private async abortRestoringQueue(session: number): Promise<void> {
    const queued = await this.takeQueue(session);
    this.h.send({ type: "abort", session });
    this.restoreQueued(queued, "aborted", "\n\n");
  }

  /** Up in an empty box with messages queued: pull them back into the editor. */
  private async unqueue(session: number): Promise<void> {
    const queued = await this.takeQueue(session);
    if (queued.length > 0) {
      this.restoreQueued(queued, "unqueued", "\n");
    }
  }

  /** Drop pi's queued steering/follow-up messages and return their text. */
  private async takeQueue(session: number): Promise<string[]> {
    try {
      const q = (await this.h.request({ type: "clear_queue", session })) as { steering?: string[]; followUp?: string[] };
      return [...(q.steering ?? []), ...(q.followUp ?? [])];
    } catch {
      return []; // queue state unknown
    }
  }

  private restoreQueued(queued: string[], verb: string, separator: string): void {
    const view = this.h.viewing ? this.h.views.get(this.h.viewing) : undefined;
    if (view) {
      view.queue = [];
    }
    if (queued.length > 0) {
      this.h.editor.setText([...queued, this.h.editor.getText()].filter((t) => t.trim()).join(separator));
      this.h.notify(`${verb} - ${queued.length} queued message${queued.length === 1 ? "" : "s"} back in the editor`);
    } else {
      this.h.notify(verb);
    }
    this.h.tui.requestRender();
  }

  /** Open the rewind list for the viewed session. */
  private openRewind(): void {
    const key = this.h.viewing;
    if (!key || !fs.existsSync(key)) {
      this.h.notify("nothing to rewind yet");
      return;
    }
    let targets = rewindTargets(key);
    if (targets.length === 0) {
      // an emptied session offers to undo its /clear instead
      const backup = latestClearBackup(TRASH_DIR, key);
      if (!backup) {
        this.h.notify("nothing to rewind yet");
        return;
      }
      targets = [
        {
          entryId: "",
          text: `Restore the ${backup.entries} entries cleared from this session`,
          ts: 0,
          restore: { entries: backup.entries, trashedAt: backup.trashedAt },
        },
      ];
    }
    this.h.rewindPicker.open(targets);
    this.h.tui.requestRender();
  }

  /** Keys while the rewind list is open; it swallows everything. */
  pickerKeys(data: string): boolean {
    const picker = this.h.rewindPicker;
    if (matchesKey(data, Key.escape)) {
      picker.close();
    } else if (matchesKey(data, Key.up)) {
      picker.move(-1);
    } else if (matchesKey(data, Key.down)) {
      picker.move(1);
    } else if (matchesKey(data, Key.enter)) {
      const target = picker.current();
      picker.close();
      if (target?.restore) {
        void this.restoreCleared();
      } else if (target) {
        void this.rewindTo(target.entryId);
      }
    }
    this.h.tui.requestRender();
    return true;
  }

  private async restoreCleared(): Promise<void> {
    const key = this.h.viewing;
    if (!key) {
      return;
    }
    const meta = this.h.metaForPath(key);
    try {
      await this.h.request(meta ? { type: "restore_clear", session: meta.id } : { type: "restore_clear", path: key });
      this.h.reloadView(key);
      this.h.notify("restored the cleared conversation");
      void this.h.loadLocal();
    } catch (err) {
      this.h.notify(`restore failed: ${errText(err)}`);
    }
  }

  private async rewindTo(entryId: string): Promise<void> {
    const key = this.h.viewing;
    if (!key) {
      return;
    }
    const meta = this.h.metaForPath(key);
    try {
      const r = (await this.h.request(
        meta ? { type: "rewind", session: meta.id, entryId } : { type: "rewind", path: key, entryId },
      )) as { text: string; removed: number };
      this.h.reloadView(key);
      this.h.editor.setText(r.text);
      this.h.notify(`rewound - ${r.removed} entries moved to trash`);
      void this.h.loadLocal();
    } catch (err) {
      this.h.notify(`rewind failed: ${errText(err)}`);
    }
  }

  /** Returns true when the key was consumed as a dialog answer. */
  dialogKeys(view: SessionView, data: string, ownerKey = this.h.viewing): boolean {
    const dialog = view.dialog!;
    if (!this.h.viewing || !ownerKey) {
      return false;
    }
    const meta = this.h.metaForPath(ownerKey);
    // a subagent's dialog shown in its parent's view is answered without attaching to the subagent, but only by the controller
    // attached to the parent (tickets 121, 122: two controllers on one parent must not both answer)
    const speaker = ownerKey === this.h.viewing ? meta : this.h.metaForPath(this.h.viewing);
    if (!meta || !speaker?.attachedToYou) {
      return false;
    }
    if (isTextDialog(dialog)) {
      const skip = matchesKey(data, Key.escape);
      if (!skip && !matchesKey(data, Key.enter)) {
        return matchesKey(data, Key.tab); // typing goes to the input box, completion does not
      }
      const text = skip ? "" : this.h.editor.getText().trim();
      this.h.editor.setText("");
      this.h.send({
        type: "ui_response",
        session: meta.id,
        response: { type: "extension_ui_response", id: dialog.id, ...(text ? { value: text } : { cancelled: true }) },
      });
      view.dialog = undefined;
      this.h.renderChrome();
      return true;
    }
    const panel = this.h.dialogPanel;
    if (dialog.method === "select" && this.inlineReason(view, meta.id, data)) {
      return true;
    }
    if (dialog.method === "select" && (matchesKey(data, Key.up) || matchesKey(data, Key.down))) {
      panel.move(matchesKey(data, Key.up) ? -1 : 1);
      this.h.renderChrome();
      return true;
    }
    // normalize enter/esc across keyboard protocols to what dialogAnswer expects
    let raw = data;
    if (matchesKey(data, Key.enter)) {
      raw = "\r";
    } else if (matchesKey(data, Key.escape)) {
      raw = "\x1b";
    }
    const fields = dialogAnswer(dialog, raw, panel.highlighted);
    if (!fields) {
      // modal: typing and completion must not reach the message box while a permission is pending
      return isTypingKey(data) || matchesKey(data, Key.enter) || matchesKey(data, Key.tab);
    }
    if (grantGuarded(dialog, fields)) {
      return true;
    }
    const row = grantRowFor(dialog, fields.value);
    if (row) {
      this.answerWithGrant(meta.id, view, dialog, row.for);
      return true;
    }
    this.h.send({ type: "ui_response", session: meta.id, response: { type: "extension_ui_response", id: dialog.id, ...fields, ...("value" in fields ? { value: answerValue(dialog, fields.value) } : {}) } });
    view.dialog = undefined;
    this.h.renderChrome();
    return true;
  }

  /**
   * toriel's "allow for ..." rows answer pi with its plain "Yes" and keep the grant (with `pattern` in place of the suggested one,
   * when it was edited). A file-path grant is stored first, because the daemon makes it only while the prompt is still open, and pi is
   * answered only once that worked; the other kinds answer at once and store after.
   */
  private answerWithGrant(session: number, view: SessionView, dialog: DialogRequest, life: string, pattern?: string): void {
    const answer = (): void => {
      if (view.dialog !== dialog) {
        return; // answered some other way meanwhile
      }
      this.h.send({ type: "ui_response", session, response: { type: "extension_ui_response", id: dialog.id, value: "Yes" } });
      view.dialog = undefined;
      this.h.renderChrome();
    };
    if (!(dialog.toriel?.grants ?? []).some((g) => isCappedSurface(g.surface))) {
      answer();
      this.rememberGrants(session, dialog, life, pattern);
      return;
    }
    void this.storeGrants(session, dialog, life, pattern).then((ok) => (ok ? answer() : undefined));
  }

  /** Store the grant(s) the dialog suggested, lasting `life`; failures are said, not swallowed. */
  private rememberGrants(session: number, dialog: DialogRequest, life: string, pattern?: string): void {
    void this.storeGrants(session, dialog, life, pattern);
  }

  /** `rememberGrants`, saying whether every grant was kept. A file-path grant names the prompt it comes from. */
  private async storeGrants(session: number, dialog: DialogRequest, life: string, pattern?: string): Promise<boolean> {
    let ok = true;
    for (const g of (dialog.toriel?.grants ?? []).map((x) => (pattern === undefined ? x : { ...x, pattern }))) {
      try {
        const r = await this.h.request({ type: "permission_add", session, surface: g.surface, pattern: g.pattern, for: life, source: "dialog", ...(isCappedSurface(g.surface) ? { dialog: dialog.id } : {}) });
        this.h.notify((r as { echo: string }).echo);
      } catch (err) {
        ok = false;
        this.h.notify(`could not keep the permission grant: ${errText(err)}`);
      }
    }
    return ok;
  }

  /**
   * Tab on a "provide reason" option types the reason inline. The reason is
   * held on the view and answers the input dialog the package chains after the
   * select. Returns true when the key was consumed.
   */
  private inlineReason(view: SessionView, session: number, data: string): boolean {
    const panel = this.h.dialogPanel;
    const dialog = view.dialog!;
    const text = panel.editing;
    if (text === null) {
      if (matchesKey(data, Key.tab)) {
        const option = panel.highlightedOption;
        const pattern = editablePattern(dialog, option);
        if (pattern !== undefined) {
          // a toriel "allow for ..." row: type the pattern to store instead of the suggested one
          panel.edit(pattern);
        } else if (optionTakesReason(dialog, option)) {
          panel.edit("");
        } else {
          return false;
        }
        this.h.renderChrome();
        return true;
      }
      return false;
    }
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.escape)) {
      panel.edit(null);
    } else if (matchesKey(data, Key.enter)) {
      const value = panel.highlightedOption;
      const reason = text.trim();
      if (value === undefined) {
        return true;
      }
      const row = grantRowFor(dialog, value);
      if (row) {
        // editing a grant pattern: pi just hears "Yes"; the grant is toriel's own record, consulted by the grants link on later asks
        if (reason === "") {
          this.h.notify("a grant pattern cannot be empty - type one, or esc to go back");
          return true;
        }
        const suggested = dialog.toriel?.grants?.[0]?.pattern;
        if (suggested !== undefined && !coversPattern(reason, suggested)) {
          this.h.notify(`"${reason}" does not cover ${JSON.stringify(suggested)}, so this prompt would come straight back - widen it, or esc to go back`);
          return true;
        }
        panel.edit(null);
        this.answerWithGrant(session, view, dialog, row.for, reason);
        return true;
      }
      view.pendingReason = reason ? { text: reason, at: Date.now() } : undefined;
      panel.edit(null);
      this.h.send({
        type: "ui_response",
        session,
        response: { type: "extension_ui_response", id: dialog.id, value: answerValue(dialog, value) },
      });
      view.dialog = undefined;
    } else if (matchesKey(data, Key.backspace)) {
      panel.erase();
    } else if (matchesKey(data, Key.delete)) {
      panel.erase(true);
    } else if (matchesKey(data, Key.left)) {
      panel.moveCursor(-1);
    } else if (matchesKey(data, Key.right)) {
      panel.moveCursor(1);
    } else if (matchesKey(data, Key.home)) {
      panel.moveCursor(Number.NEGATIVE_INFINITY);
    } else if (matchesKey(data, Key.end)) {
      panel.moveCursor(Number.POSITIVE_INFINITY);
    } else if (data.length > 0 && !/[\x00-\x1f\x7f]/.test(data) && !data.startsWith("\x1b")) {
      panel.insert(data);
    }
    this.h.renderChrome();
    return true;
  }

  submit(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return;
    }
    if (trimmed.startsWith("/")) {
      if (this.commands.run(trimmed)) {
        return;
      }
      // not toriel's: pi's skills, templates and extension commands go on to pi, anything else is refused (the line stays in the box)
      const verdict = checkSlash(trimmed, SESSION_COMMANDS.map((c) => c.name), this.h.piCommands?.map((c) => c.name));
      if (!verdict.send) {
        this.h.notify(verdict.message);
        return;
      }
    }
    if (trimmed.startsWith("!")) {
      void this.bang(trimmed);
      return;
    }
    void this.prompt(trimmed);
  }

  /** Put `text` back in the box after a failed send, unless the user has already typed something new (then it stays reachable with up-arrow). */
  private giveBack(text: string): void {
    if (this.h.editor.getText().trim() === "") {
      this.h.editor.setText(text);
    } else {
      this.h.editor.addToHistory(text);
      this.h.notify("not sent - it is in the up-arrow history");
    }
  }

  /**
   * `!command`: the daemon runs it in the session's directory and tells the
   * agent the result at once (see local-command.ts); the command block appears
   * in the transcript when that message does. `!!` (output hidden from the
   * agent) is not offered.
   */
  private async bang(line: string): Promise<void> {
    const command = line.slice(1).trim();
    if (line.startsWith("!!")) {
      this.h.notify("!! is not supported - use ! (the agent sees the output)");
      return;
    }
    if (!this.h.viewing || !command) {
      this.h.notify("!<command> runs a shell command here and shows its output to the agent");
      return;
    }
    // a sleeping session is started first (no message needed), like /model or /compact do
    this.h.editor.setText("");
    const meta = await this.commands.liveMeta();
    if (!meta) {
      this.giveBack(line); // not started: keep the line so it can be retried
      return;
    }
    if (meta.attachedElsewhere || !meta.attachedToYou) {
      this.h.notify("view-only: this session is attached in another controller");
      return;
    }
    this.h.notify(`running: ${command} (esc stops it)`);
    this.bangSession = meta.id;
    try {
      await this.h.request({ type: "bash", session: meta.id, command }, BANG_TIMEOUT_MS);
      this.h.notify("");
    } catch (err) {
      this.h.notify(`!${command}: ${errText(err)}`);
    } finally {
      this.bangSession = undefined;
      this.h.renderChrome();
    }
  }

  /** /adopt the given session file, then deliver `text` to the fork once
   * entered. The prompt replays from pendingPrompt if the session metadata
   * has not arrived yet. */
  private async adoptAndPrompt(key: string, cwd: string, text: string): Promise<void> {
    try {
      const data = (await this.h.request({ type: "adopt", path: key, cwd })) as {
        sessionId?: number;
      };
      if (typeof data?.sessionId !== "number") {
        throw new Error("no session id");
      }
      const meta = this.h.sessions.get(data.sessionId);
      if (meta) {
        this.h.viewing = this.h.keyFor(meta);
        await this.prompt(text);
      } else {
        this.h.pendingEnterId = data.sessionId;
        this.h.pendingPrompt = text;
      }
    } catch (err) {
      this.h.notify(`fork failed: ${errText(err)}`);
      this.h.editor.setText(text);
    }
  }

  /**
   * Send `text` to the viewed session. False when it was not sent (the reason is
   * on screen, and the text is back in the box when the user should retry it).
   */
  async prompt(text: string): Promise<boolean> {
    const key = this.h.viewing;
    if (!key) {
      return false;
    }
    const meta = this.h.metaForPath(key);
    const blocked = this.blockedByOtherWriter(key, meta, text);
    if (blocked !== undefined) {
      return blocked;
    }
    const out = this.outgoing(text, meta);
    if (!out) {
      return false;
    }
    // A session with no live child starts on its first prompt, which takes seconds and answers
    // only then. Another enter meanwhile would be a second delivery (or fail on "spawn in
    // progress" and retract the first one's echo), so one prompt per file is in flight at a time.
    const starting = !meta;
    if (starting && !this.claimStart(key, out)) {
      return false;
    }
    try {
      const sent = meta ? await this.sendToLive(key, meta, out) : await this.sendToSleeping(key, out, text);
      if (!sent) {
        return false;
      }
      this.h.editor.addToHistory(out.message);
      // starting a sleeping session takes seconds: only clear the box if it still holds what was sent,
      // not something typed meanwhile
      if (this.h.editor.getText() === text) {
        this.h.editor.setText("");
      }
      return true;
    } catch (err) {
      this.h.dropEcho(key, out.sent);
      this.h.notify(`prompt failed: ${errText(err)}`);
      // give the images back, under fresh markers, so the message can be sent again
      this.giveBack([out.message, ...out.images.map((image) => this.h.attachments.put(image))].join(" "));
      return false;
    } finally {
      if (starting) {
        this.startingPrompts.delete(key);
      }
    }
  }

  /**
   * Another controller or a plain pi process has the session. Returns what `prompt`
   * should return, or undefined when nothing stands in the way.
   */
  private blockedByOtherWriter(key: string, meta: SessionMeta | undefined, text: string): boolean | undefined {
    if (meta?.attachedElsewhere) {
      this.h.notify("view-only: this session is attached in another controller");
      return false;
    }
    if (meta?.externallyLive && meta.active) {
      // double-open: toriel owns a live child AND a plain pi has the same
      // file open - forking cannot help, two writers would diverge
      this.h.notify("open in both toriel and another pi - close one before prompting here");
      this.h.editor.setText(text);
      return false;
    }
    if (meta?.externallyLive) {
      if (this.armedFork !== key) {
        this.armedFork = key;
        this.h.notify(
          "live in another pi - continuing here FORKS the conversation (pi keeps its copy). enter again to fork and continue here, esc to cancel",
        );
        this.h.editor.setText(text);
        return false;
      }
      this.armedFork = null;
      void this.adoptAndPrompt(key, meta.cwd || path.dirname(key), text);
      return true;
    }
    return undefined;
  }

  /** What goes to the daemon for `text`: pasted images ride with the message, and the markers that stood for them leave the text. */
  private outgoing(text: string, meta: SessionMeta | undefined): Outgoing | undefined {
    const { text: message, images } = text.startsWith("/") ? { text, images: [] } : this.h.attachments.take(text);
    if (images.length > 0 && meta?.acceptsImages === false) {
      this.h.notify(`${meta.model.split("/").pop()} does not take images - delete the [image] marker or switch model (/model)`);
      this.h.editor.setText(text);
      return undefined;
    }
    return {
      message,
      images,
      sent: message || (images.length > 0 ? "(see the attached image)" : message),
      // Show the prompt now rather than when pi echoes it back. Slash lines may be handled by an
      // extension without ever becoming a message, and a prompt sent mid-run is shown in the queue strip.
      echo: !text.startsWith("/") && !meta?.streaming,
    };
  }

  /** Take the one in-flight slot for a sleeping session's file; false (with a notice) when it is taken. */
  private claimStart(key: string, out: Outgoing): boolean {
    if (!this.startingPrompts.has(key)) {
      this.startingPrompts.set(key, out.sent);
      return true;
    }
    if (this.startingPrompts.get(key) === out.sent) {
      this.h.notify("already sending that - the session is still starting");
    } else {
      this.giveBack([out.message, ...out.images.map((image) => this.h.attachments.put(image))].join(" "));
      this.h.notify("the session is still starting - your new text is kept, send it in a moment");
    }
    return false;
  }

  private async sendToLive(key: string, meta: SessionMeta, out: Outgoing): Promise<boolean> {
    if (out.echo) {
      this.h.echoPrompt(key, out.sent, out.images);
    }
    await this.h.request({ type: "prompt", session: meta.id, message: out.sent, images: out.images.length > 0 ? out.images : undefined });
    return true;
  }

  /** Start a session that has only a file; false when it was not sent (no file, or the fork confirmation is pending). */
  private async sendToSleeping(key: string, out: Outgoing, text: string): Promise<boolean> {
    const info = this.h.local.get(key);
    if (!key.startsWith("/") || !info) {
      // a session deleted while it was on screen (a finished subagent swept, a /delete elsewhere) has neither a daemon entry nor a file
      const gone = key.startsWith("/") ? !fs.existsSync(key) : key.startsWith("daemon:");
      this.h.notify(
        gone
          ? "that session was deleted - /restore brings it back from the trash (nothing was sent)"
          : "cannot start this session (no session file)",
      );
      return false;
    }
    // The file may be open in an external (non-daemon) pi process -
    // undetectable from here, so the daemon decides: it refuses files a
    // presence-covered pi holds, and flags brand-new recently-modified
    // files (a fork risk) with a confirmFork response instead of
    // touching them. Files it has handled before are toriel's own and
    // just continue, whatever their mtime (a resume makes them look
    // freshly written).
    // Echo before sending: the confirmed request can take seconds (it
    // returns after the child spawns), and if pi's own user message
    // lands in that window there is no pending echo to consume, so the
    // text would render twice. dropEcho retracts the echo on a refusal.
    if (out.echo) {
      this.h.echoPrompt(key, out.sent, out.images);
    }
    const data = (await this.h.request({
      type: "prompt",
      sessionFile: key,
      cwd: info.cwd || path.dirname(key),
      message: out.sent,
      images: out.images.length > 0 ? out.images : undefined,
      confirmFork: this.armedFork === key,
    })) as { confirmFork?: boolean; ageMs?: number } | undefined;
    if (data?.confirmFork) {
      this.h.dropEcho(key, out.sent);
      this.armedFork = key;
      this.h.notify(
        `changed ${fmtAge(data.ageMs ?? 0)} ago - may be open in another pi; enter again to continue here (the conversation may fork), esc to cancel`,
      );
      this.h.editor.setText(text);
      return false;
    }
    this.armedFork = null;
    // the request above already delivered; after a confirmed fork it only
    // returns once the child is up, so the box is cleared late (by prompt) rather
    // than sending again
    return true;
  }
}
