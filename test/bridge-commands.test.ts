// `/command` and `!command` typed in chat are the bridge's: the agent never sees them, and the commands chat has are done through
// the same daemon requests the desktop sends.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { Bridge } from "../src/bridge/bridge.ts";
import { CHAT_COMMANDS, CHAT_ONLY, chatHelp, parseChatCommand, torielCommandNames } from "../src/bridge/chat-commands.ts";
import { formatLocalCommand } from "../src/local-command.ts";
import type { ChattoSettings } from "../src/settings.ts";
import { FakeChat, FakeDaemon, meta, RON } from "./fake-chatto.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

const settings: ChattoSettings = { url: "https://chat.example.com", tokenEnv: "X", group: "Toriel", inboxChannel: "inbox", allowedUsers: [RON], defaultCwd: "/work", addUsers: [RON] };

async function setup(sessionMeta = meta()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cmd-"));
  dirs.push(dir);
  const chat = new FakeChat();
  const daemon = new FakeDaemon();
  const bridge = new Bridge({ adapter: chat, daemon, settings, stateFile: path.join(dir, "state.json"), log: () => undefined, retryMs: 0 });
  await bridge.start();
  daemon.sessions([sessionMeta]);
  await bridge.idle();
  const room = chat.roomByName("fix-the-build") as { id: string };
  const inbox = chat.roomByName("inbox") as { id: string };
  const last = (r = room) => chat.postsIn(r.id).at(-1)?.body ?? "";
  const write = async (text: string, r = room) => {
    chat.say(r.id, text);
    await bridge.idle();
  };
  return { chat, daemon, bridge, room, inbox, last, write };
}

describe("parseChatCommand", () => {
  it("takes /word, !word and !!word as the first word, and nothing that is only text", () => {
    assert.deepEqual(parseChatCommand("/abort"), { kind: "command", name: "abort", args: "" });
    assert.deepEqual(parseChatCommand("  !Model fast now "), { kind: "command", name: "model", args: "fast now" });
    assert.deepEqual(parseChatCommand("!!ls -la"), { kind: "shell", name: "", args: "ls -la" });
    assert.deepEqual(parseChatCommand("!!./run.sh /tmp/x"), { kind: "shell", name: "", args: "./run.sh /tmp/x" });
    assert.equal(parseChatCommand("/etc/hosts is wrong"), undefined, "a path");
    assert.equal(parseChatCommand("! really?"), undefined);
    assert.equal(parseChatCommand("!!!"), undefined);
    assert.equal(parseChatCommand("/"), undefined);
    assert.equal(parseChatCommand("fix /abort please"), undefined, "not the first word");
  });
});

describe("the registry", () => {
  it("names toriel commands (bar the chat-only ones), so help and the desktop cannot drift apart", () => {
    const toriel = torielCommandNames();
    for (const c of CHAT_COMMANDS) {
      assert.ok(CHAT_ONLY.has(c.name) || toriel.has(c.name), `${c.name} is not a toriel command`);
    }
    assert.match(chatHelp(true), /`!model \[words \| list\]`/);
    assert.doesNotMatch(chatHelp(false), /^- `!model/m);
  });
});

describe("commands never reach the agent", () => {
  it("answers an unknown /command in a session's channel", async () => {
    const t = await setup();
    await t.write("/unknowncommand with args");
    assert.equal(t.daemon.of("prompt").length, 0);
    assert.match(t.last(), /`unknowncommand` is not a command I know, and I never pass it to the agent/);
    assert.match(t.last(), /`!help`|Commands I handle here/);
  });

  it("says a toriel command chat lacks needs the desktop", async () => {
    const t = await setup();
    await t.write("!group work");
    assert.equal(t.daemon.of("prompt").length, 0);
    assert.match(t.last(), /`group` needs the desktop/);
  });

  it("runs !!command as the desktop's ! does, says what it printed, and never prompts the agent", async () => {
    const t = await setup();
    t.daemon.answers.set("bash", { output: "hello\n", exitCode: 0, cancelled: false, truncated: false });
    await t.write("!!echo hello");
    await new Promise((r) => setImmediate(r));
    await t.bridge.idle();
    assert.deepEqual(t.daemon.of("bash"), [{ type: "bash", session: 1, command: "echo hello" }]);
    assert.equal(t.daemon.of("prompt").length, 0);
    assert.ok(t.chat.postsIn(t.room.id).some((p) => /Running `echo hello`/.test(p.body)));
    assert.match(t.last(), /exit 0\n```\nhello\n```/);
  });

  it("does not post the wrapper the daemon injects: not for a !! the bridge ran, and a console ! shows as a command and output", async () => {
    const t = await setup();
    const inject = (command: string, output: string) =>
      t.daemon.push({ type: "event", session: 1, event: { type: "message_end", message: { role: "user", content: formatLocalCommand(command, { output, exitCode: 0, cancelled: false, truncated: false }) } } });
    t.daemon.answers.set("bash", { output: "hello\n", exitCode: 0, cancelled: false, truncated: false });
    await t.write("!!echo hello");
    inject("echo hello", "hello\n");
    await new Promise((r) => setImmediate(r));
    await t.bridge.idle();
    const before = t.chat.postsIn(t.room.id).length;
    assert.ok(!t.chat.postsIn(t.room.id).some((p) => p.body.includes("local-command")));
    inject("ls /tmp", "a\nb\n");
    await t.bridge.idle();
    const posts = t.chat.postsIn(t.room.id);
    assert.equal(posts.length, before + 1);
    assert.match(posts[posts.length - 1].body, /ran in toriel:\*\* `ls \/tmp` \(exit 0\)\n> ```\n> a\n> b\n> ```/);
    assert.ok(!posts.some((p) => p.body.includes("local-command")));
  });

  it("a !! command does not hold up the bridge, and !abort stops it", async () => {
    const t = await setup();
    let finish: (v: unknown) => void = () => undefined;
    t.daemon.answers.set("bash", () => new Promise((r) => { finish = r; }));
    await t.write("!!sleep 100");
    await t.write("!status");
    assert.match(t.last(), /Fix The Build/, "another command is answered while it runs");
    await t.write("!!echo again");
    assert.match(t.last(), /already running here/);
    await t.write("!abort");
    assert.deepEqual(t.daemon.of("abort_bash"), [{ type: "abort_bash", session: 1 }]);
    finish({ output: "", exitCode: undefined, cancelled: true, truncated: false });
    await new Promise((r) => setImmediate(r));
    assert.match(t.last(), /stopped/);
  });

  it("a !! command in the inbox says where it works, and a failure is said", async () => {
    const t = await setup();
    await t.write("!!ls", t.inbox);
    assert.equal(t.daemon.of("bash").length, 0);
    assert.match(t.last(t.inbox), /for a session's channel/);
    t.daemon.failures.set("bash", "session is compacting");
    await t.write("!!ls");
    await new Promise((r) => setImmediate(r));
    assert.match(t.last(), /⚠ `ls` failed: session is compacting/);
  });

  it("does not start a session from a command in the inbox, and a session command there says where it works", async () => {
    const t = await setup();
    await t.write("/new please", t.inbox);
    assert.equal(t.daemon.of("spawn").length, 0);
    assert.equal(t.daemon.of("prompt").length, 0);
    await t.write("!model", t.inbox);
    assert.match(t.last(t.inbox), /for a session's channel/);
    await t.write("!list", t.inbox);
    assert.match(t.last(t.inbox), /1 session:\n- \*\*Fix The Build\*\* — idle · in chat/);
    await t.write("a real request", t.inbox);
    assert.equal(t.daemon.of("spawn").length, 1);
  });

  it("sends a path that only starts with a slash as the prompt it is", async () => {
    const t = await setup();
    await t.write("/etc/hosts is wrong");
    assert.equal(t.daemon.of("prompt").length, 1);
  });

  it("does not run a command that was written while the bridge was away", async () => {
    const t = await setup();
    t.chat.deliver = false;
    t.chat.say(t.room.id, "!abort");
    t.chat.say(t.room.id, "hello");
    t.chat.deliver = true;
    t.chat.say(t.room.id, "after");
    await t.bridge.idle();
    assert.equal(t.daemon.of("abort").length, 0);
    assert.ok(t.chat.postsIn(t.room.id).some((p) => /Not run: `abort` was written while toriel was not listening/.test(p.body)));
  });
});

describe("the commands chat has", () => {
  it("/help and !help list them; abort interrupts only a working session", async () => {
    const t = await setup();
    await t.write("/help");
    assert.match(t.last(), /`!abort`/);
    await t.write("!abort");
    assert.match(t.last(), /Nothing is running/);
    assert.equal(t.daemon.of("abort").length, 0);
    t.daemon.sessions([meta({ streaming: true })]);
    await t.bridge.idle();
    await t.write("/abort");
    assert.deepEqual(t.daemon.of("abort"), [{ type: "abort", session: 1 }]);
    assert.equal(t.daemon.of("prompt").length, 0);
  });

  it("auto, plan and deny-after are the daemon's requests, with status answered from the list", async () => {
    const t = await setup();
    t.daemon.answers.set("deny_after", { ms: 600000 });
    await t.write("!auto 30m");
    await t.write("!auto off");
    await t.write("!plan on");
    await t.write("!deny-after 10m");
    assert.deepEqual(t.daemon.of("auto_mode"), [
      { type: "auto_mode", session: 1, on: true, for: "30m" },
      { type: "auto_mode", session: 1, on: false, for: undefined },
    ]);
    assert.deepEqual(t.daemon.of("plan_mode"), [{ type: "plan_mode", session: 1, on: true }]);
    assert.equal(t.daemon.of("deny_after").length, 1);
    assert.match(t.last(), /Deny-after is \*\*10m/);
    await t.write("!auto status");
    assert.match(t.last(), /Auto mode is off/);
    await t.write("!plan maybe");
    assert.match(t.last(), /takes `on`, `off` or `status`/);
  });

  it("model with words switches; with nine or fewer models it asks, answered by a reaction or a number", async () => {
    const t = await setup();
    t.daemon.answers.set("model", (c: Record<string, unknown>) => (c.query ? { model: `prov/${String(c.query)}` } : { current: "prov/a", models: ["prov/a", "prov/b", "prov/c"] }));
    await t.write("!model sonnet");
    assert.match(t.last(), /Model: \*\*prov\/sonnet/);
    await t.write("!model");
    const ask = t.chat.postsIn(t.room.id).at(-1);
    assert.ok(ask);
    assert.match(ask.body, /2\. prov\/b/);
    assert.deepEqual([...ask.reactions].sort(), ["one", "three", "two", "x"]);
    t.chat.react$(t.room.id, ask.id, "two");
    await t.bridge.idle();
    assert.deepEqual(t.daemon.of("model").at(-1), { type: "model", session: 1, query: "prov/b" });
    assert.deepEqual([...ask.reactions], ["two"], "the other rows' reactions are taken back");
    await t.write("!model");
    await t.write("3");
    assert.deepEqual(t.daemon.of("model").at(-1), { type: "model", session: 1, query: "prov/c" });
    assert.equal(t.daemon.of("prompt").length, 0, "a typed number answers the question, it is not a prompt");
  });

  it("a question can be dismissed with the red cross or by writing cancel, and nothing is run", async () => {
    const t = await setup();
    t.daemon.answers.set("model", { current: "prov/a", models: ["prov/a", "prov/b"] });
    await t.write("!model");
    const ask = t.chat.postsIn(t.room.id).at(-1);
    assert.ok(ask);
    t.chat.react$(t.room.id, ask.id, "x");
    await t.bridge.idle();
    assert.match(t.chat.postsIn(t.room.id).find((p) => p.id === ask.id)?.body ?? "", /→ cancelled/);
    assert.equal(ask.reactions.size, 0);
    assert.equal(t.daemon.of("model").length, 1, "nothing was switched");
    await t.write("!model");
    const again = t.chat.postsIn(t.room.id).at(-1);
    await t.write("cancel");
    assert.match(t.chat.postsIn(t.room.id).find((p) => p.id === again?.id)?.body ?? "", /→ cancelled/);
    assert.equal(t.daemon.of("prompt").length, 0, "writing cancel is not a prompt");
  });

  it("a long model list is posted as text, not asked", async () => {
    const t = await setup();
    t.daemon.answers.set("model", { current: "p/m1", models: Array.from({ length: 12 }, (_, i) => `p/m${i + 1}`) });
    await t.write("!model");
    assert.match(t.last(), /Model: \*\*p\/m1\*\*[\s\S]*p\/m12/);
  });

  it("starts a sleeping session before a command that needs pi, and stays out of it while it works", async () => {
    const t = await setup(meta({ active: false, sessionFile: "/s/a.jsonl" }));
    t.daemon.answers.set("think", { current: "low", levels: ["off", "low", "high"] });
    await t.write("!think");
    assert.deepEqual(t.daemon.of("spawn")[0], { type: "spawn", sessionFile: "/s/a.jsonl", cwd: "/work/proj", ready: true });
    assert.deepEqual(t.daemon.of("think")[0], { type: "think", session: 100 });
    t.daemon.sessions([meta({ streaming: true })]);
    await t.bridge.idle();
    await t.write("!clear");
    assert.equal(t.daemon.of("clear").length, 0);
    assert.match(t.last(), /It is working: `!abort` first/);
  });

  it("name renames, keeping names unique; stop and continue and init", async () => {
    const t = await setup();
    await t.write("!name Better Name");
    assert.deepEqual(t.daemon.of("rename"), [{ type: "rename", session: 1, name: "Better Name" }]);
    await t.write("!name");
    assert.match(t.last(), /Name: Fix The Build/);
    await t.write("!stop");
    assert.deepEqual(t.daemon.of("deactivate"), [{ type: "deactivate", session: 1 }]);
    await t.write("!continue and run the tests");
    assert.match(String(t.daemon.of("prompt")[0]?.message), /run the tests/);
    await t.write("!init");
    assert.match(String(t.daemon.of("prompt")[1]?.message), /AGENTS\.md/);
  });

  it("a command's failure is said in the channel", async () => {
    const t = await setup();
    t.daemon.failures.set("cd", "no such directory");
    await t.write("!cd /nowhere");
    assert.match(t.last(), /⚠ `cd` failed: no such directory/);
  });

  it("permissions lists and revokes by the listed id", async () => {
    const t = await setup();
    t.daemon.answers.set("permission_revoke", { count: 1, grants: [] });
    await t.write("!permissions revoke 2");
    assert.deepEqual(t.daemon.of("permission_revoke"), [{ type: "permission_revoke", session: 1, ref: "2" }]);
    assert.match(t.last(), /Revoked 1 grant/);
    await t.write("!permissions");
    assert.equal(t.daemon.of("permission_list").length, 1);
  });
});

describe("the typing indicator follows the session list (ticket 284)", () => {
  it("starts when a channel opens for a session that is already working", async () => {
    const t = await setup(meta({ streaming: true }));
    assert.ok(t.chat.typings.includes(t.room.id));
  });

  it("starts when the session list says a published session with a channel is working", async () => {
    const t = await setup();
    assert.equal(t.chat.typings.length, 0);
    t.daemon.sessions([meta({ streaming: true })]);
    await t.bridge.idle();
    assert.ok(t.chat.typings.includes(t.room.id));
  });
});
