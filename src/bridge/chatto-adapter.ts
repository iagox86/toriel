// The real ChatAdapter: Chatto through @chatto/client (pinned to an exact version in package.json; it is pre-1.0). Loaded only inside the
// bridge's own process, never in the daemon, so a missing package cannot stop the daemon. Behaviour here was probed against a live
// server (ticket 265): the bot must joinRoom a channel it created, reaction names are shortcodes, a message's id is its event id.
import type { ChatAdapter, ChatEvent, ChatMessage, ChatRoom } from "./adapter.ts";

/** A request or reply of a generated service: its fields are read by name here, the package's own types are far wider. */
// biome-ignore lint/suspicious/noExplicitAny: generated protobuf messages, only the fields named below are read
type Payload = { [field: string]: any };

/** The parts of the @chatto/client server connection this adapter touches. */
interface Server {
  ready(): Promise<{ viewerId: string }>;
  onEvent(listener: (e: RealtimeEvent) => void): () => void;
  service(service: unknown): Record<string, (req: Payload) => Promise<Payload>>;
  createMessage(dest: { roomId: string; threadRootId: string }, body: string, opts?: { inReplyTo?: string }): Promise<{ id: string }>;
  addReaction(msg: { roomId: string; messageId: string }, emoji: string): Promise<void>;
  refreshTyping(dest: { roomId: string; threadRootId: string }): Promise<void>;
  /** 'connected' | 'connecting' | 'dormant' | 'disconnected' (the client reconnects by itself). */
  status: string;
  roomList: { rooms: Array<{ id: string; name: string; description?: string | null }>; roomGroups: Array<{ id: string; name: string; roomIds: string[] }> };
}

interface RealtimeEvent {
  id: string;
  actorId: string;
  event?: { case?: string; value?: Payload };
}

export interface ChattoConnect {
  url: string;
  token: string;
}

export async function connectChatto(opts: ChattoConnect): Promise<ChatAdapter> {
  const client = await import("@chatto/client");
  const types = await import("@chatto/client/types");
  const api = client.createClient();
  const server = api.connect({ serverUrl: opts.url, apiKey: opts.token }) as unknown as Server;
  const listeners = new Set<(e: ChatEvent) => void>();
  const statusListeners = new Set<(up: boolean) => void>();
  let selfId = "";
  /** Rooms of the group as last seen: id -> name, so a room event can be told as created or renamed. */
  const known = new Map<string, string>();
  let groupId: string | undefined;
  const emit = (e: ChatEvent) => {
    for (const l of listeners) {
      l(e);
    }
  };
  const rooms = (): ChatRoom[] => {
    const g = server.roomList.roomGroups.find((x) => x.id === groupId);
    const byId = new Map(server.roomList.rooms.map((r) => [r.id, r]));
    return (g?.roomIds ?? []).flatMap((id) => {
      const r = byId.get(id);
      return r ? [{ id, name: r.name, archived: false, description: r.description ?? undefined }] : [];
    });
  };
  const rediff = (by: string, change: "created" | "renamed" | "archived" | "unarchived"): void => {
    if (!groupId) {
      return;
    }
    const now = rooms();
    for (const r of now) {
      const before = known.get(r.id);
      if (before === undefined) {
        emit({ type: "room", room: r, by, change: change === "unarchived" ? "unarchived" : "created" });
      } else if (before !== r.name) {
        emit({ type: "room", room: r, by, change: "renamed" });
      }
      known.set(r.id, r.name);
    }
    for (const id of [...known.keys()]) {
      if (!now.some((r) => r.id === id)) {
        emit({ type: "room", room: { id, name: known.get(id) ?? "", archived: true }, by, change: "archived" });
        known.delete(id);
      }
    }
  };
  server.onEvent((e) => {
    const kind = e.event?.case;
    const v = e.event?.value ?? {};
    if (kind === "messagePosted") {
      const message: ChatMessage = { id: e.id, roomId: String(v.roomId), authorId: e.actorId, body: String(v.bodyPlaintext ?? ""), inReplyTo: v.inReplyTo || undefined, threadRootId: v.threadRootEventId || undefined };
      emit({ type: "message", message });
    } else if (kind === "reactionAdded" || kind === "reactionRemoved") {
      emit({ type: "reaction", roomId: String(v.roomId), messageId: String(v.messageEventId), userId: e.actorId, emoji: String(v.emoji), added: kind === "reactionAdded" });
    } else if (kind === "roomCreated" || kind === "roomUpdated" || kind === "roomArchived" || kind === "roomUnarchived") {
      // the payload shape of these was not probed: read the room list again (after the projection has applied it) and compare
      const change = kind === "roomCreated" ? "created" : kind === "roomArchived" ? "archived" : kind === "roomUnarchived" ? "unarchived" : "renamed";
      setTimeout(() => rediff(e.actorId, change), 300);
    }
  });
  // the client reconnects on its own and says nothing: look at its state, and call a connection that has not been 'connected' for 15 s down
  let notConnected = 0;
  let down = false;
  const watch = setInterval(() => {
    notConnected = server.status === "connected" ? 0 : notConnected + 1;
    const nowDown = notConnected >= 5;
    if (nowDown !== down) {
      down = nowDown;
      for (const l of statusListeners) {
        l(!down);
      }
    }
  }, 3000);
  watch.unref();
  const rooms$ = () => server.service(types.RoomService);
  const messages$ = () => server.service(types.MessageService);
  const types_directory = () => server.service(types.RoomDirectoryService);
  const adapter: ChatAdapter = {
    get selfId() {
      return selfId;
    },
    async connect() {
      selfId = (await server.ready()).viewerId;
      for (const l of statusListeners) {
        l(true);
      }
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onStatus(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    async findGroup(nameOrId) {
      // the projection fills in a moment after ready(); wait for it briefly
      for (let i = 0; i < 40 && server.roomList.roomGroups.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 250));
      }
      const g = server.roomList.roomGroups.find((x) => x.id === nameOrId || x.name.toLowerCase() === nameOrId.toLowerCase());
      groupId = g?.id;
      if (groupId) {
        known.clear();
        for (const r of rooms()) {
          known.set(r.id, r.name);
        }
      }
      return groupId;
    },
    async listRooms() {
      return rooms();
    },
    async listArchived(group) {
      // RoomDirectoryService.listRooms with the archived filter (probed live, ticket 279); scope 2 = channels, filter 2 = archived
      const out: ChatRoom[] = [];
      const seen = new Set<string>(); // pages are live reads: a room that moved between two of them is listed twice
      for (let offset = 0; offset < 2000; offset += 100) {
        const res = await types_directory().listRooms({ scope: 2, archiveFilter: 2, page: { limit: 100, offset } });
        for (const r of Array.isArray(res.rooms) ? (res.rooms as Payload[]) : []) {
          if (r.room?.groupId === group && !seen.has(String(r.room.id))) {
            seen.add(String(r.room.id));
            out.push({ id: String(r.room.id), name: String(r.room.name), archived: true, description: r.room.description || undefined });
          }
        }
        if (!res.page?.hasMore) {
          break;
        }
      }
      return out;
    },
    async createRoom(group, name, description) {
      const r = await rooms$().createRoom({ name, description, groupId: group, universal: false });
      const room = { id: String(r.room?.id), name, archived: false };
      await rooms$().joinRoom({ roomId: room.id });
      known.set(room.id, name); // our own room: not an event to react to
      return room;
    },
    async joinRoom(roomId) {
      await rooms$().joinRoom({ roomId });
    },
    async members(roomId) {
      const r = await rooms$().listMembers({ roomId });
      return Array.isArray(r.userIds) ? r.userIds.map(String) : [];
    },
    async addMember(roomId, userId) {
      await rooms$().addMember({ roomId, userId });
    },
    async renameRoom(roomId, name) {
      known.set(roomId, name);
      await rooms$().updateRoom({ roomId, name, updateMask: { paths: ["name"] } });
    },
    async setDescription(roomId, description) {
      await rooms$().updateRoom({ roomId, description, updateMask: { paths: ["description"] } });
    },
    async archiveRoom(roomId) {
      known.delete(roomId);
      await rooms$().archiveRoom({ roomId });
    },
    async unarchiveRoom(roomId) {
      await rooms$().unarchiveRoom({ roomId });
      await rooms$().joinRoom({ roomId }).catch(() => undefined);
    },
    async post(roomId, body, opts) {
      const m = await server.createMessage({ roomId, threadRootId: "" }, body, opts?.replyTo ? { inReplyTo: opts.replyTo } : undefined);
      return m.id;
    },
    async edit(roomId, messageId, body) {
      await messages$().updateMessage({ roomId, eventId: messageId, body });
    },
    async pin(roomId, messageId) {
      await rooms$().createPinnedMessage({ roomId, messageEventId: messageId });
    },
    async react(roomId, messageId, emoji) {
      await server.addReaction({ roomId, messageId }, emoji);
    },
    async unreact(roomId, messageId, emoji) {
      await messages$().removeReaction({ roomId, messageEventId: messageId, emoji });
    },
    async recentMessages(roomId, limit) {
      // the page is the newest `limit` events, oldest first (probed live, ticket 279); the `after` cursor is an opaque one, so the bridge slices by message id instead
      const res = await rooms$().getRoomEvents({ roomId, limit });
      const events: Payload[] = Array.isArray(res.page?.events) ? res.page.events : [];
      return events.flatMap((ev) => {
        const m = ev.event?.case === "messagePosted" ? ev.event.value?.message : undefined;
        if (!m || m.deletedAt) {
          return [];
        }
        const message: ChatMessage = {
          id: String(ev.id),
          roomId,
          authorId: String(ev.actorId),
          body: String(m.body ?? ""),
          inReplyTo: m.inReplyTo || undefined,
          threadRootId: m.threadRootEventId || undefined,
          ...(Array.isArray(m.attachments) && m.attachments.length > 0 ? { attachments: (m.attachments as Payload[]).map((a) => ({ id: String(a.id), name: String(a.filename ?? ""), mimeType: String(a.contentType ?? "") })) } : {}),
        };
        return [message];
      });
    },
    async typing(roomId) {
      await server.refreshTyping({ roomId, threadRootId: "" });
    },
    close() {
      clearInterval(watch);
      api.close();
    },
  };
  return adapter;
}
