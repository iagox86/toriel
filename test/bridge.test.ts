import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { Bridge, channelNameFor, messageText, sessionFromDescription, sessionNameFromChannel, splitBody } from "../src/bridge/bridge.ts";
import { readToken } from "../src/bridge/token.ts";
import { chatDisabledReason } from "../src/daemon-chat.ts";
import { type ChattoSettings, validChatto } from "../src/settings.ts";
import { FakeChat, FakeDaemon, meta, RON } from "./fake-chatto.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

const settings: ChattoSettings = { url: "https://chat.example.com", tokenEnv: "X", group: "Toriel", inboxChannel: "inbox", allowedUsers: [RON], defaultCwd: "/work", addUsers: [RON] };

async function setup(over: Partial<ChattoSettings> = {}, existing?: FakeChat) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-"));
  dirs.push(dir);
  const chat = existing ?? new FakeChat();
  const daemon = new FakeDaemon();
  const logs: string[] = [];
  const stateFile = path.join(dir, "state.json");
  const bridge = new Bridge({ adapter: chat, daemon, settings: { ...settings, ...over }, stateFile, log: (t) => logs.push(t) });
  await bridge.start();
  return { chat, daemon, bridge, logs, stateFile };
}

/** A published session with its channel open; returns the room. */
async function openSession(t: Awaited<ReturnType<typeof setup>>, over = {}) {
  t.daemon.sessions([meta(over)]);
  await t.bridge.idle();
  const room = t.chat.roomByName("fix-the-build");
  assert.ok(room, "the channel exists");
  return room;
}

describe("names", () => {
  it("makes channel names and session names", () => {
    assert.equal(channelNameFor("Fix The Build!", "x"), "fix-the-build");
    assert.equal(channelNameFor("über café 🚀", "x"), "ber-caf");
    assert.equal(channelNameFor("🚀", "session-3"), "session-3");
    assert.equal(channelNameFor("a".repeat(80), "x").length, 30);
    assert.equal(sessionNameFromChannel("my-toriel-room"), "My Toriel Room");
  });
  it("splits long text at line ends", () => {
    assert.deepEqual(splitBody("abc", 10), ["abc"]);
    const parts = splitBody(`${"a".repeat(8)}\n${"b".repeat(8)}`, 10);
    assert.deepEqual(parts, ["aaaaaaaa", "bbbbbbbb"]);
    assert.equal(splitBody("x".repeat(25), 10).join("").length, 25);
  });
  it("reads the text of a pi message", () => {
    assert.equal(messageText({ content: "hi" }), "hi");
    assert.equal(messageText({ content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "a" }, { type: "toolCall" }, { type: "text", text: "b" }] }), "a\nb");
  });
});

describe("settings, token and guards", () => {
  it("validates the chatto mapping", () => {
    assert.equal(validChatto({ url: "https://c", tokenFile: "~/t", allowedUser: "u" }).ok, true);
    assert.match((validChatto({ url: "https://c", allowedUser: "u" }) as { problem: string }).problem, /tokenFile and tokenEnv/);
    assert.match((validChatto({ url: "https://c", tokenFile: "t", tokenEnv: "E", allowedUser: "u" }) as { problem: string }).problem, /exactly one/);
    assert.match((validChatto({ url: "nope", tokenFile: "t", allowedUser: "u" }) as { problem: string }).problem, /URL/);
    assert.match((validChatto({ url: "https://c", tokenFile: "t" }) as { problem: string }).problem, /allowedUsers/);
    assert.match((validChatto({ url: "https://c", tokenFile: "t", allowedUser: "u", token: "secret" }) as { problem: string }).problem, /unknown chatto setting/);
    const ok = validChatto({ url: "https://c", tokenFile: "t", allowedUser: "u" });
    assert.ok(ok.ok && ok.chatto.group === "Toriel" && ok.chatto.inboxChannel === "inbox");
  });
  it("reads the token from an owner-only file or the environment, and says what is wrong otherwise", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "token-"));
    dirs.push(dir);
    const file = path.join(dir, "t");
    assert.match((readToken({ tokenFile: file }) as { problem: string }).problem, /does not exist/);
    fs.writeFileSync(file, "tok\n", { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    assert.match((readToken({ tokenFile: file }) as { problem: string }).problem, /chmod 600/);
    fs.chmodSync(file, 0o600);
    assert.deepEqual(readToken({ tokenFile: file }), { ok: true, token: "tok" });
    assert.deepEqual(readToken({ tokenEnv: "T" }, { T: " abc " }), { ok: true, token: "abc" });
    assert.match((readToken({ tokenEnv: "T" }, {}) as { problem: string }).problem, /unset/);
  });
  it("starts no bridge in a test or an isolated daemon, or without settings", () => {
    assert.equal(chatDisabledReason({}, undefined, true), undefined);
    assert.match(chatDisabledReason({ TORIEL_NO_CHAT: "1" }, undefined, true) ?? "", /TORIEL_NO_CHAT/);
    assert.match(chatDisabledReason({}, undefined, false) ?? "", /no chatto/);
    assert.match(chatDisabledReason({}, "dev", true) ?? "", /isolated/);
    assert.equal(chatDisabledReason({ TORIEL_CHAT: "1" }, "dev", true), undefined);
  });
});

describe("the bridge: startup", () => {
  it("creates the inbox, watches dialogs and says it is up", async () => {
    const t = await setup();
    assert.ok(t.chat.roomByName("inbox"));
    assert.deepEqual(t.daemon.requests.map((r) => r.type), ["observe_dialogs", "chat_status"]);
    assert.equal(t.daemon.of("chat_status")[0]?.up, true);
  });
  it("reuses an inbox that exists, and fails when the group does not", async () => {
    const chat = new FakeChat();
    await chat.createRoom("g1", "Inbox", "");
    const t = await setup({}, chat);
    assert.equal(chat.rooms.size, 1);
    assert.ok(t);
    await assert.rejects(setup({ group: "Nope" }), /does not exist/);
  });
});

describe("the bridge: a channel per published session", () => {
  it("opens one with a pinned first message and a status description, once", async () => {
    const t = await setup();
    const room = await openSession(t);
    const posts = t.chat.postsIn(room.id);
    assert.equal(posts.length, 1);
    assert.match(posts[0]?.body ?? "", /Fix The Build[\s\S]*\/work\/proj/);
    assert.deepEqual(t.chat.pins, [posts[0]?.id]);
    assert.match(room.description, /^idle/);
    t.daemon.sessions([meta({ streaming: true })]);
    await t.bridge.idle();
    assert.equal(t.chat.postsIn(room.id).length, 1, "a second list does not open it again");
    assert.match(t.chat.roomByName("fix-the-build")?.description ?? "", /^working/);
  });
  it("makes names unique and follows a rename", async () => {
    const t = await setup();
    await t.chat.createRoom("g1", "fix-the-build", "someone else's");
    t.daemon.sessions([meta()]);
    await t.bridge.idle();
    assert.ok(t.chat.roomByName("fix-the-build-2"));
    t.daemon.sessions([meta({ sessionName: "Ship It" })]);
    await t.bridge.idle();
    assert.ok(t.chat.roomByName("ship-it"));
    assert.equal(t.chat.roomByName("fix-the-build-2"), undefined);
  });
  it("closes the channel when the session is no longer published, and reuses it when it is again", async () => {
    const t = await setup();
    const room = await openSession(t);
    t.daemon.sessions([meta({ published: undefined, chatUp: undefined })]);
    await t.bridge.idle();
    assert.equal(room.archived, true);
    assert.match(t.chat.postsIn(room.id)[0]?.body ?? "", /^\*\*closed\*\*/);
    t.daemon.sessions([meta()]);
    await t.bridge.idle();
    assert.equal(room.archived, false);
    assert.equal(t.chat.rooms.size, 2, "the inbox and the same channel");
    assert.match(t.chat.postsIn(room.id).at(-1)?.body ?? "", /Fix The Build/);
  });
  it("keeps a published session's channel when the daemon does not list it (asleep after a restart)", async () => {
    const t = await setup();
    const room = await openSession(t);
    t.daemon.sessions([]);
    await t.bridge.idle();
    assert.equal(room.archived, false);
  });
  it("remembers its channels across a restart", async () => {
    const t = await setup();
    const room = await openSession(t);
    const again = new Bridge({ adapter: t.chat, daemon: new FakeDaemon(), settings, stateFile: t.stateFile, log: () => undefined });
    await again.start();
    const d = new FakeDaemon();
    const third = new Bridge({ adapter: t.chat, daemon: d, settings, stateFile: t.stateFile, log: () => undefined });
    await third.start();
    d.sessions([meta()]);
    await third.idle();
    assert.equal([...t.chat.rooms.values()].filter((r) => r.name.startsWith("fix-the-build")).length, 1);
    assert.equal(t.chat.postsIn(room.id).length, 2, "the old first message says closed, a new one opens the channel again");
    assert.match(t.chat.postsIn(room.id)[0]?.body ?? "", /^\*\*closed\*\*/);
    assert.equal(room.archived, false);
  });
  it("clears its channels when it is told to stop, and again when it starts after a crash", async () => {
    const t = await setup();
    const room = await openSession(t);
    await t.bridge.shutdown();
    assert.equal(room.archived, true);
    assert.match(t.chat.postsIn(room.id)[0]?.body ?? "", /^\*\*closed\*\*[\s\S]*toriel stopped/);
    assert.equal(t.daemon.of("chat_status").at(-1)?.up, false);
    // a bridge that died without cleaning up leaves an open channel: the next start clears it
    const t2 = await setup();
    const room2 = await openSession(t2);
    const again = new Bridge({ adapter: t2.chat, daemon: new FakeDaemon(), settings, stateFile: t2.stateFile, log: () => undefined });
    await again.start();
    assert.equal(room2.archived, true);
    assert.match(t2.chat.postsIn(room2.id)[0]?.body ?? "", /toriel was restarted/);
  });
});

describe("the bridge: who joins the channels it makes", () => {
  it("adds the configured users to the inbox and to each new session channel, and again when a closed one reopens", async () => {
    const t = await setup({ addUsers: [RON, "friend1"] });
    const inbox = t.chat.roomByName("inbox");
    assert.deepEqual(t.chat.added, [[inbox?.id, RON], [inbox?.id, "friend1"]]);
    const room = await openSession(t);
    assert.deepEqual(t.chat.added.slice(2), [[room.id, RON], [room.id, "friend1"]]);
    t.daemon.sessions([meta({ published: undefined })]);
    await t.bridge.idle();
    t.daemon.sessions([meta()]);
    await t.bridge.idle();
    assert.deepEqual(t.chat.added.slice(4), [[room.id, RON], [room.id, "friend1"]], "republishing reuses the channel and puts the users back");
  });
  it("adds nobody when the list is empty, and carries on when the server refuses", async () => {
    const none = await setup({ addUsers: [] });
    assert.equal(none.chat.added.length, 0);
    const chat = new FakeChat();
    chat.addMember = async () => {
      throw new Error("not allowed");
    };
    const t = await setup({}, chat);
    await openSession(t);
    assert.ok(t.logs.some((l) => l.includes("could not add user ron1")));
  });
  it("defaults to the allowed user, and validates the list", () => {
    const ok = validChatto({ url: "https://c", tokenFile: "t", allowedUser: "u1" });
    assert.ok(ok.ok && ok.chatto.addUsers.join() === "u1");
    const none = validChatto({ url: "https://c", tokenFile: "t", allowedUser: "u1", addUsers: [] });
    assert.ok(none.ok && none.chatto.addUsers.length === 0);
    assert.match((validChatto({ url: "https://c", tokenFile: "t", allowedUser: "u1", addUsers: "u2" }) as { problem: string }).problem, /list of user ids/);
  });
});

describe("the bridge: more than one allowed user, renames, numbered options", () => {
  it("acts on every allowed user and on nobody else", async () => {
    const t = await setup({ allowedUsers: [RON, "friend1"] });
    const room = await openSession(t);
    t.chat.say(room.id, "from the friend", { userId: "friend1" });
    t.chat.say(room.id, "from a stranger", { userId: "stranger" });
    await t.bridge.idle();
    assert.deepEqual(t.daemon.of("prompt").map((p) => p.message), ["from the friend"]);
  });
  it("accepts allowedUsers as a list and allowedUser as one, together", () => {
    const both = validChatto({ url: "https://c", tokenFile: "t", allowedUsers: ["a", "b"], allowedUser: "c" });
    assert.ok(both.ok && both.chatto.allowedUsers.join() === "a,b,c" && both.chatto.addUsers.join() === "a,b,c");
    assert.match((validChatto({ url: "https://c", tokenFile: "t", allowedUsers: "a" }) as { problem: string }).problem, /list of user ids/);
  });
  it("renames the session when the user renames its channel in chat, and does not rename the channel back", async () => {
    const t = await setup();
    const room = await openSession(t);
    room.name = "ship-it-now";
    t.chat.emit({ type: "room", room: { id: room.id, name: "ship-it-now", archived: false }, by: RON, change: "renamed" });
    await t.bridge.idle();
    assert.deepEqual(t.daemon.of("rename"), [{ type: "rename", session: 1, name: "Ship It Now" }]);
    t.daemon.sessions([meta({ sessionName: "Ship It Now" })]);
    await t.bridge.idle();
    assert.equal(room.name, "ship-it-now");
    // somebody else's rename, or the bridge's own, is not acted on
    t.chat.emit({ type: "room", room: { id: room.id, name: "other-name", archived: false }, by: "stranger", change: "renamed" });
    await t.bridge.idle();
    assert.equal(t.daemon.of("rename").length, 1);
  });
  it("does not number options an extension numbered already", async () => {
    const t = await setup();
    const room = await openSession(t);
    t.daemon.push({ type: "ui_request", session: 1, request: { id: "q1", method: "select", title: "Which?", options: ["1. Single select — x", "2. Multi select — y", "3. Type something."] } });
    await t.bridge.idle();
    const body = t.chat.postsIn(room.id).at(-1)?.body ?? "";
    assert.match(body, /\n1\. Single select — x\n2\. Multi select — y\n3\. Type something\.\n/);
    assert.doesNotMatch(body, /1\. 1\./);
    t.chat.say(room.id, "2");
    await t.bridge.idle();
    assert.equal(((t.daemon.of("ui_response")[0] as { response: { value: string } }).response).value, "2. Multi select — y");
  });
  it("keeps the channel the user made open while the daemon catches up with publishing the new session", async () => {
    const t = await setup();
    const made = await t.chat.createRoom("g1", "ron-test", "");
    t.chat.emit({ type: "room", room: made, by: RON, change: "created" });
    t.chat.say(made.id, "hello");
    await t.bridge.idle();
    t.daemon.sessions([meta({ id: 100, sessionId: "uuid-new", sessionName: undefined, published: undefined })]);
    await t.bridge.idle();
    assert.equal(made.archived, false, "not closed in the list that still says unpublished");
    assert.equal(made.name, "ron-test", "and not renamed to nothing");
    t.daemon.sessions([meta({ id: 100, sessionId: "uuid-new", sessionName: "Ron Test" })]);
    await t.bridge.idle();
    assert.equal(made.archived, false);
    assert.ok(t.chat.postsIn(made.id).some((p) => /Ron Test/.test(p.body)));
  });
});

describe("the bridge: a channel carries its session's id", () => {
  it("tags the description with the session uuid from the start, through every status change and a close, and shows it in the first message", async () => {
    const t = await setup();
    const room = await openSession(t);
    assert.equal(sessionFromDescription(room.description), "uuid-1");
    t.daemon.sessions([meta({ streaming: true })]);
    await t.bridge.idle();
    assert.match(room.description, /^working .*\[toriel:uuid-1\]$/);
    assert.match(t.chat.postsIn(room.id)[0]?.body ?? "", /_session uuid-1_/);
    t.daemon.sessions([meta({ published: undefined })]);
    await t.bridge.idle();
    assert.equal(room.description, "closed [toriel:uuid-1]");
    assert.equal(sessionFromDescription("no tag here"), undefined);
    assert.equal(sessionFromDescription("[toriel:a] then more"), undefined, "the tag is the end of the description");
  });
  it("finds its channels again from the tags when its own state file is lost, instead of making a second one", async () => {
    const t = await setup();
    const room = await openSession(t);
    // a bridge that died without clearing, and whose state file is gone
    fs.rmSync(t.stateFile);
    const d = new FakeDaemon();
    const lost = new Bridge({ adapter: t.chat, daemon: d, settings, stateFile: t.stateFile, log: () => undefined });
    await lost.start();
    d.sessions([meta()]);
    await lost.idle();
    assert.equal([...t.chat.rooms.values()].filter((r) => r.name.startsWith("fix-the-build")).length, 1);
    assert.equal(room.archived, false);
    assert.equal(sessionFromDescription(room.description), "uuid-1");
  });
  it("forgets a link the channel's own tag contradicts, and leaves a channel tagged for a session it keeps elsewhere alone", async () => {
    const t = await setup();
    const room = await openSession(t);
    // someone (or a copy of the state file) points session uuid-2 at the channel of uuid-1
    const state = JSON.parse(fs.readFileSync(t.stateFile, "utf8"));
    state.channels["uuid-2"] = { roomId: room.id, name: room.name, closed: false };
    fs.writeFileSync(t.stateFile, JSON.stringify(state));
    const logs: string[] = [];
    const again = new Bridge({ adapter: t.chat, daemon: new FakeDaemon(), settings, stateFile: t.stateFile, log: (l) => logs.push(l) });
    await again.start();
    assert.ok(logs.some((l) => l.includes("tagged for session uuid-1, not uuid-2")));
    const after = JSON.parse(fs.readFileSync(t.stateFile, "utf8"));
    assert.equal(after.channels["uuid-2"], undefined);
    assert.equal(after.channels["uuid-1"].roomId, room.id);
  });
});

describe("the bridge: the group belongs to toriel", () => {
  it("tells a stranger who makes a channel it is not theirs to make, and closes it", async () => {
    const t = await setup();
    const made = await t.chat.createRoom("g1", "stranger-room", "");
    t.chat.emit({ type: "room", room: made, by: "stranger", change: "created" });
    await t.bridge.idle();
    assert.equal(t.chat.rooms.get(made.id)?.archived, true);
    assert.match(t.chat.postsIn(made.id)[0]?.body ?? "", /belongs to toriel/);
    assert.ok(t.logs.some((l) => l.includes("stranger-room") && l.includes("stranger")));
  });
  it("says what a channel an allowed user makes is for, for every allowed user", async () => {
    const t = await setup({ allowedUsers: [RON, "friend1"] });
    const made = await t.chat.createRoom("g1", "chris-room", "");
    t.chat.emit({ type: "room", room: made, by: "friend1", change: "created" });
    await t.bridge.idle();
    assert.equal(t.chat.rooms.get(made.id)?.archived, false);
    assert.match(t.chat.postsIn(made.id)[0]?.body ?? "", /start a session named \*\*Chris Room\*\*/);
    t.chat.say(made.id, "hi from chris", { userId: "friend1" });
    await t.bridge.idle();
    assert.deepEqual(t.daemon.of("spawn"), [{ type: "spawn", cwd: "/work", name: "Chris Room" }]);
  });
  it("closes a session channel somebody reopens while its session is not published", async () => {
    const t = await setup();
    const room = await openSession(t);
    t.daemon.sessions([meta({ published: undefined })]);
    await t.bridge.idle();
    assert.equal(room.archived, true);
    room.archived = false; // somebody unarchived it in chat
    t.chat.emit({ type: "room", room: { id: room.id, name: room.name, archived: false }, by: RON, change: "unarchived" });
    await t.bridge.idle();
    assert.equal(room.archived, true);
    assert.match(t.chat.postsIn(room.id).at(-1)?.body ?? "", /not published/);
  });
  it("finds a room no event announced, and judges it by who is in it", async () => {
    const t = await setup({ allowedUsers: [RON, "friend1"] });
    const theirs = await t.chat.createRoom("g1", "chris-room", "");
    t.chat.memberIds.set(theirs.id, ["friend1"]);
    const strangers = await t.chat.createRoom("g1", "intruder", "");
    t.chat.memberIds.set(strangers.id, ["stranger"]);
    await t.bridge.discoverNow();
    assert.equal(t.chat.rooms.get(theirs.id)?.archived, false);
    assert.equal(t.chat.rooms.get(strangers.id)?.archived, true);
    t.chat.say(theirs.id, "hello", { userId: "friend1" });
    await t.bridge.idle();
    assert.equal(t.daemon.of("spawn").length, 1);
    // a second look does not greet or close anything again
    const posts = t.chat.posts.length;
    await t.bridge.discoverNow();
    assert.equal(t.chat.posts.length, posts);
  });
  it("at start joins what is in the group and closes the rooms that are neither the inbox nor a session's", async () => {
    const chat = new FakeChat();
    const stray = await chat.createRoom("g1", "old-experiment", "");
    const t = await setup({}, chat);
    assert.equal(chat.rooms.get(stray.id)?.archived, true);
    assert.match(chat.postsIn(stray.id)[0]?.body ?? "", /Not a toriel session channel/);
    assert.equal(chat.roomByName("inbox")?.archived, false);
    assert.ok(t);
  });
});

describe("the bridge: output", () => {
  it("posts the assistant's text with a count of the tools that ran, and shows typing while it works", async () => {
    const t = await setup();
    const room = await openSession(t);
    const ev = (event: Record<string, unknown>) => t.daemon.push({ type: "event", session: 1, event });
    ev({ type: "agent_start" });
    ev({ type: "tool_execution_end" });
    ev({ type: "tool_execution_end" });
    ev({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Done: fixed it." }] } });
    ev({ type: "agent_settled" });
    await t.bridge.idle();
    assert.ok(t.chat.typings.includes(room.id));
    assert.equal(t.chat.postsIn(room.id).at(-1)?.body, "Done: fixed it.\n\n_2 tools ran_");
    assert.equal(t.chat.postsIn(room.id).length, 2);
  });
  it("says tools ran when the turn ended without text, and posts nothing for a thinking-only message", async () => {
    const t = await setup();
    const room = await openSession(t);
    const ev = (event: Record<string, unknown>) => t.daemon.push({ type: "event", session: 1, event });
    ev({ type: "tool_execution_end" });
    ev({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "x" }] } });
    ev({ type: "agent_settled" });
    await t.bridge.idle();
    assert.equal(t.chat.postsIn(room.id).at(-1)?.body, "_1 tool ran_");
  });
  it("shows what was typed in toriel, but not what chat itself sent", async () => {
    const t = await setup();
    const room = await openSession(t);
    t.chat.say(room.id, "from chat");
    await t.bridge.idle();
    const user = (text: string) => t.daemon.push({ type: "event", session: 1, event: { type: "message_end", message: { role: "user", content: text } } });
    user("from chat");
    user("from the desktop");
    await t.bridge.idle();
    const bodies = t.chat.postsIn(room.id).map((p) => p.body);
    assert.ok(!bodies.some((b) => b.includes("from chat")));
    assert.ok(bodies.some((b) => b.includes("typed in toriel") && b.includes("from the desktop")));
  });
  it("does nothing for a session that is not published", async () => {
    const t = await setup();
    t.daemon.sessions([meta({ id: 2, sessionId: "uuid-2", published: undefined })]);
    t.daemon.push({ type: "event", session: 2, event: { type: "message_end", message: { role: "assistant", content: "x" } } });
    await t.bridge.idle();
    assert.equal(t.chat.rooms.size, 1);
  });
});

describe("the bridge: input", () => {
  it("sends the user's message to the live session as a prompt from chatto", async () => {
    const t = await setup();
    const room = await openSession(t);
    t.chat.say(room.id, "run the tests");
    await t.bridge.idle();
    assert.deepEqual(t.daemon.of("prompt"), [{ type: "prompt", session: 1, message: "run the tests", source: "chatto" }]);
  });
  it("wakes a sleeping session through its file", async () => {
    const t = await setup();
    const room = await openSession(t, { active: false, sessionFile: "/s/f.jsonl" });
    t.chat.say(room.id, "wake up");
    await t.bridge.idle();
    assert.deepEqual(t.daemon.of("prompt")[0], { type: "prompt", sessionFile: "/s/f.jsonl", cwd: "/work/proj", message: "wake up", source: "chatto" });
  });
  it("ignores everyone but the allowed user, and the bot itself", async () => {
    const t = await setup();
    const room = await openSession(t);
    t.chat.say(room.id, "hello", { userId: "stranger" });
    t.chat.say(room.id, "echo", { userId: "bot1" });
    await t.bridge.idle();
    assert.equal(t.daemon.of("prompt").length, 0);
    assert.ok(t.logs.some((l) => l.includes("stranger")));
    assert.ok(!t.logs.some((l) => l.includes("hello")), "the content is never logged");
  });
  it("answers in the channel when the prompt fails, and says threads are not used", async () => {
    const t = await setup();
    const room = await openSession(t);
    t.daemon.failures.set("prompt", "session is busy elsewhere");
    t.chat.say(room.id, "go");
    t.chat.say(room.id, "in a thread", { threadRootId: "m1" });
    await t.bridge.idle();
    const bodies = t.chat.postsIn(room.id).map((p) => p.body);
    assert.ok(bodies.some((b) => b.includes("could not send that: session is busy elsewhere")));
    assert.ok(bodies.some((b) => b.includes("don't use threads")));
    assert.equal(t.daemon.of("prompt").length, 1);
  });
});

describe("the bridge: dialogs", () => {
  const select = { id: "d1", method: "select", title: "Permission Required\ntool: bash", options: ["Yes", "Yes, for this session", "No"] };

  it("posts a select with number reactions, and a click answers it once", async () => {
    const t = await setup();
    const room = await openSession(t);
    t.daemon.push({ type: "ui_request", session: 1, request: select });
    await t.bridge.idle();
    const post = t.chat.postsIn(room.id).at(-1);
    assert.ok(post);
    assert.match(post.body, /1\. Yes[\s\S]*3\. No/);
    assert.deepEqual([...post.reactions], ["one", "two", "three"]);
    t.chat.react$(room.id, post.id, "three");
    await t.bridge.idle();
    assert.deepEqual(t.daemon.of("ui_response"), [{ type: "ui_response", session: 1, source: "chatto", response: { type: "extension_ui_response", id: "d1", value: "No" } }]);
    // the daemon says it is over: the message is edited and the other choices cleared, the chosen one stays
    t.daemon.push({ type: "ui_resolved", session: 1, id: "d1", by: "user", source: "chatto" });
    await t.bridge.idle();
    assert.match(post.body, /→ answered \(three\)/);
    assert.deepEqual([...post.reactions], ["three"]);
  });
  it("takes a typed number, and a reaction by anyone else is ignored", async () => {
    const t = await setup();
    const room = await openSession(t);
    t.daemon.push({ type: "ui_request", session: 1, request: select });
    await t.bridge.idle();
    const post = t.chat.postsIn(room.id).at(-1) as { id: string };
    t.chat.react$(room.id, post.id, "one", "stranger");
    t.chat.react$(room.id, post.id, "one", "bot1");
    await t.bridge.idle();
    assert.equal(t.daemon.of("ui_response").length, 0);
    t.chat.say(room.id, "2");
    await t.bridge.idle();
    assert.equal(((t.daemon.of("ui_response")[0] as { response: { value: string } }).response).value, "Yes, for this session");
    assert.equal(t.daemon.of("prompt").length, 0, "the answer was not also sent as a prompt");
  });
  it("answers a confirm with a check or a cross, and an input dialog with the next message", async () => {
    const t = await setup();
    const room = await openSession(t);
    t.daemon.push({ type: "ui_request", session: 1, request: { id: "c1", method: "confirm", title: "Allow?", message: "run rm" } });
    await t.bridge.idle();
    const post = t.chat.postsIn(room.id).at(-1) as { id: string; reactions: Set<string> };
    assert.deepEqual([...post.reactions], ["white_check_mark", "x"]);
    t.chat.react$(room.id, post.id, "white_check_mark");
    await t.bridge.idle();
    t.daemon.push({ type: "ui_resolved", session: 1, id: "c1", by: "user", source: "chatto" });
    t.daemon.push({ type: "ui_request", session: 1, request: { id: "i1", method: "input", title: "Reason?" } });
    await t.bridge.idle();
    t.chat.say(room.id, "because I said so");
    await t.bridge.idle();
    const answers = t.daemon.of("ui_response").map((r) => r.response);
    assert.deepEqual(answers, [{ type: "extension_ui_response", id: "c1", confirmed: true }, { type: "extension_ui_response", id: "i1", value: "because I said so" }]);
  });
  it("edits the message when the dialog ended some other way", async () => {
    const t = await setup();
    const room = await openSession(t);
    t.daemon.push({ type: "ui_request", session: 1, request: select });
    await t.bridge.idle();
    const post = t.chat.postsIn(room.id).at(-1) as { body: string; reactions: Set<string> };
    t.daemon.push({ type: "ui_resolved", session: 1, id: "d1", by: "user" });
    await t.bridge.idle();
    assert.match(post.body, /answered in toriel/);
    assert.equal(post.reactions.size, 0);
  });
  it("does not post a dialog of a session that is not published", async () => {
    const t = await setup();
    t.daemon.sessions([meta({ id: 2, sessionId: "uuid-2", published: undefined })]);
    t.daemon.push({ type: "ui_request", session: 2, request: select });
    await t.bridge.idle();
    assert.equal(t.chat.posts.length, 0);
  });
});

describe("the bridge: starting sessions from chat", () => {
  it("starts a session from a message in the inbox, publishes it once it has an id, and says where it is", async () => {
    const t = await setup();
    const inbox = t.chat.roomByName("inbox");
    assert.ok(inbox);
    t.chat.say(inbox.id, "look into the flaky test");
    await t.bridge.idle();
    assert.deepEqual(t.daemon.of("spawn"), [{ type: "spawn", cwd: "/work" }]);
    assert.equal(t.daemon.of("detach")[0]?.session, 100);
    assert.deepEqual(t.daemon.of("prompt")[0], { type: "prompt", session: 100, message: "look into the flaky test", source: "chatto" });
    assert.equal(t.daemon.of("publish").length, 0, "no id yet");
    t.daemon.sessions([meta({ id: 100, sessionId: "uuid-new", sessionName: "Flaky Test", published: undefined })]);
    await t.bridge.idle();
    assert.deepEqual(t.daemon.of("publish"), [{ type: "publish", sessionId: "uuid-new", on: true }]);
    t.daemon.sessions([meta({ id: 100, sessionId: "uuid-new", sessionName: "Flaky Test" })]);
    await t.bridge.idle();
    const room = t.chat.roomByName("flaky-test");
    assert.ok(room);
    assert.match(t.chat.postsIn(inbox.id).at(-1)?.body ?? "", /Started \*\*Flaky Test\*\*[\s\S]*#flaky-test/);
  });
  it("starts a session named after a channel the user made, in that channel, on its first message", async () => {
    const t = await setup();
    const made = await t.chat.createRoom("g1", "my-toriel-room", "");
    t.chat.emit({ type: "room", room: made, by: RON, change: "created" });
    await t.bridge.idle();
    assert.equal(t.daemon.of("spawn").length, 0, "nothing starts before the first message");
    t.chat.say(made.id, "hello there");
    await t.bridge.idle();
    assert.deepEqual(t.daemon.of("spawn"), [{ type: "spawn", cwd: "/work", name: "My Toriel Room" }]);
    t.daemon.sessions([meta({ id: 100, sessionId: "uuid-new", sessionName: "My Toriel Room", published: undefined })]);
    await t.bridge.idle();
    t.daemon.sessions([meta({ id: 100, sessionId: "uuid-new", sessionName: "My Toriel Room" })]);
    await t.bridge.idle();
    assert.equal([...t.chat.rooms.values()].filter((r) => r.name.startsWith("my-toriel-room")).length, 1, "the user's channel is used, none is made");
    assert.ok(t.chat.postsIn(made.id).some((p) => /My Toriel Room/.test(p.body)));
  });
  it("ignores a channel somebody else made", async () => {
    const t = await setup();
    const made = await t.chat.createRoom("g1", "stranger-room", "");
    t.chat.emit({ type: "room", room: made, by: "stranger", change: "created" });
    t.chat.say(made.id, "hi");
    await t.bridge.idle();
    assert.equal(t.daemon.of("spawn").length, 0);
  });
});
