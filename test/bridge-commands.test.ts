// `/command` and `!command` typed in chat are the bridge's: the agent never sees them.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { Bridge } from "../src/bridge/bridge.ts";
import { parseChatCommand } from "../src/bridge/chat-commands.ts";
import type { ChattoSettings } from "../src/settings.ts";
import { FakeChat, FakeDaemon, meta, RON } from "./fake-chatto.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

const settings: ChattoSettings = { url: "https://chat.example.com", tokenEnv: "X", group: "Toriel", inboxChannel: "inbox", allowedUsers: [RON], defaultCwd: "/work", addUsers: [RON] };

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cmd-"));
  dirs.push(dir);
  const chat = new FakeChat();
  const daemon = new FakeDaemon();
  const bridge = new Bridge({ adapter: chat, daemon, settings, stateFile: path.join(dir, "state.json"), log: () => undefined, retryMs: 0 });
  await bridge.start();
  daemon.sessions([meta()]);
  await bridge.idle();
  return { chat, daemon, bridge, room: chat.roomByName("fix-the-build") as { id: string }, inbox: chat.roomByName("inbox") as { id: string } };
}

describe("parseChatCommand", () => {
  it("takes /word and !word as the first word, and nothing that is only text", () => {
    assert.deepEqual(parseChatCommand("/abort"), { kind: "slash", name: "abort", args: "" });
    assert.deepEqual(parseChatCommand("  /model fast now "), { kind: "slash", name: "model", args: "fast now" });
    assert.deepEqual(parseChatCommand("!ls -la"), { kind: "bang", name: "ls", args: "-la" });
    assert.equal(parseChatCommand("/etc/hosts is wrong"), undefined, "a path");
    assert.equal(parseChatCommand("! really?"), undefined);
    assert.equal(parseChatCommand("!!!"), undefined);
    assert.equal(parseChatCommand("/"), undefined);
    assert.equal(parseChatCommand("fix /abort please"), undefined, "not the first word");
  });
});

describe("commands in chat", () => {
  it("answers an unknown /command in a session's channel and never prompts the agent", async () => {
    const t = await setup();
    t.chat.say(t.room.id, "/unknowncommand with args");
    await t.bridge.idle();
    assert.equal(t.daemon.of("prompt").length, 0);
    assert.match(t.chat.postsIn(t.room.id).at(-1)?.body ?? "", /`\/unknowncommand` is not a command I handle here/);
  });

  it("answers a !command the same way", async () => {
    const t = await setup();
    t.chat.say(t.room.id, "!rm -rf /");
    await t.bridge.idle();
    assert.equal(t.daemon.of("prompt").length, 0);
    assert.match(t.chat.postsIn(t.room.id).at(-1)?.body ?? "", /`!` commands are not available/);
  });

  it("does not start a session from a command in the inbox or in an empty channel", async () => {
    const t = await setup();
    t.chat.say(t.inbox.id, "/new please");
    await t.bridge.idle();
    assert.equal(t.daemon.of("spawn").length, 0);
    assert.equal(t.daemon.of("prompt").length, 0);
    assert.match(t.chat.postsIn(t.inbox.id).at(-1)?.body ?? "", /not a command I handle here/);
    t.chat.say(t.inbox.id, "a real request");
    await t.bridge.idle();
    assert.equal(t.daemon.of("spawn").length, 1);
  });

  it("sends a path that only starts with a slash as the prompt it is", async () => {
    const t = await setup();
    t.chat.say(t.room.id, "/etc/hosts is wrong");
    await t.bridge.idle();
    assert.equal(t.daemon.of("prompt").length, 1);
  });

  it("/help lists the commands; /abort interrupts a running session", async () => {
    const t = await setup();
    t.chat.say(t.room.id, "/help");
    await t.bridge.idle();
    assert.match(t.chat.postsIn(t.room.id).at(-1)?.body ?? "", /`\/abort`/);
    t.chat.say(t.room.id, "/abort");
    await t.bridge.idle();
    assert.equal(t.daemon.of("abort").length, 1);
    assert.equal(t.daemon.of("prompt").length, 0);
  });
});
