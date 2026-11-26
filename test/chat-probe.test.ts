import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { probeChat } from "../src/bridge/probe.ts";
import { FakeChat } from "./fake-chatto.ts";

const s = { url: "https://chat.example.com", group: "Toriel", inboxChannel: "inbox" };

describe("doctor's chat-server probe", () => {
  it("finds nothing wrong on a server that has what the bridge needs, and changes nothing", async () => {
    const chat = new FakeChat();
    assert.deepEqual(await probeChat(chat, s), []);
    assert.equal(chat.rooms.size, 0, "nothing created");
    assert.equal(chat.posts.length, 0, "nothing posted");
  });

  it("says a refused token is refused", async () => {
    const chat = new FakeChat();
    chat.failOn.connect = new Error("[unauthenticated] invalid api key");
    const [p] = await probeChat(chat, s);
    assert.match(p ?? "", /^the chat bridge cannot connect to the chat server at https:\/\/chat\.example\.com: unauthenticated: invalid api key\. the server refused the bot's token/);
  });

  it("names the groups the bot can see when the configured one is not among them", async () => {
    const chat = new FakeChat();
    const [p] = await probeChat(chat, { ...s, group: "Toriel 2" });
    assert.match(p ?? "", /room group "Toriel 2" does not exist, or the bot cannot see it \(the bot can see "Toriel"\).*chatto\.group/);
  });

  it("says the inbox name is held by a room in another group", async () => {
    const chat = new FakeChat();
    chat.groups.set("Other", "g2");
    chat.otherRooms.push({ id: "r9", name: "Inbox", archived: true, groupId: "g2" });
    const [p] = await probeChat(chat, s);
    assert.match(p ?? "", /inbox name "inbox" is taken by a room in group "Other" \(archived\).*set chatto\.inboxChannel/);
  });

  it("does not object to the bridge's own inbox, open or closed", async () => {
    const chat = new FakeChat();
    chat.rooms.set("old", { id: "old", name: "inbox", archived: true, description: "", members: false });
    assert.deepEqual(await probeChat(chat, s), []);
  });

  it("reports a create-rooms permission the server says the bot lacks, and is quiet when it is granted", async () => {
    const chat = new FakeChat();
    chat.groupPermissions.set("g1", { "room.create": false, "message.post": true });
    const [p] = await probeChat(chat, s);
    assert.match(p ?? "", /may not create rooms in the chat group "Toriel" \(the server reports room\.create not granted\)/);
    chat.groupPermissions.set("g1", { "room.create": true });
    assert.deepEqual(await probeChat(chat, s), []);
  });

  it("names the step when looking at the group is refused", async () => {
    const chat = new FakeChat();
    chat.failOn.listRooms = new Error("[permission_denied] permission denied");
    const [p] = await probeChat(chat, s);
    assert.match(p ?? "", /^the chat bridge cannot look at the room group "Toriel": permission denied\. the bot's account lacks a permission/);
  });

  it("does not fail the whole check on a directory the bot cannot read", async () => {
    const chat = new FakeChat();
    chat.failOn.listGroups = new Error("[permission_denied] permission denied");
    chat.rooms.set("g", { id: "g", name: "g", archived: false, description: "", members: false });
    assert.deepEqual(await probeChat(chat, s), [], "the group is found and the rest of the checks still run");
    const [p] = await probeChat(chat, { ...s, group: "Toriel 2" });
    assert.match(p ?? "", /room group "Toriel 2" does not exist.*or the list could not be read/);
  });
});
