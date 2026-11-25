// A published session's past in its channel, and what was written in the channel while nobody listened (ticket 279).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { Bridge } from "../src/bridge/bridge.ts";
import { renderHistory } from "../src/bridge/history.ts";
import { formatLocalCommand } from "../src/local-command.ts";
import type { ChattoSettings } from "../src/settings.ts";
import type { HistoryTurn } from "../src/shared.ts";
import { digestHistory } from "../src/daemon-history.ts";
import { crashReason } from "../src/daemon-chat.ts";
import { FakeChat, FakeDaemon, meta, RON } from "./fake-chatto.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

const settings: ChattoSettings = { url: "https://chat.example.com", tokenEnv: "X", group: "Toriel", inboxChannel: "inbox", allowedUsers: [RON], defaultCwd: "/work", addUsers: [RON] };

async function setup(chat = new FakeChat(), dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-hist-"))) {
  dirs.push(dir);
  const daemon = new FakeDaemon();
  const logs: string[] = [];
  const bridge = new Bridge({ adapter: chat, daemon, settings, stateFile: path.join(dir, "state.json"), log: (t) => logs.push(t), retryMs: 0 });
  await bridge.start();
  return { chat, daemon, bridge, logs, dir };
}

const turn = (role: HistoryTurn["role"], text: string, at?: number, extra: Partial<HistoryTurn> = {}): HistoryTurn => ({ role, text, ...(at !== undefined ? { at } : {}), ...extra });

describe("the digest of a conversation", () => {
  it("keeps user and assistant text, counts tool calls, marks compaction, and drops the rest", () => {
    const d = digestHistory(
      [
        { role: "user", content: "fix it", timestamp: 1 },
        { role: "assistant", content: [{ type: "thinking", thinking: "hm" }, { type: "toolCall", name: "bash" }, { type: "toolCall", name: "read" }], timestamp: 2 },
        { role: "toolResult", content: [{ type: "text", text: "output" }], timestamp: 3 },
        { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 4 },
        { role: "assistant", content: [{ type: "thinking", thinking: "only thinking" }] },
        { role: "compactionSummary", summary: "s", timestamp: 5 },
        { role: "custom", content: "x" },
        { role: "assistant", content: [], stopReason: "aborted", timestamp: 6 },
      ],
      40,
    );
    assert.equal(d.total, 5);
    assert.deepEqual(
      d.turns.map((t) => [t.role, t.text, t.tools, t.at, t.stopReason]),
      [
        ["user", "fix it", undefined, 1, undefined],
        ["assistant", "", 2, 2, undefined],
        ["assistant", "done", undefined, 4, undefined],
        ["compaction", "", undefined, 5, undefined],
        ["assistant", "", undefined, 6, "aborted"],
      ],
    );
  });
  it("returns the last turns and says how many there were", () => {
    const messages = Array.from({ length: 10 }, (_, i) => ({ role: "user", content: `m${i}` }));
    const d = digestHistory(messages, 3);
    assert.deepEqual(d.turns.map((t) => t.text), ["m7", "m8", "m9"]);
    assert.equal(d.total, 10);
    assert.equal(digestHistory(messages, 0).turns.length, 0);
  });
});

describe("history as posts", () => {
  it("shows an injected !command as the command and its output, not the wrapper meant for the model", () => {
    const wrapped = formatLocalCommand("head -n1 /etc/passwd", { output: "root:x:0:0\n", exitCode: 0, cancelled: false, truncated: false });
    const { posts } = renderHistory([turn("user", wrapped)]);
    assert.deepEqual(posts, ["> **ran in toriel:** `head -n1 /etc/passwd` (exit 0)\n```\nroot:x:0:0\n```"]);
    assert.ok(!posts[0].includes("local-command"));
  });
  it("quotes what was typed, shows replies with the tools run since the last one, and says where it was compacted or interrupted", () => {
    const { posts, shown, dropped } = renderHistory([
      turn("user", "fix the build"),
      turn("assistant", "", undefined, { tools: 2 }),
      turn("assistant", "", undefined, { tools: 1 }),
      turn("assistant", "fixed it"),
      turn("compaction", ""),
      turn("assistant", "", undefined, { stopReason: "aborted" }),
      turn("assistant", "", undefined, { tools: 1 }),
    ]);
    assert.deepEqual(posts, ["> **you:** fix the build", "fixed it\n\n_3 tools ran_", "ℹ context compacted here", "⏹ interrupted", "_1 tool ran_"]);
    assert.equal(shown, 7);
    assert.equal(dropped, 0);
  });
  it("drops the oldest turns when it would be too long", () => {
    const turns = Array.from({ length: 10 }, (_, i) => turn("assistant", `reply ${i} ${"x".repeat(100)}`));
    const { posts, shown, dropped } = renderHistory(turns, 350);
    assert.equal(posts.length, 3);
    assert.match(posts[0], /reply 7/);
    assert.equal(shown, 3);
    assert.equal(dropped, 7);
  });
});

describe("a channel made for a session that has a past", () => {
  it("shows the conversation so far before the acknowledgement", async () => {
    const t = await setup();
    t.daemon.histories.set(1, { total: 3, turns: [turn("user", "hello", 10), turn("assistant", "hi there", 11, { tools: 1 }), turn("assistant", "bye", 12)] });
    t.daemon.sessions([meta()]);
    await t.bridge.idle();
    const room = t.chat.roomByName("fix-the-build");
    assert.ok(room);
    const bodies = t.chat.postsIn(room.id).map((p) => p.body);
    assert.match(bodies[0], /Fix The Build/); // the pinned post
    assert.match(bodies[1], /So far/);
    assert.deepEqual(bodies.slice(2, 5), ["> **you:** hello", "hi there", "bye\n\n_1 tool ran_"]);
    assert.match(bodies[5], /Published/);
    assert.deepEqual(t.daemon.of("read_history"), [{ type: "read_history", session: 1, last: 40 }]);
  });
  it("says when the earlier turns are left out, and shows nothing for an empty conversation", async () => {
    const t = await setup();
    t.daemon.histories.set(1, { total: 90, turns: [turn("user", "recent", 10)] });
    t.daemon.sessions([meta(), meta({ id: 2, sessionId: "uuid-2", sessionName: "Empty One" })]);
    await t.bridge.idle();
    const first = t.chat.postsIn((t.chat.roomByName("fix-the-build") as { id: string }).id).map((p) => p.body);
    assert.match(first[1], /the last 1 of 90 turns/);
    const second = t.chat.postsIn((t.chat.roomByName("empty-one") as { id: string }).id).map((p) => p.body);
    assert.equal(second.length, 2, "the pinned post and the acknowledgement");
  });
  it("opens the channel anyway when the history cannot be read", async () => {
    const t = await setup();
    t.daemon.failures.set("read_history", "no such session");
    t.daemon.sessions([meta()]);
    await t.bridge.idle();
    const room = t.chat.roomByName("fix-the-build");
    assert.ok(room && t.chat.postsIn(room.id).some((p) => /Published/.test(p.body)));
    assert.ok(t.logs.some((l) => /could not read the history/.test(l)));
  });
});

describe("a channel that comes back", () => {
  it("shows what happened while it was closed, and not what it already showed", async () => {
    const t = await setup();
    t.daemon.histories.set(1, { total: 1, turns: [turn("user", "first", 10)] });
    t.daemon.sessions([meta()]);
    await t.bridge.idle();
    const room = t.chat.roomByName("fix-the-build") as { id: string };
    t.daemon.push({ type: "event", session: 1, event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "seen live" }], timestamp: 20 } } });
    await t.bridge.idle();
    t.daemon.sessions([meta({ published: undefined })]); // unpublished: the channel closes
    await t.bridge.idle();
    t.daemon.histories.set(1, { total: 3, turns: [turn("user", "first", 10), turn("assistant", "seen live", 20), turn("user", "typed while away", 30), turn("assistant", "answer while away", 31)] });
    t.daemon.sessions([meta()]);
    await t.bridge.idle();
    const bodies = t.chat.postsIn(room.id).map((p) => p.body);
    const last = bodies.slice(bodies.findLastIndex((b) => /While this channel was closed/.test(b)));
    assert.match(last[0], /\(2 turns\)/);
    assert.deepEqual(last.slice(1, 3), ["> **you:** typed while away", "answer while away"]);
    assert.match(last[3], /Published again/);
    assert.equal(bodies.filter((b) => b === "seen live").length, 1, "shown once, live");
  });
});

describe("what was written in a channel while nobody listened", () => {
  it("is sent to the session in order, with a note, and only once", async () => {
    const t = await setup();
    t.daemon.sessions([meta()]);
    await t.bridge.idle();
    const room = t.chat.roomByName("fix-the-build") as { id: string };
    t.chat.deliver = false; // the connection dropped: the server keeps the messages, the bridge hears nothing
    t.chat.say(room.id, "first while away");
    t.chat.say(room.id, "second while away");
    await t.bridge.idle();
    assert.equal(t.daemon.of("prompt").length, 0);
    t.chat.deliver = true;
    t.chat.say(room.id, "back again"); // the next event that does arrive brings the earlier ones with it, in order
    await t.bridge.idle();
    assert.deepEqual(t.daemon.of("prompt").map((p) => p.message), ["first while away", "second while away", "back again"]);
    assert.match(t.chat.postsIn(room.id).map((p) => p.body).join("\n"), /↪ 2 messages written here while toriel was not listening/);
    await t.bridge.catchUpNow();
    assert.equal(t.daemon.of("prompt").length, 3, "nothing is sent twice");
  });
  it("is found by the periodic look when no later message arrives", async () => {
    const t = await setup();
    t.daemon.sessions([meta()]);
    await t.bridge.idle();
    const room = t.chat.roomByName("fix-the-build") as { id: string };
    t.chat.deliver = false;
    t.chat.say(room.id, "lost to the dropped connection");
    await t.bridge.catchUpNow();
    assert.deepEqual(t.daemon.of("prompt").map((p) => p.message), ["lost to the dropped connection"]);
    assert.match(t.chat.postsIn(room.id).map((p) => p.body).join("\n"), /↪ 1 message written here/);
  });
  it("ignores other users' messages and threads, as it does live", async () => {
    const t = await setup();
    t.daemon.sessions([meta()]);
    await t.bridge.idle();
    const room = t.chat.roomByName("fix-the-build") as { id: string };
    t.chat.deliver = false;
    t.chat.say(room.id, "from a stranger", { userId: "stranger" });
    t.chat.say(room.id, "from the owner");
    await t.bridge.catchUpNow();
    assert.deepEqual(t.daemon.of("prompt").map((p) => p.message), ["from the owner"]);
    await t.bridge.catchUpNow();
    assert.equal(t.logs.filter((l) => /ignored a message from user stranger/.test(l)).length, 1, "said once, not on every look");
  });
  it("still delivers a live message when the channel cannot be read, and does not guess when the cursor is gone", async () => {
    const t = await setup();
    t.daemon.sessions([meta()]);
    await t.bridge.idle();
    const room = t.chat.roomByName("fix-the-build") as { id: string };
    t.chat.failFetch = true;
    t.chat.say(room.id, "live one");
    await t.bridge.idle();
    assert.deepEqual(t.daemon.of("prompt").map((p) => p.message), ["live one"]);
    t.chat.failFetch = false;
    t.chat.written.length = 0; // the message the cursor points at is gone from the server
    t.chat.deliver = false;
    t.chat.say(room.id, "behind a lost cursor");
    await t.bridge.catchUpNow();
    await t.bridge.catchUpNow();
    await t.bridge.catchUpNow();
    assert.equal(t.daemon.of("prompt").length, 1, "nothing is sent on a guess");
    assert.equal(t.logs.filter((l) => /not among the latest/.test(l)).length, 1, "said once, not on every look");
  });
  it("is caught up when the channel comes back after the bridge restarted", async () => {
    const t = await setup();
    t.daemon.sessions([meta()]);
    await t.bridge.idle();
    const room = t.chat.roomByName("fix-the-build") as { id: string };
    t.chat.say(room.id, "before");
    await t.bridge.idle();
    // the bridge dies without closing anything; a message is written while it is gone
    t.chat.deliver = false;
    t.chat.say(room.id, "written while the bridge was down");
    const again = await setup(t.chat, t.dir);
    again.daemon.sessions([meta()]);
    await again.bridge.idle();
    assert.deepEqual(again.daemon.of("prompt").map((p) => p.message), ["written while the bridge was down"]);
  });
});

describe("a channel name an archived channel still holds", () => {
  it("is not an error: the channel takes the next free name", async () => {
    const t = await setup();
    const old = await t.chat.createRoom("g1", "fix-the-build", "an old closed channel");
    await t.chat.archiveRoom(old.id); // archived rooms are not in the room list, but they keep their names
    t.daemon.sessions([meta()]);
    await t.bridge.idle();
    const room = t.chat.roomByName("fix-the-build-2");
    assert.ok(room, "made under the next name");
    assert.ok(t.chat.postsIn(room.id).some((p) => /Published/.test(p.body)));
    assert.ok(t.logs.some((l) => /is taken by a closed channel/.test(l)));
  });
  it("renames to a free name when the session's new name is held by a closed channel", async () => {
    const t = await setup();
    t.daemon.sessions([meta()]);
    await t.bridge.idle();
    const held = await t.chat.createRoom("g1", "shiny-new-name", "");
    await t.chat.archiveRoom(held.id);
    t.daemon.sessions([meta({ sessionName: "Shiny New Name" })]);
    await t.bridge.idle();
    assert.ok(t.chat.roomByName("shiny-new-name-2"));
    assert.equal(t.logs.filter((l) => /failed/.test(l)).length, 0);
  });
});

describe("a session whose closed channel is still there", () => {
  it("reopens it by its tag instead of making another, and keeps its name", async () => {
    const t = await setup();
    const old = await t.chat.createRoom("g1", "an-older-name", "closed [toriel:uuid-1]");
    await t.chat.archiveRoom(old.id);
    t.daemon.sessions([meta({ sessionName: "An Older Name" })]);
    await t.bridge.idle();
    assert.equal([...t.chat.rooms.values()].length, 2, "the inbox and the old channel; none was made");
    const room = t.chat.rooms.get(old.id);
    assert.equal(room?.archived, false);
    assert.ok(t.chat.postsIn(old.id).some((p) => /Published again/.test(p.body)));
    assert.match(room?.description ?? "", /\[toriel:uuid-1\]$/);
    assert.ok(t.logs.some((l) => /found for session 1 by its tag/.test(l)));
  });
  it("leaves a closed channel of another session alone", async () => {
    const t = await setup();
    const other = await t.chat.createRoom("g1", "someone-elses", "closed [toriel:uuid-other]");
    await t.chat.archiveRoom(other.id);
    t.daemon.sessions([meta()]);
    await t.bridge.idle();
    assert.equal(t.chat.rooms.get(other.id)?.archived, true);
    assert.ok(t.chat.roomByName("fix-the-build"));
  });
});

describe("when something goes wrong", () => {
  it("says a channel could not be made in the inbox and to the daemon, and the other sessions still get theirs", async () => {
    const t = await setup();
    t.chat.createFails = "[permission_denied] you may not create rooms here";
    t.daemon.sessions([meta(), meta({ id: 2, sessionId: "uuid-2", sessionName: "Second One" })]);
    await t.bridge.idle();
    const inbox = t.chat.roomByName("inbox") as { id: string };
    const said = t.chat.postsIn(inbox.id).map((p) => p.body).filter((b) => b.startsWith("⚠"));
    assert.equal(said.length, 2, "one line for each session");
    assert.match(said[0], /could not open the channel for "Fix The Build": \[permission_denied\]/);
    const status = t.daemon.of("chat_status").filter((r) => r.problem);
    assert.equal(status.length, 2);
    assert.equal(status[0].session, 1);
    assert.equal(status[1].session, 2);
    assert.ok(t.logs.some((l) => /could not open the channel for "Fix The Build" failed/.test(l)));
  });
  it("says it once, tries again, and tells the daemon when it works", async () => {
    const t = await setup();
    t.chat.createFails = "server error";
    t.daemon.sessions([meta()]);
    await t.bridge.idle();
    t.daemon.sessions([meta()]); // the next list: tried again, the same problem, not said again
    await t.bridge.idle();
    const inbox = t.chat.roomByName("inbox") as { id: string };
    assert.equal(t.chat.postsIn(inbox.id).filter((p) => p.body.startsWith("⚠")).length, 1);
    assert.equal(t.daemon.of("chat_status").filter((r) => r.problem).length, 1);
    t.chat.createFails = undefined;
    t.daemon.sessions([meta()]);
    await t.bridge.idle();
    assert.ok(t.chat.roomByName("fix-the-build"));
    const last = t.daemon.of("chat_status").at(-1);
    assert.equal(last?.problem, undefined, "cleared");
    assert.equal(last?.up, true);
  });
  it("tells the session's own channel when the trouble is in it, and does not echo the daemon's note back", async () => {
    const t = await setup();
    t.daemon.sessions([meta()]);
    await t.bridge.idle();
    const room = t.chat.roomByName("fix-the-build") as { id: string };
    t.daemon.failures.set("prompt", "the session cannot be started");
    t.chat.say(room.id, "hello");
    await t.bridge.idle();
    assert.ok(t.chat.postsIn(room.id).some((p) => /could not send that: the session cannot be started/.test(p.body)));
    const before = t.chat.postsIn(room.id).length;
    t.daemon.push({ type: "notice", session: 1, text: "chat bridge: something it already said", durable: true });
    await t.bridge.idle();
    assert.equal(t.chat.postsIn(room.id).length, before);
  });
  it("says a session could not be started from the inbox, in the inbox", async () => {
    const t = await setup();
    t.daemon.failures.set("spawn", "no more sessions allowed");
    const inbox = t.chat.roomByName("inbox") as { id: string };
    t.chat.say(inbox.id, "start something");
    await t.bridge.idle();
    assert.ok(t.chat.postsIn(inbox.id).some((p) => /⚠ could not start a session: no more sessions allowed/.test(p.body)));
  });
});

describe("telling the daemon where the channels are", () => {
  it("sends the open channels' names when they change, and not again when they do not", async () => {
    const t = await setup();
    t.daemon.sessions([meta()]);
    await t.bridge.idle();
    assert.deepEqual(t.daemon.of("chat_channels").at(-1)?.channels, { "uuid-1": "fix-the-build" });
    const count = t.daemon.of("chat_channels").length;
    t.daemon.sessions([meta()]);
    await t.bridge.idle();
    assert.equal(t.daemon.of("chat_channels").length, count, "unchanged, not repeated");
    t.daemon.sessions([meta({ published: undefined })]);
    await t.bridge.idle();
    assert.deepEqual(t.daemon.of("chat_channels").at(-1)?.channels, {}, "a closed channel is gone from it");
  });
});

describe("failure paths (review of ticket 283)", () => {
  it("retries an open that failed after the pinned post without posting it, or skipping the history, again", async () => {
    const t = await setup();
    t.daemon.histories.set(1, { total: 1, turns: [turn("user", "hello", 10)] });
    t.chat.failPost = (b) => /^✅ \*\*Published/.test(b);
    t.daemon.sessions([meta()]);
    await t.bridge.idle();
    t.chat.failPost = undefined;
    t.daemon.sessions([meta()]);
    await t.bridge.idle();
    const room = t.chat.roomByName("fix-the-build") as { id: string };
    const bodies = t.chat.postsIn(room.id).map((p) => p.body);
    assert.equal(bodies.filter((b) => /_session uuid-1_/.test(b)).length, 1, "one pinned post");
    assert.equal(t.chat.pins.length, 1);
    assert.equal(bodies.filter((b) => b === "> **you:** hello").length, 1, "the history once");
    assert.equal(bodies.filter((b) => /Published/.test(b)).length, 1, "and the acknowledgement once, at the end");
  });
  it("does not lose history turns whose post failed", async () => {
    const t = await setup();
    t.daemon.histories.set(1, { total: 1, turns: [turn("user", "hello", 10)] });
    t.chat.failPost = (b) => b === "> **you:** hello";
    t.daemon.sessions([meta()]);
    await t.bridge.idle();
    const rec = JSON.parse(fs.readFileSync(path.join(t.dir, "state.json"), "utf8")).channels["uuid-1"];
    assert.equal(rec.mirroredAt, undefined, "the mark did not move past what was not shown");
  });
  it("tells the daemon the problem is over when the session that had it is gone", async () => {
    const t = await setup();
    t.chat.createFails = "boom";
    t.daemon.sessions([meta()]);
    await t.bridge.idle();
    t.daemon.sessions([]); // the session went away while its channel was failing
    await t.bridge.idle();
    const last = t.daemon.of("chat_status").at(-1);
    assert.equal(last?.problem, undefined);
  });
  it("sends a problem on one line", async () => {
    const t = await setup();
    t.chat.createFails = "bad gateway\n<html>\n\u0007page</html>";
    t.daemon.sessions([meta()]);
    await t.bridge.idle();
    const sent = t.daemon.of("chat_status").find((r) => r.problem)?.problem as string;
    assert.ok(sent && !/\p{Cc}/u.test(sent), sent);
    const inbox = t.chat.roomByName("inbox") as { id: string };
    assert.ok(t.chat.postsIn(inbox.id).every((p) => !/\n.*(<html>)/.test(p.body)));
  });
  it("finds the message of a crash, not the frame under it", () => {
    const trace = ["file:///x/bridge/main.ts:12", "    throw new Error(\"the group Toriel does not exist\");", "    ^", "", "Error: the group Toriel does not exist", "    at start (file:///x/bridge/bridge.ts:90:11)", "    at async main (file:///x/bridge/main.ts:5:3)", "", "Node.js v22.18.0"];
    assert.equal(crashReason(trace), "Error: the group Toriel does not exist");
    assert.equal(crashReason(["bridge up", "listening"]), "listening");
    assert.equal(crashReason([]), undefined);
  });
  it("starts a session from the first message of a channel the bridge had not been told about", async () => {
    const t = await setup();
    const made = await t.chat.createRoom("g1", "brand-new-room", ""); // no room event is delivered
    t.chat.say(made.id, "first words");
    await t.bridge.idle();
    assert.deepEqual(t.daemon.of("spawn").map((r) => r.name), ["Brand New Room"]);
    assert.deepEqual(t.daemon.of("prompt").map((r) => r.message), ["first words"]);
  });
  it("keeps the first message of a session whose prompt failed, and sends it when the session is listed", async () => {
    const t = await setup();
    t.daemon.failures.set("prompt", "the session is busy starting");
    const inbox = t.chat.roomByName("inbox") as { id: string };
    t.chat.say(inbox.id, "do the thing");
    await t.bridge.idle();
    assert.equal(t.daemon.of("spawn").length, 1);
    assert.ok(t.chat.postsIn(inbox.id).some((p) => /could not send the first message/.test(p.body)));
    t.daemon.failures.delete("prompt");
    t.daemon.sessions([meta({ id: 100, sessionId: "uuid-new", sessionName: "Do The Thing", published: undefined })]);
    await t.bridge.idle();
    assert.deepEqual(t.daemon.of("prompt").map((r) => r.message), ["do the thing", "do the thing"], "sent again");
    assert.equal(t.daemon.of("prompt")[1].session, 100);
  });
});
