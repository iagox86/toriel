import assert from "node:assert/strict";
import type * as net from "node:net";
import { describe, it } from "node:test";
import { ClientHub } from "../src/daemon-hub.ts";
import type { SessionMeta } from "../src/shared.ts";

/** A socket that records what is written to it. */
function fakeSocket(): { socket: net.Socket; lines: () => Array<{ type: string }> } {
  const written: string[] = [];
  const socket = { destroyed: false, write: (s: string) => written.push(s) } as unknown as net.Socket;
  return { socket, lines: () => written.map((w) => JSON.parse(w) as { type: string }) };
}

describe("ClientHub.broadcastSessions", () => {
  it("sends one list per controller for any number of requests in one turn", async () => {
    let builds = 0;
    const hub = new ClientHub(() => {
      builds++;
      return [] as SessionMeta[];
    });
    const a = fakeSocket();
    const b = fakeSocket();
    hub.addController(a.socket);
    hub.addController(b.socket);
    for (let i = 0; i < 10; i++) {
      hub.broadcastSessions();
    }
    assert.equal(a.lines().length, 0, "nothing is sent before the turn ends");
    await Promise.resolve();
    assert.equal(a.lines().length, 1);
    assert.equal(b.lines().length, 1);
    assert.equal(builds, 2, "the list is built once per controller");
    hub.broadcastSessions();
    await Promise.resolve();
    assert.equal(a.lines().length, 2, "a later turn sends again");
  });

  it("sends the hello first to a controller that connects while a list is pending", () => {
    const hub = new ClientHub(() => [], { type: "hello" } as never);
    const a = fakeSocket();
    hub.broadcastSessions();
    hub.addController(a.socket);
    hub.sendHello(a.socket);
    assert.equal(a.lines()[0]?.type, "hello");
  });

  it("sends a pending list before any other message, so controllers see things in the order they were asked for", () => {
    const hub = new ClientHub(() => []);
    const a = fakeSocket();
    hub.addController(a.socket);
    hub.broadcastSessions();
    hub.broadcast({ type: "event", session: 1, event: { type: "x" } } as never);
    assert.deepEqual(a.lines().map((l) => l.type), ["sessions", "event"]);
  });
});
