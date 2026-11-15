import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Host } from "../src/host.ts";
import { SessionActions } from "../src/session-actions.ts";

const KEY = "/tmp/fake/session.jsonl";
const CTRL_S = "\x13";

/** A host whose daemon answers clear_queue with `queued` and everything else with {}, recording the order of what happened. */
function fakeHost(meta: Record<string, unknown> | undefined, queue: string[], queued: string[] = queue, failAbort = false) {
  const order: string[] = [];
  const notices: string[] = [];
  let editor = "";
  const view = { echoes: [] as string[], queue: [...queue] };
  const host = {
    viewing: KEY,
    editor: { getText: () => editor, setText: (t: string) => (editor = t), addToHistory: () => undefined },
    views: new Map([[KEY, view]]),
    metaForPath: () => meta,
    notify: (m: string) => notices.push(m),
    tui: { requestRender: () => undefined },
    request: (cmd: { type: string }) => {
      order.push(cmd.type);
      if (cmd.type === "abort" && failAbort) {
        return Promise.reject(new Error("daemon went away"));
      }
      return Promise.resolve(cmd.type === "clear_queue" ? { steering: queued, followUp: [] } : {});
    },
    send: (cmd: { type: string }) => order.push(`send:${cmd.type}`),
  };
  const sa = new SessionActions(host as unknown as Host);
  const prompts: string[] = [];
  (sa as unknown as { prompt: (t: string) => Promise<boolean> }).prompt = async (t) => {
    order.push("prompt");
    prompts.push(t);
    return true;
  };
  return { sa, order, notices, prompts, view, editor: () => editor };
}

describe("ctrl-s: send the queued messages now (ticket 222)", () => {
  it("takes the queue, stops the run, then sends the texts together, in that order", async () => {
    const f = fakeHost({ id: 7, streaming: true, attachedToYou: true }, ["use the other file", "and say why"]);
    assert.equal(f.sa.keys(CTRL_S), true);
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(f.order, ["clear_queue", "abort", "prompt"], "the queue is emptied before the abort, so nothing is delivered twice");
    assert.deepEqual(f.prompts, ["use the other file\n\nand say why"]);
    assert.deepEqual(f.view.queue, [], "the queued rows are gone");
  });

  it("is left alone when nothing is queued, or the session is not yours", () => {
    const idle = fakeHost({ id: 7, streaming: true, attachedToYou: true }, []);
    assert.equal(idle.sa.keys(CTRL_S), false);
    assert.deepEqual(idle.order, []);
    const elsewhere = fakeHost({ id: 7, streaming: true, attachedToYou: false }, ["x"]);
    assert.equal(elsewhere.sa.keys(CTRL_S), false);
    assert.deepEqual(elsewhere.order, []);
  });

  it("does nothing, and says so, when the run already delivered the queue", async () => {
    const f = fakeHost({ id: 7, streaming: true, attachedToYou: true }, ["late"], []);
    f.sa.keys(CTRL_S);
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(f.order, ["clear_queue"], "no abort of a run that no longer has anything to interrupt for");
    assert.match(f.notices.join("\n"), /already delivered/);
  });

  it("puts the texts back in the editor when the run cannot be stopped", async () => {
    const f = fakeHost({ id: 7, streaming: true, attachedToYou: true }, ["keep me"], ["keep me"], true);
    f.sa.keys(CTRL_S);
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(f.order, ["clear_queue", "abort"]);
    assert.equal(f.editor(), "keep me");
    assert.match(f.notices.join("\n"), /could not stop the run/);
  });
});
