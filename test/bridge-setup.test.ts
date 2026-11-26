// Setup failures of the bridge (ticket 293): each says which step failed, about what, and what to do.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { Bridge, SetupError } from "../src/bridge/bridge.ts";
import type { ChattoSettings } from "../src/settings.ts";
import { FakeChat, FakeDaemon, RON } from "./fake-chatto.ts";

const settings: ChattoSettings = { url: "https://chat.example.com", tokenEnv: "X", group: "Toriel", inboxChannel: "inbox", allowedUsers: [RON], defaultCwd: "/work", addUsers: [RON] };
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function bridgeFor(chat: FakeChat, over: Partial<ChattoSettings> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-setup-"));
  dirs.push(dir);
  const logs: string[] = [];
  const bridge = new Bridge({ adapter: chat, daemon: new FakeDaemon(), settings: { ...settings, ...over }, stateFile: path.join(dir, "state.json"), log: (t) => logs.push(t) });
  return { bridge, logs };
}

const denied = () => Object.assign(new Error("[permission_denied] permission denied"), { code: 7, rawMessage: "permission denied" });

describe("bridge setup failures", () => {
  it("says the inbox name is taken by a room in another group, names that room, and points at chatto.inboxChannel", async () => {
    const chat = new FakeChat();
    chat.groups.set("Other", "g2");
    chat.otherRooms.push({ id: "r9", name: "inbox", archived: false, groupId: "g2" });
    const { bridge } = bridgeFor(chat);
    await assert.rejects(bridge.start(), (err) => {
      assert.ok(err instanceof SetupError, "not retried in a loop");
      assert.match(err.message, /could not create the inbox channel "inbox" in group "Toriel" \(g1\): a room with that name already exists in group "Other" \(g2\) \(room r9\)/);
      assert.match(err.message, /set chatto\.inboxChannel/);
      return true;
    });
  });

  it("explains an already_exists from a room the bot cannot see", async () => {
    const chat = new FakeChat();
    chat.hiddenNames.add("inbox");
    const { bridge } = bridgeFor(chat);
    await assert.rejects(bridge.start(), (err) => err instanceof SetupError && /^could not create the inbox channel "inbox" in group "Toriel" \(g1\): a room with that name already exists, and the bot cannot see it \(another toriel's inbox, perhaps, or archived where the bot cannot list it\)\. Room names are unique.*chatto\.inboxChannel/.test(err.message));
  });

  it("uses another inbox name when chatto.inboxChannel says so", async () => {
    const chat = new FakeChat();
    chat.hiddenNames.add("inbox");
    const { bridge } = bridgeFor(chat, { inboxChannel: "inbox-2" });
    await bridge.start();
    assert.ok([...chat.rooms.values()].some((r) => r.name === "inbox-2" && !r.archived));
    await bridge.shutdown();
  });

  it("reopens its own closed inbox instead of failing on the name it still holds, and lists its users again", async () => {
    const chat = new FakeChat();
    chat.rooms.set("old", { id: "old", name: "inbox", archived: true, description: "", members: false });
    const { bridge, logs } = bridgeFor(chat);
    await bridge.start();
    assert.equal(chat.rooms.get("old")?.archived, false);
    assert.equal([...chat.rooms.values()].filter((r) => r.name === "inbox").length, 1, "no second inbox");
    assert.deepEqual(chat.added, [["old", RON]], "the reopened channel has the users again");
    assert.ok(logs.some((l) => /reopened the inbox channel inbox/.test(l)));
    await bridge.shutdown();
  });

  it("names the step, the group and the missing permission when the bot may not create the inbox", async () => {
    const chat = new FakeChat();
    chat.createFails = "[permission_denied] permission denied";
    const { bridge, logs } = bridgeFor(chat);
    await assert.rejects(bridge.start(), (err) => err instanceof SetupError && /^could not create the inbox channel "inbox" in group "Toriel" \(g1\): permission denied\. The bot needs permission to create rooms in group "Toriel"/.test(err.message));
    assert.ok(logs.some((l) => /setup step "create the inbox channel .*" failed: .*"code":"permission_denied"/.test(l)), "the error's parts are logged");
  });

  it("names the step when listing the group's channels is refused", async () => {
    const chat = new FakeChat();
    chat.failOn.listRooms = denied();
    const { bridge } = bridgeFor(chat);
    await assert.rejects(bridge.start(), (err) => err instanceof SetupError && /^could not list the channels in group "Toriel" \(g1\): permission denied\. the bot's account lacks a permission/.test(err.message));
  });

  it("calls a refused token a setup problem and a server that is down one to try again", async () => {
    const refused = new FakeChat();
    refused.failOn.connect = new Error("[unauthenticated] invalid api key");
    await assert.rejects(bridgeFor(refused).bridge.start(), (err) => err instanceof SetupError && /^could not connect to the chat server at https:\/\/chat\.example\.com: unauthenticated: invalid api key\. the server refused the bot's token/.test(err.message));
    const down = new FakeChat();
    down.failOn.connect = new Error("[unavailable] connection refused");
    await assert.rejects(bridgeFor(down).bridge.start(), (err) => err instanceof Error && !(err instanceof SetupError) && /server did not answer/.test(err.message));
  });

  it("lists the groups the bot can see when the configured one is missing", async () => {
    const chat = new FakeChat();
    chat.groups.set("Toriel 2", "g2");
    const { bridge } = bridgeFor(chat, { group: "Nowhere" });
    await assert.rejects(bridge.start(), (err) => err instanceof SetupError && /"Nowhere" does not exist, or the bot cannot see it \(the bot can see: "Toriel", "Toriel 2"\).*set chatto\.group/.test(err.message));
  });

  it("retries a group the server knows but the client's room list does not have yet, instead of calling it setup", async () => {
    const chat = new FakeChat();
    chat.groups.set("Toriel", "g1");
    chat.findGroup = async () => undefined; // the projection fills in shortly after connecting; here it never got to
    const { bridge } = bridgeFor(chat);
    await assert.rejects(bridge.start(), (err) => {
      assert.ok(!(err instanceof SetupError), "the daemon keeps restarting: not a setup problem");
      assert.ok(err instanceof Error && /"Toriel" is not in the room list of the client.*the bot can see the group without belonging to it/.test(err.message));
      return true;
    });
  });

  it("uses the group's own room the directory knows but the room list did not have yet", async () => {
    const chat = new FakeChat();
    chat.rooms.set("lag", { id: "lag", name: "inbox", archived: false, description: "", members: false });
    chat.listRooms = async () => []; // the room list is behind; the directory is not
    const { bridge, logs } = bridgeFor(chat);
    await bridge.start();
    assert.deepEqual([...chat.rooms.values()].filter((r) => r.name === "inbox").length, 1, "no second inbox");
    assert.ok(chat.rooms.get("lag")?.members, "joined");
    assert.ok(logs.some((l) => /did not have it yet/.test(l)));
    await bridge.shutdown();
  });
});
