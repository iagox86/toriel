// A prompt typed while pi is busy is shown by the queue strip; echoing it into the transcript as well showed it twice
// (seen while compacting: the pasted request appeared as a message and again as "queued").
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Host } from "../src/host.ts";
import { SessionActions } from "../src/session-actions.ts";

const KEY = "/tmp/fake/session.jsonl";

function run(meta: Record<string, unknown>, text: string) {
  const echoes: string[] = [];
  const requests: Array<Record<string, unknown>> = [];
  const host = {
    viewing: KEY,
    editor: { getText: () => text, setText: () => undefined, addToHistory: () => undefined },
    attachments: { take: (t: string) => ({ text: t, images: [] as string[] }), put: (i: string) => i },
    notify: () => undefined,
    echoPrompt: (_key: string, sent: string) => echoes.push(sent),
    dropEcho: () => undefined,
    metaForPath: () => ({ id: 7, attachedToYou: true, ...meta }),
    request: (cmd: Record<string, unknown>) => {
      requests.push(cmd);
      return Promise.resolve({});
    },
  };
  return { sa: new SessionActions(host as unknown as Host), echoes, requests };
}

describe("echoing a sent prompt into the transcript", () => {
  it("echoes it when the session is idle", async () => {
    const r = run({ streaming: false, compacting: false }, "hello");
    await r.sa.prompt("hello");
    assert.deepEqual(r.echoes, ["hello"]);
    assert.equal(r.requests.length, 1);
  });

  it("does not echo it mid-run: the queue strip shows it", async () => {
    const r = run({ streaming: true, compacting: false }, "steer");
    await r.sa.prompt("steer");
    assert.deepEqual(r.echoes, []);
    assert.equal(r.requests.length, 1, "it is still sent");
  });

  it("does not echo it while compacting either: pi queues it then too", async () => {
    const r = run({ streaming: false, compacting: true }, "a long review request");
    await r.sa.prompt("a long review request");
    assert.deepEqual(r.echoes, []);
    assert.equal(r.requests.length, 1, "it is still sent, and lands when the compaction ends");
  });
});
