// An in-memory chat server and daemon for the bridge tests: no network, no real daemon.
import type { ChatAdapter, ChatEvent, ChatMessage, ChatRoom } from "../src/bridge/adapter.ts";
import type { DaemonPort } from "../src/bridge/daemon-client.ts";
import type { DaemonMessage, HistoryTurn, SessionMeta } from "../src/shared.ts"; 

export const BOT = "bot1";
export const RON = "ron1";

interface Post {
  id: string;
  roomId: string;
  /** Who wrote it (the bot's own posts, unless a test said otherwise). */
  author?: string;
  body: string;
  replyTo?: string;
  reactions: Set<string>;
}

export class FakeChat implements ChatAdapter {
  readonly selfId = BOT;
  rooms = new Map<string, ChatRoom & { description: string; members: boolean }>();
  posts: Post[] = [];
  pins: string[] = [];
  typings: string[] = [];
  groups = new Map<string, string>([["Toriel", "g1"]]);
  private listeners: Array<(e: ChatEvent) => void> = [];
  private seq = 0;

  async connect(): Promise<void> {}
  onEvent(l: (e: ChatEvent) => void): () => void {
    this.listeners.push(l);
    return () => undefined;
  }
  onStatus(): () => void {
    return () => undefined;
  }
  async findGroup(name: string): Promise<string | undefined> {
    return this.groups.get(name);
  }
  async listRooms(): Promise<ChatRoom[]> {
    return [...this.rooms.values()].filter((r) => !r.archived).map(({ id, name, archived, description }) => ({ id, name, archived, description }));
  }
  async createRoom(_group: string, name: string, description: string): Promise<ChatRoom> {
    if ([...this.rooms.values()].some((r) => r.name.toLowerCase() === name.toLowerCase())) {
      throw new Error("room name taken");
    }
    const id = `room${++this.seq}`;
    this.rooms.set(id, { id, name, archived: false, description, members: true });
    return { id, name, archived: false };
  }
  async joinRoom(id: string): Promise<void> {
    const r = this.rooms.get(id);
    if (r) {
      r.members = true;
    }
  }
  /** Who is in each room, for the tests that need a room's members (default: nobody). */
  memberIds = new Map<string, string[]>();
  async members(roomId: string): Promise<string[]> {
    return this.memberIds.get(roomId) ?? [];
  }
  added: Array<[string, string]> = [];
  async addMember(roomId: string, userId: string): Promise<void> {
    this.added.push([roomId, userId]);
  }
  async renameRoom(id: string, name: string): Promise<void> {
    (this.rooms.get(id) as ChatRoom).name = name;
  }
  async setDescription(id: string, description: string): Promise<void> {
    (this.rooms.get(id) as { description: string }).description = description;
  }
  async archiveRoom(id: string): Promise<void> {
    (this.rooms.get(id) as ChatRoom).archived = true;
  }
  async unarchiveRoom(id: string): Promise<void> {
    (this.rooms.get(id) as ChatRoom).archived = false;
  }
  async post(roomId: string, body: string, opts?: { replyTo?: string }): Promise<string> {
    const id = `m${++this.seq}`;
    this.posts.push({ id, roomId, body, replyTo: opts?.replyTo, reactions: new Set() });
    return id;
  }
  /** What the server has in each room that the bridge did not post: the user's messages, in order (see say()). */
  written: Array<{ id: string; roomId: string; authorId: string; body: string; threadRootId?: string; at: number }> = [];
  /** Tests that make the server miss events (a connection that dropped) turn this off: say() then records the message without delivering it. */
  deliver = true;
  async recentMessages(roomId: string, limit: number): Promise<ChatMessage[]> {
    this.fetches++;
    if (this.failFetch) {
      throw new Error("timeline unavailable");
    }
    // the timeline interleaves the bot's posts with what was written, in the order they happened (the sequence number in their ids)
    const mine = this.posts.filter((p) => p.roomId === roomId).map((p) => ({ id: p.id, roomId, authorId: BOT, body: p.body, order: Number(p.id.slice(1)) }));
    const theirs = this.written.filter((w) => w.roomId === roomId).map((w) => ({ id: w.id, roomId, authorId: w.authorId, body: w.body, threadRootId: w.threadRootId, order: Number(w.id.slice(1)) }));
    return [...mine, ...theirs].sort((a, b) => a.order - b.order).map(({ order: _o, ...m }) => m).slice(-limit);
  }
  fetches = 0;
  failFetch = false;
  async edit(_roomId: string, id: string, body: string): Promise<void> {
    (this.posts.find((p) => p.id === id) as Post).body = body;
  }
  async pin(_roomId: string, id: string): Promise<void> {
    this.pins.push(id);
  }
  async react(_roomId: string, id: string, emoji: string): Promise<void> {
    (this.posts.find((p) => p.id === id) as Post).reactions.add(emoji);
  }
  async unreact(_roomId: string, id: string, emoji: string): Promise<void> {
    (this.posts.find((p) => p.id === id) as Post).reactions.delete(emoji);
  }
  async typing(roomId: string): Promise<void> {
    this.typings.push(roomId);
  }
  close(): void {}

  // what the tests do as the user
  emit(e: ChatEvent): void {
    for (const l of this.listeners) {
      l(e);
    }
  }
  say(roomId: string, body: string, extra: { userId?: string; threadRootId?: string; inReplyTo?: string } = {}): string {
    const id = `u${++this.seq}`;
    this.written.push({ id, roomId, authorId: extra.userId ?? RON, body, threadRootId: extra.threadRootId, at: Date.now() });
    if (this.deliver) {
      this.emit({ type: "message", message: { id, roomId, authorId: extra.userId ?? RON, body, threadRootId: extra.threadRootId, inReplyTo: extra.inReplyTo } });
    }
    return id;
  }
  react$(roomId: string, messageId: string, emoji: string, userId = RON): void {
    this.emit({ type: "reaction", roomId, messageId, userId, emoji, added: true });
  }
  roomByName(name: string): (ChatRoom & { description: string }) | undefined {
    return [...this.rooms.values()].find((r) => r.name === name);
  }
  postsIn(roomId: string): Post[] {
    return this.posts.filter((p) => p.roomId === roomId);
  }
}

/** A daemon the bridge can talk to: records the commands, answers a few, and lets the test push messages. */
export class FakeDaemon implements DaemonPort {
  requests: Array<Record<string, unknown>> = [];
  failures = new Map<string, string>();
  private listeners: Array<(m: DaemonMessage) => void> = [];
  nextSession = 100;
  /** What read_history answers, by session number (default: nothing, as a daemon with an empty conversation would). */
  histories = new Map<number, { turns: HistoryTurn[]; total: number }>();

  async request(cmd: Record<string, unknown>): Promise<unknown> {
    this.requests.push(cmd);
    const fail = this.failures.get(String(cmd.type));
    if (fail) {
      throw new Error(fail);
    }
    if (cmd.type === "spawn") {
      return { sessionId: this.nextSession++ };
    }
    if (cmd.type === "read_history") {
      return this.histories.get(Number(cmd.session));
    }
    return undefined;
  }
  onMessage(l: (m: DaemonMessage) => void): void {
    this.listeners.push(l);
  }
  onClose(): void {}
  close(): void {}

  push(m: DaemonMessage): void {
    for (const l of this.listeners) {
      l(m);
    }
  }
  sessions(metas: SessionMeta[]): void {
    this.push({ type: "sessions", sessions: metas });
  }
  of(type: string): Array<Record<string, unknown>> {
    return this.requests.filter((r) => r.type === type);
  }
}

export function meta(over: Partial<SessionMeta> = {}): SessionMeta {
  return { id: 1, cwd: "/work/proj", model: "prov/model-x", messageCount: 0, streaming: false, compacting: false, dead: false, active: true, pendingDialog: false, attachedToYou: false, attachedElsewhere: false, sessionId: "uuid-1", sessionName: "Fix The Build", published: true, chatUp: true, ...over };
}
