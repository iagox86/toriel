// What the chat bridge needs from a chat server, as a small interface: the real one (chatto-adapter.ts) talks to Chatto through
// @chatto/client, the fake (test/fake-chatto.ts) runs in memory so `npm test` needs no network.

export interface ChatRoom {
  id: string;
  name: string;
  archived: boolean;
  /** The room's description, when the server gave it (the bridge keeps a session tag in it). */
  description?: string;
}

export interface ChatGroup {
  id: string;
  name: string;
  /** Group-scoped permission decisions for the bot (e.g. a create-rooms key), as the server reports them; absent when it reports none. */
  permissions?: Record<string, boolean>;
}

export interface ChatMessage {
  id: string;
  roomId: string;
  authorId: string;
  /** Plain text of the message. */
  body: string;
  /** The message this one quotes, when it is a quote reply. */
  inReplyTo?: string;
  /** Set when it was posted inside a thread (the bridge does not use threads and says so). */
  threadRootId?: string;
  /** Images attached to it, when the server says so (not downloaded here). */
  attachments?: Array<{ id: string; name: string; mimeType: string }>;
}

export type ChatEvent =
  | { type: "message"; message: ChatMessage }
  | { type: "reaction"; roomId: string; messageId: string; userId: string; emoji: string; added: boolean }
  /** A room appeared in the bridge's group (or was renamed/archived there): `by` made the change. */
  | { type: "room"; room: ChatRoom; by: string; change: "created" | "renamed" | "archived" | "unarchived" };

export interface ChatAdapter {
  /** The bridge's own user id, known after connect(). */
  readonly selfId: string;
  /** Connect and start delivering events; rejects when the server or the token is refused. */
  connect(): Promise<void>;
  /** Every event the server sends, after connect(). Returns an unsubscribe. */
  onEvent(listener: (event: ChatEvent) => void): () => void;
  /** The connection to the server was lost / regained (the bridge shows it as its state). */
  onStatus(listener: (up: boolean) => void): () => void;
  /** Resolve the room group by name or id; undefined when there is none (the bridge says so and waits). */
  findGroup(nameOrId: string): Promise<string | undefined>;
  /** The room groups the bot can see, with the group-scoped permissions the server says it has there (key -> granted), when it says. */
  listGroups(): Promise<ChatGroup[]>;
  /** Every channel the bot can see with this name (case-insensitive), in any group, archived ones included. Room names are unique server-wide, so a name can be taken by a room this does not list (one the bot cannot see). */
  findRoomsNamed(name: string): Promise<Array<ChatRoom & { groupId?: string }>>;
  /** Rooms in the group, archived ones included. */
  listRooms(groupId: string): Promise<ChatRoom[]>;
  /** Archived rooms of the group, with their descriptions (the room list leaves them out); a closed channel is found again by the tag in it. */
  listArchived(groupId: string): Promise<ChatRoom[]>;
  /** Make a channel in the group and join it; rejects when the name is taken or the bot may not create. */
  createRoom(groupId: string, name: string, description: string): Promise<ChatRoom>;
  joinRoom(roomId: string): Promise<void>;
  /** User ids of a room's members (the bot may need to have joined it). */
  members(roomId: string): Promise<string[]>;
  /** Add another user to a room (the bot needs the permission to). */
  addMember(roomId: string, userId: string): Promise<void>;
  renameRoom(roomId: string, name: string): Promise<void>;
  setDescription(roomId: string, description: string): Promise<void>;
  archiveRoom(roomId: string): Promise<void>;
  unarchiveRoom(roomId: string): Promise<void>;
  /** Post a message; long text is the caller's to split (see MAX_BODY). Resolves to the new message's id. */
  post(roomId: string, body: string, opts?: { replyTo?: string }): Promise<string>;
  edit(roomId: string, messageId: string, body: string): Promise<void>;
  pin(roomId: string, messageId: string): Promise<void>;
  /** Reaction names are Chatto's shortcodes (`white_check_mark`, `x`, `one`..`nine`). */
  react(roomId: string, messageId: string, emoji: string): Promise<void>;
  unreact(roomId: string, messageId: string, emoji: string): Promise<void>;
  /** The room's latest messages (at most `limit`), oldest first, every author's, threads included; messages only, no joins or renames. For catching up on what was written while nobody listened. */
  recentMessages(roomId: string, limit: number): Promise<ChatMessage[]>;
  /** Show "typing" in the room for a few seconds; call again to keep it. */
  typing(roomId: string): Promise<void>;
  close(): void;
}

/** The longest message body the bridge posts; longer text is split (Chatto accepts 8000 code points). */
export const MAX_BODY = 7500;
