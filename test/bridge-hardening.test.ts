// Findings of the first bridge review (ticket 278) and the second (ticket 283): permission prompts in toriel's layout, a dead chat
// connection, steps that never finish, and the smaller failure paths.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { Bridge, SetupError } from "../src/bridge/bridge.ts";
import { connectDaemon } from "../src/bridge/daemon-client.ts";
import { bridgeEnv } from "../src/daemon-chat.ts";
import type { ChattoSettings } from "../src/settings.ts";
import { cleanSource } from "../src/util.ts";
import { FakeChat, FakeDaemon, meta, RON } from "./fake-chatto.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

const settings: ChattoSettings = { url: "https://chat.example.com", tokenEnv: "X", group: "Toriel", inboxChannel: "inbox", allowedUsers: [RON], defaultCwd: "/work", addUsers: [RON] };

async function setup(over: Record<string, unknown> = {}, chat = new FakeChat()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-hard-"));
  dirs.push(dir);
  const daemon = new FakeDaemon();
  const logs: string[] = [];
  const bridge = new Bridge({ adapter: chat, daemon, settings, stateFile: path.join(dir, "state.json"), log: (t) => logs.push(t), retryMs: 0, ...over });
  await bridge.start();
  return { chat, daemon, bridge, logs, dir };
}

async function openSession(t: Awaited<ReturnType<typeof setup>>) {
  t.daemon.sessions([meta()]);
  await t.bridge.idle();
  return t.chat.roomByName("fix-the-build") as { id: string };
}

const ask = (over: Record<string, unknown> = {}) => ({
  id: "p1",
  method: "select",
  title: "Permission Required\ntool: bash",
  options: ["Yes", "Yes, and allow for this session", "No", "No, provide reason"],
  toriel: { grants: [{ surface: "bash", pattern: "git status" }] },
  ...over,
});

describe("a permission prompt in chat is toriel's, as on the desktop", () => {
  it("offers toriel's rows, hides pi's own session row, and a grant row keeps the grant and answers Yes", async () => {
    const t = await setup();
    const room = await openSession(t);
    t.daemon.push({ type: "ui_request", session: 1, request: ask() });
    await t.bridge.idle();
    const post = t.chat.postsIn(room.id).at(-1);
    assert.ok(post);
    assert.match(post.body, /1\. Yes, this once/);
    assert.match(post.body, /2\. Yes, and allow "git status" for 1 hour/);
    assert.match(post.body, /3\. Yes, and allow "git status" for this session, kept across restarts/);
    assert.match(post.body, /4\. No\n/);
    assert.match(post.body, /5\. No, with a reason/);
    assert.doesNotMatch(post.body, /pi's own/, "no in-memory session row when there is a grant to offer");
    t.chat.react$(room.id, post.id, "two");
    await t.bridge.idle();
    assert.deepEqual(t.daemon.of("permission_add"), [{ type: "permission_add", session: 1, surface: "bash", pattern: "git status", for: "1h", source: "dialog" }]);
    assert.deepEqual(t.daemon.of("ui_response").map((r) => (r.response as { value: string }).value), ["Yes"]);
  });
  it("answers pi in its own words for the plain rows", async () => {
    const t = await setup();
    const room = await openSession(t);
    t.daemon.push({ type: "ui_request", session: 1, request: ask() });
    await t.bridge.idle();
    const post = t.chat.postsIn(room.id).at(-1) as { id: string };
    t.chat.react$(room.id, post.id, "five"); // "No, with a reason" is pi's "No, provide reason"
    await t.bridge.idle();
    assert.deepEqual(t.daemon.of("ui_response").map((r) => (r.response as { value: string }).value), ["No, provide reason"]);
    assert.equal(t.daemon.of("permission_add").length, 0);
  });
  it("names the grant's file-path prompt so the daemon can make it, and leaves the prompt open when the grant cannot be kept", async () => {
    const t = await setup();
    const room = await openSession(t);
    t.daemon.failures.set("permission_add", "no such prompt");
    t.daemon.push({ type: "ui_request", session: 1, request: ask({ toriel: { grants: [{ surface: "path_write", pattern: "/work/*" }] } }) });
    await t.bridge.idle();
    const post = t.chat.postsIn(room.id).at(-1) as { id: string };
    t.chat.react$(room.id, post.id, "two");
    await t.bridge.idle();
    assert.equal(t.daemon.of("permission_add")[0].dialog, "p1");
    assert.equal(t.daemon.of("ui_response").length, 0, "pi was not answered");
    assert.ok(t.chat.postsIn(room.id).some((p) => /could not keep the permission grant \(the prompt is still open\): no such prompt/.test(p.body)));
  });
  it("with no grant to offer shows pi's own session row, labelled, and an ask about protected files only offers once and no", async () => {
    const t = await setup();
    const room = await openSession(t);
    t.daemon.push({ type: "ui_request", session: 1, request: ask({ toriel: {} }) });
    await t.bridge.idle();
    assert.match(t.chat.postsIn(room.id).at(-1)?.body ?? "", /2\. Yes, and allow for this session \(pi's own: lost on restart\)/);
    t.daemon.push({ type: "ui_resolved", session: 1, id: "p1", by: "user" });
    t.daemon.push({ type: "ui_request", session: 1, request: ask({ id: "p2", toriel: { protectedAsk: true, denyAt: Date.now() + 60_000 } }) });
    await t.bridge.idle();
    const body = t.chat.postsIn(room.id).at(-1)?.body ?? "";
    assert.doesNotMatch(body, /Yes, and allow/);
    assert.match(body, /never kept/);
    assert.match(body, /Denied automatically at/);
  });
});

describe("a chat connection that dies", () => {
  it("is a problem in the status line while it is down, and a catch-up when it is back", async () => {
    const t = await setup();
    const room = await openSession(t);
    t.chat.setStatus(false);
    await t.bridge.idle();
    assert.match(String(t.daemon.of("chat_status").at(-1)?.problem), /the chat server is not reachable/);
    t.chat.deliver = false; // written while the connection was down: no event ever comes
    t.chat.say(room.id, "sent from the train");
    t.daemon.sessions([meta()]); // a sync while down must not clear the problem
    await t.bridge.idle();
    assert.match(String(t.daemon.of("chat_status").at(-1)?.problem), /not reachable/);
    t.chat.setStatus(true);
    await t.bridge.idle();
    assert.equal(t.daemon.of("chat_status").at(-1)?.problem, undefined, "cleared");
    assert.deepEqual(t.daemon.of("prompt").map((p) => p.message), ["sent from the train"]);
  });
});

describe("a step that never finishes", () => {
  it("is given up on, said, and the queue goes on", async () => {
    const t = await setup({ stepTimeoutMs: 30 });
    const inbox = t.chat.roomByName("inbox") as { id: string };
    t.chat.hangList = true;
    await t.bridge.discoverNow(); // resolves: the hung look was given up on
    t.chat.hangList = false;
    assert.ok(t.logs.some((l) => /discover failed: took longer than/.test(l)));
    t.chat.say(inbox.id, "still listening");
    await t.bridge.idle();
    assert.equal(t.daemon.of("spawn").length, 1);
  });
  it("makes a daemon request give up when the daemon never answers", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-sock-"));
    dirs.push(dir);
    const sock = path.join(dir, "d.sock");
    const server = net.createServer((c) => {
      c.once("data", (d) => {
        const id = (JSON.parse(String(d).split("\n")[0]) as { id: string }).id;
        c.write(`${JSON.stringify({ type: "response", id, ok: true })}\n`); // the first line (list) is answered, the rest are not
      });
    });
    await new Promise<void>((r) => server.listen(sock, r));
    try {
      const port = await connectDaemon(sock, 80);
      await assert.rejects(port.request({ type: "list" }), /did not answer list in 0 s/);
      port.close();
    } finally {
      server.close();
    }
  });
});

describe("the smaller failure paths", () => {
  it("refuses an attachment with no text instead of starting an empty prompt", async () => {
    const t = await setup();
    const room = await openSession(t);
    const inbox = t.chat.roomByName("inbox") as { id: string };
    t.chat.say(inbox.id, "", { attachments: [{ id: "a1", name: "x.png", mimeType: "image/png" }] });
    t.chat.say(room.id, "  ", { attachments: [{ id: "a2", name: "y.png", mimeType: "image/png" }] });
    await t.bridge.idle();
    assert.equal(t.daemon.of("spawn").length, 0);
    assert.equal(t.daemon.of("prompt").length, 0);
    assert.ok(t.chat.postsIn(inbox.id).some((p) => /can't read images/.test(p.body)));
    assert.ok(t.chat.postsIn(room.id).some((p) => /can't read images/.test(p.body)));
  });
  it("does not close a channel because who is in it could not be read", async () => {
    const t = await setup();
    const made = await t.chat.createRoom("g1", "just-made", "");
    t.chat.membersFail = true;
    await t.bridge.discoverNow();
    assert.equal(t.chat.rooms.get(made.id)?.archived, false);
    t.chat.membersFail = false;
    t.chat.memberIds.set(made.id, ["stranger"]);
    await t.bridge.discoverNow();
    assert.equal(t.chat.rooms.get(made.id)?.archived, true, "decided on the next look, with the members known");
  });
  it("calls a missing room group a setup problem", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-setup-"));
    dirs.push(dir);
    const bridge = new Bridge({ adapter: new FakeChat(), daemon: new FakeDaemon(), settings: { ...settings, group: "Nowhere" }, stateFile: path.join(dir, "s.json"), log: () => undefined });
    await assert.rejects(bridge.start(), (err) => err instanceof SetupError && /Nowhere/.test(err.message));
  });
  it("keeps a client's source label to a short word", () => {
    assert.equal(cleanSource("chatto"), "chatto");
    assert.equal(cleanSource("my-client_2"), "my-client_2");
    assert.equal(cleanSource("evil\nINJECTED"), undefined);
    assert.equal(cleanSource("x".repeat(33)), undefined);
    assert.equal(cleanSource(5), undefined);
  });
  it("gives the bridge what it needs of the environment and not the rest", () => {
    const env = bridgeEnv({ PATH: "/bin", HOME: "/home/u", XDG_CONFIG_HOME: "/c", TORIEL_SOCK: "/s", NODE_OPTIONS: "--x", MY_CHAT_TOKEN: "t", ANTHROPIC_API_KEY: "secret", AWS_SECRET_ACCESS_KEY: "secret", HTTPS_PROXY: "http://p" }, "MY_CHAT_TOKEN");
    assert.deepEqual(Object.keys(env).sort(), ["HOME", "HTTPS_PROXY", "MY_CHAT_TOKEN", "NODE_OPTIONS", "PATH", "TORIEL_SOCK", "XDG_CONFIG_HOME"]);
    assert.equal(bridgeEnv({ PATH: "/bin", MY_CHAT_TOKEN: "t" }).MY_CHAT_TOKEN, undefined, "only when tokenEnv names it");
  });
});
