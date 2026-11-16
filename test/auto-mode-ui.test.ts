// shift+tab and /auto on the controller side (ticket 213): what reaches the daemon, and when the key stays the editor's.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Host } from "../src/host.ts";
import { SessionActions } from "../src/session-actions.ts";

const KEY = "/tmp/fake/session.jsonl";
const SHIFT_TAB = "\x1b[Z";

function fakeHost(meta: Record<string, unknown> | undefined, completing = false) {
  const requests: Array<Record<string, unknown>> = [];
  const notices: string[] = [];
  const host = {
    viewing: KEY,
    editor: { getText: () => "", isShowingAutocomplete: () => completing },
    views: new Map([[KEY, { echoes: [], queue: [] }]]),
    metaForPath: () => meta,
    notify: (m: string) => {
      notices.push(m);
    },
    request: (cmd: Record<string, unknown>) => {
      requests.push(cmd);
      return Promise.resolve({});
    },
    send: () => {},
  };
  return { host: host as unknown as Host, requests, notices };
}

const auto = (sa: SessionActions, text?: string) => (sa as unknown as { commands: { auto(t?: string): Promise<void> } }).commands.auto(text);

describe("shift+tab", () => {
  const press = async (meta: Record<string, unknown>) => {
    const fh = fakeHost({ attachedToYou: true, ...meta });
    assert.equal(new SessionActions(fh.host).keys(SHIFT_TAB), true);
    await new Promise((r) => setTimeout(r, 5));
    return fh.requests;
  };

  it("cycles normal, auto, plan and back for the viewed session (ticket 233)", async () => {
    assert.deepEqual(await press({ id: 7, sessionId: "u" }), [{ type: "auto_mode", session: 7, on: true }], "normal -> auto");
    assert.deepEqual(await press({ id: 7, sessionId: "u", auto: true }), [
      { type: "plan_mode", session: 7, on: true },
      { type: "auto_mode", session: 7, on: false },
    ], "auto -> plan: the two are exclusive");
    assert.deepEqual(await press({ id: 7, sessionId: "u", plan: true }), [{ type: "plan_mode", session: 7, on: false }], "plan -> normal");
    assert.deepEqual(await press({ id: 7, sessionId: "u", plan: true, auto: true }), [
      { type: "plan_mode", session: 7, on: false },
      { type: "auto_mode", session: 7, on: false },
    ], "both on (set by commands) -> normal");
  });

  it("skips plan for a session that has no id yet, since plan mode is named by it", async () => {
    assert.deepEqual(await press({ id: 7, auto: true }), [{ type: "auto_mode", session: 7, on: false }]);
  });

  it("stays the editor's while a completion popup is open, and when there is no session yet", () => {
    const open = fakeHost({ id: 7 }, true);
    assert.equal(new SessionActions(open.host).keys(SHIFT_TAB), false);
    assert.deepEqual(open.requests, []);
    const none = fakeHost(undefined);
    assert.equal(new SessionActions(none.host).keys(SHIFT_TAB), false);
    assert.deepEqual(none.requests, []);
  });

  it("does nothing while a permission prompt is open", () => {
    const fh = fakeHost({ id: 7, attachedToYou: true });
    (fh.host.views.get(KEY) as unknown as { dialog: unknown }).dialog = { id: "d", method: "select" };
    assert.equal(new SessionActions(fh.host).keys(SHIFT_TAB), false);
    assert.deepEqual(fh.requests, []);
  });
});

describe("/auto", () => {
  it("sends on, off, a duration, or nothing (a toggle)", async () => {
    const fh = fakeHost({ id: 7 });
    const sa = new SessionActions(fh.host);
    for (const text of ["", "on", "off", "on 2h", "2h", "on 90 minutes"]) {
      await auto(sa, text);
    }
    assert.deepEqual(
      fh.requests.map((r) => [r.on, r.for]),
      [
        [undefined, undefined],
        [true, undefined],
        [false, undefined],
        [true, "2h"],
        [true, "2h"],
        [true, "90 minutes"],
      ],
    );
  });

  it("says whether it is on, without asking the daemon", async () => {
    const off = fakeHost({ id: 7 });
    await auto(new SessionActions(off.host), "status");
    assert.deepEqual(off.requests, []);
    assert.match(off.notices[0] ?? "", /auto mode is off/);
    const on = fakeHost({ id: 7, auto: true, autoUntil: new Date(2026, 10, 14, 15, 30).getTime() });
    await auto(new SessionActions(on.host), "status");
    assert.match(on.notices[0] ?? "", /auto mode is ON until /);
  });

  it("needs a session, and reports a daemon that does not know the command", async () => {
    const none = fakeHost(undefined);
    await auto(new SessionActions(none.host));
    assert.deepEqual(none.requests, []);
    assert.match(none.notices[0] ?? "", /needs a session/);
    const fh = fakeHost({ id: 7 });
    fh.host.request = () => Promise.reject(new Error("request timed out"));
    await auto(new SessionActions(fh.host));
    assert.match(fh.notices[0] ?? "", /no answer from the daemon.*kill-server/);
    fh.host.request = () => Promise.reject(new Error("cannot read \"soon\" as a duration"));
    await auto(new SessionActions(fh.host), "soon");
    assert.match(fh.notices[1] ?? "", /auto mode failed: cannot read "soon"/);
  });
});
