// The chat bridge (tickets 271-274): published sessions get a channel each in one room group; the transcript's assistant text, a count of
// tools run and the dialogs are posted there, and what the allowed user writes or reacts becomes a prompt or a dialog answer. The daemon
// stays the owner of every session: this is a controller like the desktop one, plus `observe_dialogs`.
//
// Everything runs on one queue, so the order the daemon and the chat server speak in is the order things happen here.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DaemonMessage, SessionMeta } from "../shared.ts";
import { DIALOG_METHODS } from "../config.ts";
import { optionsNumberedAlready } from "../dialogs.ts";
import type { ChattoSettings } from "../settings.ts";
import { type ChatAdapter, type ChatEvent, type ChatMessage, MAX_BODY } from "./adapter.ts";
import type { DaemonPort } from "./daemon-client.ts";

interface ChannelRecord {
  roomId: string;
  rootId?: string;
  /** The channel's name as last set, to notice a session rename. */
  name: string;
  closed: boolean;
}

interface BridgeState {
  /** Session UUID -> its channel. Kept after a close, so publishing again reuses the channel. */
  channels: Record<string, ChannelRecord>;
  inboxRoomId?: string;
}

interface OpenDialog {
  session: number;
  sessionId: string;
  roomId: string;
  messageId: string;
  request: { id: string; method: string; title?: string; message?: string; options?: string[] };
  body: string;
  emojis: string[];
  /** The reaction the user chose, kept when the others are cleared. */
  chosen?: string;
}

export interface BridgeDeps {
  adapter: ChatAdapter;
  daemon: DaemonPort;
  settings: ChattoSettings;
  stateFile: string;
  log: (text: string) => void;
}

/**
 * The link from a channel to its session lives in the channel itself: its description ends with `[toriel:<session uuid>]`, so the
 * bridge can tell which channel is whose from the chat server alone (after its own state file was lost, say) and notice a channel
 * whose tag disagrees with what it believes. The description is the one place every chat client shows and the bot can always set.
 */
export const sessionTag = (sessionId: string): string => `[toriel:${sessionId}]`;
export function sessionFromDescription(description: string | undefined): string | undefined {
  return /\[toriel:([\w-]+)\]\s*$/.exec(description ?? "")?.[1];
}

/** `my-toriel-room` -> `My Toriel Room` (a session name from a channel name). */
export function sessionNameFromChannel(channel: string): string {
  return channel
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** A session name as a channel name: lowercase words joined by hyphens, at most 30 characters (Chatto's limit); never empty. */
export function channelNameFor(name: string, fallback: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
    .replace(/-+$/g, "");
  return base || fallback;
}

/** Split text into posts of at most `max` characters, at line ends where it can. */
export function splitBody(text: string, max = MAX_BODY): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) {
      cut = max;
    }
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.length > 0 || out.length === 0) {
    out.push(rest);
  }
  return out;
}

const NUMBER_EMOJI = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const TYPING_EVERY_MS = 3000;

/** The text of a pi message: the text blocks of an assistant message, or a user message's string. */
export function messageText(message: { content?: unknown } | undefined): string {
  const c = message?.content;
  if (typeof c === "string") {
    return c;
  }
  if (Array.isArray(c)) {
    return c
      .filter((b): b is { type: string; text: string } => typeof b === "object" && b !== null && (b as { type?: string }).type === "text" && typeof (b as { text?: unknown }).text === "string")
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

export class Bridge {
  private readonly adapter: ChatAdapter;
  private readonly daemon: DaemonPort;
  private readonly settings: ChattoSettings;
  private readonly stateFile: string;
  private readonly log: (text: string) => void;
  private state: BridgeState = { channels: {} };
  private groupId = "";
  private metas: SessionMeta[] = [];
  private chain: Promise<void> = Promise.resolve();
  private readonly dialogs = new Map<string, OpenDialog>(); // by dialog id
  private readonly typingTimers = new Map<string, NodeJS.Timeout>(); // by room id
  private readonly toolsRun = new Map<number, number>(); // by session number, since the last post
  /** Prompts this bridge sent, so the user message pi echoes back is not posted a second time. */
  private readonly echoes: string[] = [];
  /** A session started from chat that has no UUID yet: publish it (and bind a channel, when one exists) once it has. */
  private readonly awaiting = new Map<number, { roomId?: string; channelName?: string; inbox?: boolean }>();
  /** Sessions whose channel was bound before the daemon listed them as published. */
  private readonly binding = new Set<string>();
  /** Channels the user made that wait for a first message before a session exists. */
  private readonly emptyChannels = new Map<string, string>(); // room id -> channel name

  constructor(deps: BridgeDeps) {
    this.adapter = deps.adapter;
    this.daemon = deps.daemon;
    this.settings = deps.settings;
    this.stateFile = deps.stateFile;
    this.log = deps.log;
  }

  private run(label: string, fn: () => Promise<void>): void {
    this.chain = this.chain.then(fn).catch((err: unknown) => this.log(`${label} failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** Resolves when everything queued so far has run (tests). */
  idle(): Promise<void> {
    return this.chain;
  }

  async start(): Promise<void> {
    this.load();
    await this.adapter.connect();
    const group = await this.adapter.findGroup(this.settings.group);
    if (!group) {
      throw new Error(`the room group "${this.settings.group}" does not exist, or the bot cannot see it`);
    }
    this.groupId = group;
    await this.ensureInbox();
    // channels left open by a bridge that did not get to clean up (a crash, a kill) are cleared: the published sessions reopen theirs
    await this.reconcile();
    await this.closeAll("toriel was restarted; this channel reopens when the session is published and listed again.");
    this.daemon.onMessage((msg) => this.run(`daemon ${msg.type}`, () => this.onDaemon(msg)));
    this.adapter.onEvent((e) => this.run(`chat ${e.type}`, () => this.onChat(e)));
    await this.daemon.request({ type: "observe_dialogs" });
    await this.daemon.request({ type: "chat_status", up: true });
    this.log(`bridge up: group ${this.settings.group}, ${Object.keys(this.state.channels).length} channel(s) known`);
  }

  /** Rebuild and check the session-to-channel map from the tags in the channels' descriptions. */
  private async reconcile(): Promise<void> {
    const rooms = await this.adapter.listRooms(this.groupId);
    for (const room of rooms) {
      const uuid = sessionFromDescription(room.description);
      if (!uuid) {
        continue;
      }
      const have = this.state.channels[uuid];
      if (!have) {
        this.state.channels[uuid] = { roomId: room.id, name: room.name, closed: false };
        this.log(`channel ${room.name} adopted for session ${uuid} from its tag`);
      } else if (have.roomId !== room.id) {
        this.log(`channel ${room.name} is tagged for session ${uuid}, which the bridge keeps in another channel: left alone`);
      }
    }
    for (const [uuid, rec] of Object.entries(this.state.channels)) {
      const room = rooms.find((r) => r.id === rec.roomId);
      const tagged = room ? sessionFromDescription(room.description) : undefined;
      if (tagged !== undefined && tagged !== uuid) {
        this.log(`channel ${rec.name} is tagged for session ${tagged}, not ${uuid}: the bridge forgets that link`);
        delete this.state.channels[uuid];
      }
    }
    this.save();
  }

  /** Close (edit and archive) every open channel; they reopen when their sessions are listed as published again. */
  private async closeAll(why: string): Promise<void> {
    for (const [sessionId, rec] of Object.entries(this.state.channels)) {
      if (!rec.closed) {
        await this.closeChannel(sessionId, rec, undefined, why).catch((err: unknown) => this.log(`could not close channel ${rec.name}: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
  }

  /** The daemon is stopping, or this process was told to: clear the channels, then say so. Resolves when done. */
  async shutdown(): Promise<void> {
    for (const t of this.typingTimers.values()) {
      clearInterval(t);
    }
    this.typingTimers.clear();
    await this.chain; // what was queued still runs, in order
    await this.closeAll("toriel stopped; this channel reopens when it is back and the session is published.");
    await this.daemon.request({ type: "chat_status", up: false }).catch(() => undefined);
  }

  private load(): void {
    try {
      this.state = { channels: {}, ...(JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as Partial<BridgeState>) };
    } catch {
      this.state = { channels: {} };
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const tmp = `${this.stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 1));
    fs.renameSync(tmp, this.stateFile);
  }

  private async ensureInbox(): Promise<void> {
    const rooms = await this.adapter.listRooms(this.groupId);
    const found = rooms.find((r) => r.name.toLowerCase() === this.settings.inboxChannel.toLowerCase());
    const room = found ?? (await this.adapter.createRoom(this.groupId, this.settings.inboxChannel, "Toriel: start a session by writing here; announcements"));
    if (!found) {
      this.log(`created the inbox channel ${room.name}`);
      await this.addUsers(room.id);
    }
    await this.adapter.joinRoom(room.id).catch(() => undefined);
    this.state.inboxRoomId = room.id;
    this.save();
  }

  // ---- from the daemon ----

  private metaOf(session: number): SessionMeta | undefined {
    return this.metas.find((m) => m.id === session);
  }

  private channelOf(meta: SessionMeta | undefined): ChannelRecord | undefined {
    const rec = meta?.sessionId ? this.state.channels[meta.sessionId] : undefined;
    return rec && !rec.closed ? rec : undefined;
  }

  private async onDaemon(msg: DaemonMessage): Promise<void> {
    switch (msg.type) {
      case "sessions":
        this.metas = msg.sessions;
        await this.syncSessions();
        return;
      case "event":
        await this.onPiEvent(msg.session, msg.event);
        return;
      case "ui_request":
        await this.onDialog(msg.session, msg.request);
        return;
      case "ui_resolved":
        await this.onResolved(msg.id, msg.by, msg.source);
        return;
      default:
        return;
    }
  }

  /** Make the channels match the published sessions; bind sessions started from chat to their first UUID. */
  private async syncSessions(): Promise<void> {
    for (const [num, want] of [...this.awaiting]) {
      const meta = this.metaOf(num);
      if (meta?.sessionId) {
        this.awaiting.delete(num);
        if (want.roomId) {
          // the user's own channel becomes this session's; it is not "unpublished" just because the daemon has not caught up yet
          this.state.channels[meta.sessionId] = { roomId: want.roomId, name: want.channelName ?? meta.sessionName ?? "", closed: false };
          this.binding.add(meta.sessionId);
          this.save();
        }
        await this.daemon.request({ type: "publish", sessionId: meta.sessionId, on: true });
        if (want.inbox) {
          this.inboxAnnounce.add(meta.sessionId);
        }
      }
    }
    for (const meta of this.metas) {
      if (!meta.sessionId) {
        continue;
      }
      const rec = this.state.channels[meta.sessionId];
      if (meta.published) {
        this.binding.delete(meta.sessionId);
        if (!rec || rec.closed || !rec.rootId) {
          await this.openChannel(meta);
        } else {
          await this.refreshChannel(meta, rec);
        }
      } else if (rec && !rec.closed && !this.binding.has(meta.sessionId)) {
        await this.closeChannel(meta.sessionId, rec, meta);
      }
    }
  }

  private readonly inboxAnnounce = new Set<string>();
  private readonly lastLabel = new Map<string, string>();

  private uniqueChannelName(wanted: string, own?: string): Promise<string> {
    return this.adapter.listRooms(this.groupId).then((rooms) => {
      const taken = new Set(rooms.filter((r) => r.id !== own).map((r) => r.name.toLowerCase()));
      for (const rec of Object.values(this.state.channels)) {
        if (rec.roomId !== own) {
          taken.add(rec.name.toLowerCase());
        }
      }
      let name = wanted;
      for (let n = 2; taken.has(name.toLowerCase()); n++) {
        name = `${wanted.slice(0, 30 - String(n).length - 1)}-${n}`;
      }
      return name;
    });
  }

  private rootText(meta: SessionMeta, name: string): string {
    return `**${meta.sessionName ?? name}**\n\`${meta.cwd}\` · ${meta.model}\nWrite here to message this session. Dialogs show up with reactions to click.\n_session ${meta.sessionId}_`;
  }

  /** Put the configured users (default: the allowed user) into a channel the bridge just made; a refusal is logged, not fatal. */
  private async addUsers(roomId: string): Promise<void> {
    for (const user of this.settings.addUsers) {
      await this.adapter.addMember(roomId, user).catch((err: unknown) => {
        const why = err instanceof Error ? err.message : String(err);
        if (!/already/i.test(why)) {
          this.log(`could not add user ${user} to a channel: ${why}`);
        }
      });
    }
  }

  private async openChannel(meta: SessionMeta): Promise<void> {
    const sessionId = meta.sessionId as string;
    let rec = this.state.channels[sessionId];
    const wanted = channelNameFor(meta.sessionName ?? "", `session-${meta.id}`);
    if (rec) {
      if (rec.closed) {
        await this.adapter.unarchiveRoom(rec.roomId);
      }
      rec.closed = false;
      await this.addUsers(rec.roomId); // a channel from before addUsers existed, or one the user left, has the users again
    } else {
      const name = await this.uniqueChannelName(wanted);
      const room = await this.adapter.createRoom(this.groupId, name, `starting ${sessionTag(sessionId)}`);
      rec = { roomId: room.id, name, closed: false };
      this.state.channels[sessionId] = rec;
      await this.addUsers(room.id);
    }
    const rootId = await this.adapter.post(rec.roomId, this.rootText(meta, rec.name));
    rec.rootId = rootId;
    this.save();
    await this.adapter.pin(rec.roomId, rootId).catch(() => undefined);
    this.log(`channel ${rec.name} opened for session ${meta.id}`);
    if (this.inboxAnnounce.delete(sessionId) && this.state.inboxRoomId) {
      await this.adapter.post(this.state.inboxRoomId, `Started **${meta.sessionName ?? rec.name}** in its own channel: #${rec.name}`);
    }
    await this.refreshChannel(meta, rec);
  }

  private stateLabel(meta: SessionMeta): string {
    if (meta.pendingDialog) {
      return "waiting for you";
    }
    if (!meta.active) {
      return "asleep";
    }
    return meta.streaming ? "working" : "idle";
  }

  /** Keep the channel's name and description in step with the session. */
  private async refreshChannel(meta: SessionMeta, rec: ChannelRecord): Promise<void> {
    const sessionId = meta.sessionId as string;
    if (meta.sessionName) {
      const wanted = channelNameFor(meta.sessionName, rec.name);
      if (wanted !== rec.name && !rec.name.startsWith(`${wanted}-`)) {
        const name = await this.uniqueChannelName(wanted, rec.roomId);
        if (name !== rec.name) {
          await this.adapter.renameRoom(rec.roomId, name);
          rec.name = name;
          this.save();
        }
      }
    }
    const label = this.stateLabel(meta);
    if (this.lastLabel.get(sessionId) !== label) {
      this.lastLabel.set(sessionId, label);
      await this.adapter.setDescription(rec.roomId, `${label} · ${meta.cwd} · ${meta.model} ${sessionTag(sessionId)}`).catch(() => undefined);
    }
  }

  private async closeChannel(sessionId: string, rec: ChannelRecord, meta: SessionMeta | undefined, why = "This session is no longer published. /publish in toriel shows it again."): Promise<void> {
    this.stopTyping(rec.roomId);
    rec.closed = true;
    this.save();
    this.lastLabel.delete(sessionId);
    if (rec.rootId) {
      await this.adapter.edit(rec.roomId, rec.rootId, `**closed** · ${meta?.sessionName ?? rec.name}\n${why}`).catch(() => undefined);
    }
    await this.adapter.setDescription(rec.roomId, `closed ${sessionTag(sessionId)}`).catch(() => undefined);
    await this.adapter.archiveRoom(rec.roomId);
    this.log(`channel ${rec.name} closed`);
  }

  // ---- session output ----

  private startTyping(roomId: string): void {
    if (this.typingTimers.has(roomId)) {
      return;
    }
    const tick = (): void => void this.adapter.typing(roomId).catch(() => undefined);
    tick();
    const t = setInterval(tick, TYPING_EVERY_MS);
    t.unref();
    this.typingTimers.set(roomId, t);
  }

  private stopTyping(roomId: string): void {
    const t = this.typingTimers.get(roomId);
    if (t) {
      clearInterval(t);
      this.typingTimers.delete(roomId);
    }
  }

  private async postLong(roomId: string, text: string): Promise<void> {
    for (const part of splitBody(text)) {
      await this.adapter.post(roomId, part);
    }
  }

  private async onPiEvent(session: number, event: Record<string, unknown>): Promise<void> {
    const meta = this.metaOf(session);
    const rec = this.channelOf(meta);
    if (!meta || !rec) {
      return;
    }
    const type = event.type as string;
    if (type === "agent_start") {
      this.startTyping(rec.roomId);
    } else if (type === "tool_execution_end") {
      this.toolsRun.set(session, (this.toolsRun.get(session) ?? 0) + 1);
    } else if (type === "message_end") {
      const message = event.message as { role?: string; content?: unknown; errorMessage?: string } | undefined;
      const text = messageText(message).trim();
      if (message?.role === "assistant") {
        const tools = this.toolsRun.get(session) ?? 0;
        const parts = [text, message.errorMessage ? `⚠ ${message.errorMessage}` : ""].filter(Boolean);
        if (parts.length > 0) {
          if (tools > 0) {
            parts.push(`_${tools} tool${tools === 1 ? "" : "s"} ran_`);
            this.toolsRun.set(session, 0);
          }
          await this.postLong(rec.roomId, parts.join("\n\n"));
        }
      } else if (message?.role === "user" && text) {
        const echo = this.echoes.indexOf(text);
        if (echo >= 0) {
          this.echoes.splice(echo, 1);
        } else if (!text.startsWith("[")) {
          await this.postLong(rec.roomId, `> **typed in toriel:** ${text.length > 500 ? `${text.slice(0, 500)}…` : text}`);
        }
      }
    } else if (type === "agent_settled") {
      this.stopTyping(rec.roomId);
      const tools = this.toolsRun.get(session) ?? 0;
      if (tools > 0) {
        this.toolsRun.set(session, 0);
        await this.adapter.post(rec.roomId, `_${tools} tool${tools === 1 ? "" : "s"} ran_`);
      }
    }
  }

  // ---- dialogs ----

  private async onDialog(session: number, request: Record<string, unknown>): Promise<void> {
    const meta = this.metaOf(session);
    const rec = this.channelOf(meta);
    const method = String(request.method);
    if (!meta?.sessionId || !rec || !DIALOG_METHODS.has(method) || typeof request.id !== "string") {
      return;
    }
    const req = request as OpenDialog["request"];
    let body: string;
    let emojis: string[];
    const title = (req.title ?? req.message ?? "").trim();
    if (method === "confirm") {
      body = `**${meta.sessionName ?? rec.name} asks:**\n${title}${req.message && req.title ? `\n${req.message}` : ""}\n\n✅ yes · ❌ no`;
      emojis = ["white_check_mark", "x"];
    } else if (method === "select") {
      const options = req.options ?? [];
      // an extension that numbered its own rows (ask_user_question) would show every number twice (chat renders a list's numbers itself)
      const lines = optionsNumberedAlready(options) ? options : options.map((o, i) => `${i + 1}. ${o}`);
      body = `**${meta.sessionName ?? rec.name} asks:**\n\`\`\`\n${title}\n\`\`\`\n${lines.join("\n")}\n\nReact with the number, or write it.`;
      emojis = NUMBER_EMOJI.slice(0, Math.min(options.length, NUMBER_EMOJI.length));
    } else {
      body = `**${meta.sessionName ?? rec.name} asks:**\n${title}\n\nWrite your answer in the channel (\`cancel\` to dismiss).`;
      emojis = [];
    }
    const messageId = await this.adapter.post(rec.roomId, body);
    const dialog: OpenDialog = { session, sessionId: meta.sessionId, roomId: rec.roomId, messageId, request: req, body, emojis };
    this.dialogs.set(req.id, dialog);
    for (const e of emojis) {
      if (!this.dialogs.has(req.id)) {
        break; // answered while the choices were still going on
      }
      await this.adapter.react(rec.roomId, messageId, e).catch(() => undefined);
    }
  }

  private async onResolved(id: string, by: string, source: string | undefined): Promise<void> {
    const d = this.dialogs.get(id);
    if (!d) {
      return;
    }
    this.dialogs.delete(id);
    const outcome = by === "user" ? (d.chosen ? `answered (${d.chosen})` : `answered${source ? ` from ${source}` : " in toriel"}`) : by === "expired" ? "timed out" : by === "deny-after" ? "denied: nobody answered in time" : "no longer asked";
    await this.adapter.edit(d.roomId, d.messageId, `${d.body}\n\n**→ ${outcome}**`).catch(() => undefined);
    for (const e of d.emojis) {
      if (e !== d.chosen) {
        await this.adapter.unreact(d.roomId, d.messageId, e).catch(() => undefined);
      }
    }
  }

  private dialogFor(roomId: string): OpenDialog | undefined {
    return [...this.dialogs.values()].reverse().find((d) => d.roomId === roomId);
  }

  private async answer(d: OpenDialog, fields: Record<string, unknown>, label: string): Promise<void> {
    d.chosen = label;
    try {
      await this.daemon.request({ type: "ui_response", session: d.session, source: "chatto", response: { type: "extension_ui_response", id: d.request.id, ...fields } });
    } catch (err) {
      this.log(`answer for dialog ${d.request.id} not taken: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Answer from a reaction or a typed reply; true when the dialog took it. */
  private async answerFrom(d: OpenDialog, choice: { emoji?: string; text?: string }): Promise<boolean> {
    const { method, options } = d.request;
    if (method === "confirm") {
      if (choice.emoji === "white_check_mark" || /^(y|yes)$/i.test(choice.text ?? "")) {
        await this.answer(d, { confirmed: true }, "yes");
        return true;
      }
      if (choice.emoji === "x" || /^(n|no)$/i.test(choice.text ?? "")) {
        await this.answer(d, { confirmed: false }, "no");
        return true;
      }
      return false;
    }
    if (method === "select") {
      const n = choice.emoji ? NUMBER_EMOJI.indexOf(choice.emoji) + 1 : /^\d+$/.test((choice.text ?? "").trim()) ? Number(choice.text) : 0;
      const option = n > 0 ? options?.[n - 1] : undefined;
      if (option === undefined) {
        return false;
      }
      await this.answer(d, { value: option }, choice.emoji ?? String(n));
      return true;
    }
    if (choice.text === undefined) {
      return false;
    }
    if (/^cancel$/i.test(choice.text.trim())) {
      await this.answer(d, { cancelled: true }, "cancelled");
    } else {
      await this.answer(d, { value: choice.text }, "answered");
    }
    return true;
  }

  // ---- from chat ----

  private async onChat(e: ChatEvent): Promise<void> {
    if (e.type === "reaction") {
      if (!e.added || !this.settings.allowedUsers.includes(e.userId)) {
        return;
      }
      for (const d of this.dialogs.values()) {
        if (d.messageId === e.messageId && d.roomId === e.roomId) {
          await this.answerFrom(d, { emoji: e.emoji });
          return;
        }
      }
      return;
    }
    if (e.type === "room") {
      if (e.change === "created" && this.settings.allowedUsers.includes(e.by) && e.room.id !== this.state.inboxRoomId && !Object.values(this.state.channels).some((c) => c.roomId === e.room.id)) {
        this.emptyChannels.set(e.room.id, e.room.name);
        this.log(`channel ${e.room.name} made in chat: a session starts with its first message`);
        await this.adapter.joinRoom(e.room.id).catch(() => undefined);
      } else if (e.change === "renamed" && this.settings.allowedUsers.includes(e.by)) {
        await this.renamedInChat(e.room.id, e.room.name);
      }
      return;
    }
    await this.onMessage(e.message);
  }

  /** A channel the user renamed in chat renames its session (My Toriel Room from my-toriel-room); the channel then keeps the user's spelling until the session is renamed. */
  private async renamedInChat(roomId: string, channelName: string): Promise<void> {
    const entry = Object.entries(this.state.channels).find(([, c]) => c.roomId === roomId && !c.closed);
    const meta = entry ? this.metas.find((x) => x.sessionId === entry[0]) : undefined;
    if (!entry || !meta || entry[1].name === channelName) {
      return;
    }
    entry[1].name = channelName;
    this.save();
    const name = sessionNameFromChannel(channelName);
    if (name && name !== meta.sessionName) {
      await this.daemon.request({ type: "rename", session: meta.id, name });
      this.log(`session ${meta.id} renamed to ${name} from its channel`);
    }
  }

  private async onMessage(m: ChatMessage): Promise<void> {
    if (m.authorId === this.adapter.selfId) {
      return;
    }
    if (!this.settings.allowedUsers.includes(m.authorId)) {
      this.log(`ignored a message from user ${m.authorId}`); // the actor id only, never the content
      return;
    }
    const text = m.body.trim();
    if (!text && !m.attachments?.length) {
      return;
    }
    if (m.roomId === this.state.inboxRoomId) {
      await this.startSession(text, { inbox: true });
      return;
    }
    if (this.emptyChannels.has(m.roomId)) {
      const channelName = this.emptyChannels.get(m.roomId) ?? "";
      this.emptyChannels.delete(m.roomId);
      await this.startSession(text, { roomId: m.roomId, channelName, name: sessionNameFromChannel(channelName) });
      return;
    }
    const entry = Object.entries(this.state.channels).find(([, c]) => c.roomId === m.roomId && !c.closed);
    if (!entry) {
      return;
    }
    if (m.threadRootId) {
      await this.adapter.post(m.roomId, "I don't use threads: write in the channel itself and I will read it.", { replyTo: m.id });
      return;
    }
    const d = this.dialogFor(m.roomId);
    if (d && (await this.answerFrom(d, { text }))) {
      return;
    }
    const meta = this.metas.find((x) => x.sessionId === entry[0]);
    if (!meta) {
      await this.adapter.post(m.roomId, "toriel does not know this session right now (the daemon restarted?); open it in toriel once.", { replyTo: m.id });
      return;
    }
    await this.prompt(meta, text, m);
  }

  private async prompt(meta: SessionMeta, text: string, m: ChatMessage): Promise<void> {
    this.echoes.push(text);
    if (this.echoes.length > 20) {
      this.echoes.shift();
    }
    try {
      if (meta.active && !meta.dead) {
        await this.daemon.request({ type: "prompt", session: meta.id, message: text, source: "chatto" });
      } else if (meta.sessionFile) {
        await this.daemon.request({ type: "prompt", sessionFile: meta.sessionFile, cwd: meta.cwd, message: text, source: "chatto" });
      } else {
        throw new Error("the session has no file to resume");
      }
    } catch (err) {
      const at = this.echoes.indexOf(text);
      if (at >= 0) {
        this.echoes.splice(at, 1);
      }
      await this.adapter.post(m.roomId, `⚠ could not send that: ${err instanceof Error ? err.message : String(err)}`, { replyTo: m.id });
    }
  }

  /** A message in the inbox, or the first message in a channel the user made: start a session with it and publish it. */
  private async startSession(text: string, opts: { inbox?: boolean; roomId?: string; channelName?: string; name?: string }): Promise<void> {
    const cwd = this.settings.defaultCwd ? this.settings.defaultCwd.replace(/^~(?=\/|$)/, os.homedir()) : os.homedir();
    const spawned = (await this.daemon.request({ type: "spawn", cwd, ...(opts.name ? { name: opts.name } : {}), ...(this.settings.defaultModel ? { model: this.settings.defaultModel } : {}) })) as { sessionId: number };
    // a spawn attaches the spawning controller, which would lock the desktop out of the session: the bridge only watches and prompts
    await this.daemon.request({ type: "detach", session: spawned.sessionId }).catch(() => undefined);
    this.awaiting.set(spawned.sessionId, { roomId: opts.roomId, channelName: opts.channelName, inbox: opts.inbox });
    this.echoes.push(text);
    await this.daemon.request({ type: "prompt", session: spawned.sessionId, message: text, source: "chatto" });
    this.log(`session ${spawned.sessionId} started from chat`);
  }
}
