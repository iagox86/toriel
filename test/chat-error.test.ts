import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chatErrorText, describeChatError, isSetupCode, redactUrl, setupFailureText } from "../src/bridge/chat-error.ts";

/** What @connectrpc's ConnectError looks like from outside: numeric code, rawMessage, details, `[code] text` message. */
function connectError(code: number, raw: string, details: unknown[] = []): Error {
  const names: Record<number, string> = { 6: "already_exists", 7: "permission_denied", 14: "unavailable", 16: "unauthenticated" };
  return Object.assign(new Error(`[${names[code]}] ${raw}`), { name: "ConnectError", code, rawMessage: raw, details, metadata: new Headers({ authorization: "Bearer SECRET" }) });
}

describe("chat errors", () => {
  it("reads the code, the server's text and its details from a Connect error", () => {
    const info = describeChatError(connectError(7, "missing room.create", [{ type: "chatto.Denied", debug: { permission: "room.create" } }]));
    assert.deepEqual(info, { code: "permission_denied", text: "missing room.create", detail: 'chatto.Denied: {"permission":"room.create"}' });
  });

  it("reads a plain `[code] text` message and a thrown non-error", () => {
    assert.deepEqual(describeChatError(new Error("[already_exists] a room with this name already exists on this server")), { code: "already_exists", text: "a room with this name already exists on this server" });
    assert.deepEqual(describeChatError("boom"), { text: "boom" });
  });

  it("never carries the request headers, where the token is", () => {
    assert.doesNotMatch(JSON.stringify(describeChatError(connectError(16, "bad token"))), /SECRET/);
  });

  it("does not repeat a text that only restates the code", () => {
    assert.equal(chatErrorText(describeChatError(connectError(7, "permission denied"))), "permission denied");
    assert.equal(chatErrorText({ code: "already_exists", text: "taken" }), "already exists: taken");
  });

  it("names the step and says what to do, preferring the step's own advice", () => {
    const err = connectError(7, "permission denied");
    assert.equal(setupFailureText('create the inbox channel "inbox"', err, { permission_denied: "The bot needs permission to create rooms" }), 'could not create the inbox channel "inbox": permission denied. The bot needs permission to create rooms');
    assert.match(setupFailureText("connect", connectError(16, "invalid api key")), /^could not connect: unauthenticated: invalid api key\. the server refused the bot's token/);
    assert.equal(setupFailureText("connect", new Error("socket hang up")), "could not connect: socket hang up");
    assert.equal(setupFailureText("connect", new Error("socket hang up"), { "*": "check chatto.url" }), "could not connect: socket hang up. check chatto.url", "a step's fallback for an error with no code");
    assert.match(setupFailureText("connect", connectError(16, "bad"), { "*": "fallback" }), /refused the bot's token/, "the fallback does not override a code's advice");
  });

  it("keeps the sentence to one line", () => {
    assert.equal(setupFailureText("connect", new Error("line one\nline two")), "could not connect: line one line two");
    assert.doesNotMatch(setupFailureText("connect", connectError(7, "multi\nline\ntext")), /\n/);
  });

  it("does not show the url's user and password", () => {
    assert.equal(redactUrl("https://bot:secret@chat.example.com"), "https://chat.example.com");
    assert.equal(redactUrl("https://chat.example.com"), "https://chat.example.com");
    assert.equal(redactUrl("http://chat.example.com/path"), "http://chat.example.com/path");
  });

  it("calls a refused token, a missing permission or a taken name a setup problem, and a server that is down not one", () => {
    assert.ok(isSetupCode("permission_denied"));
    assert.ok(isSetupCode("already_exists"));
    assert.ok(isSetupCode("unauthenticated"));
    assert.ok(!isSetupCode("unavailable"));
    assert.ok(!isSetupCode(undefined));
  });
});
