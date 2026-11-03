// toriel_agents waiting must not leave listeners behind on a long-lived controller socket.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type * as net from "node:net";
import { describe, it } from "node:test";
import type { Cmd, DaemonContext } from "../src/daemon-context.ts";
import { handleAgentsOp } from "../src/daemon-subagents.ts";
import { SubagentBook } from "../src/subagents.ts";

function setup(ends: boolean) {
  const book = new SubagentBook();
  const rec = book.add({ parent: "p", session: 1, agent: "explore", description: "look", background: true, budget: 1000 });
  const ctx = {
    subagents: {
      book,
      whenEnded: () => (ends ? Promise.resolve() : new Promise<void>(() => {})),
    },
  } as unknown as DaemonContext;
  const socket = new EventEmitter();
  const replies: unknown[] = [];
  const res = (_ok: boolean, _err?: string, data?: unknown) => void replies.push(data);
  return { ctx, rec, socket: socket as unknown as net.Socket, emitter: socket, replies, res };
}

const wait = (timeoutMs?: number): Cmd<"agents_op"> => ({ type: "agents_op", from: "p", action: "wait", ref: "#1", timeoutMs });

describe("toriel_agents wait", () => {
  it("removes its close listener when the subagent ends", async () => {
    const t = setup(true);
    await handleAgentsOp(t.ctx, wait(), t.socket, t.res);
    assert.equal(t.emitter.listenerCount("close"), 0);
    assert.equal(t.replies.length, 1);
  });

  it("removes its close listener when it times out", async () => {
    const t = setup(false);
    await handleAgentsOp(t.ctx, wait(30), t.socket, t.res);
    assert.equal(t.emitter.listenerCount("close"), 0);
    assert.match((t.replies[0] as { text: string }).text, /Timed out; still running/);
  });

  it("stops waiting without answering when the caller goes away, and leaves no listener", async () => {
    const t = setup(false);
    const pending = handleAgentsOp(t.ctx, wait(5000), t.socket, t.res);
    t.emitter.emit("close");
    await pending;
    assert.equal(t.emitter.listenerCount("close"), 0);
    assert.deepEqual(t.replies, []);
  });
});
