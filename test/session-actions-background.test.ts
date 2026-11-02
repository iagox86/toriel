import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Host } from "../src/host.ts";
import { SessionActions } from "../src/session-actions.ts";

const KEY = "/tmp/fake/session.jsonl";
const CTRL_B = "\x02";

function fakeHost(meta: Record<string, unknown> | undefined, echoes = 0) {
  const requests: Array<Record<string, unknown>> = [];
  const sent: Array<Record<string, unknown>> = [];
  const notices: string[] = [];
  const host = {
    viewing: KEY,
    editor: { getText: () => "" },
    views: new Map([[KEY, { echoes: new Array(echoes).fill("x"), queue: [] }]]),
    metaForPath: () => meta,
    notify: (m: string) => {
      notices.push(m);
    },
    request: (cmd: Record<string, unknown>) => {
      requests.push(cmd);
      return Promise.resolve({});
    },
    send: (cmd: Record<string, unknown>) => {
      sent.push(cmd);
    },
  };
  return { host: host as unknown as Host, requests, sent, notices };
}

describe("ctrl-b", () => {
  it("asks the daemon to move the running command to the background while the agent works", () => {
    const fh = fakeHost({ id: 7, streaming: true, attachedToYou: true });
    assert.equal(new SessionActions(fh.host).keys(CTRL_B), true);
    assert.deepEqual(fh.requests, [{ type: "background", session: 7 }]);
  });

  it("counts a prompt just sent as working", () => {
    const fh = fakeHost({ id: 7, streaming: false, attachedToYou: true }, 1);
    new SessionActions(fh.host).keys(CTRL_B);
    assert.equal(fh.requests.length, 1);
  });

  it("is left to the editor (cursor left) when the agent is idle", () => {
    const fh = fakeHost({ id: 7, streaming: false, attachedToYou: true });
    assert.equal(new SessionActions(fh.host).keys(CTRL_B), false);
    assert.deepEqual(fh.requests, []);
  });
});

describe("/background", () => {
  it("says so, and asks nothing, when the agent is idle", () => {
    const fh = fakeHost({ id: 7, streaming: false, attachedToYou: true });
    // the command is the same code path as the key; idle means no request and a notice
    const sa = new SessionActions(fh.host) as unknown as { commands: { background(): void } };
    sa.commands.background();
    assert.deepEqual(fh.requests, []);
    assert.match(fh.notices[0] ?? "", /nothing is running here/);
  });

  it("says so, and asks nothing, in a session another controller is attached to", () => {
    const fh = fakeHost({ id: 7, streaming: true, attachedToYou: false });
    const sa = new SessionActions(fh.host) as unknown as { commands: { background(): void } };
    sa.commands.background();
    assert.deepEqual(fh.requests, []);
  });
});
