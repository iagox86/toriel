// A permission prompt's toriel rows ("allow for 1 hour"): picking one answers pi with its plain
// "Yes" and stores the grant through the daemon; pi's own rows and the arrival guard are untouched.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DialogPanel, type DialogRequest, withGrantRows, withOrigin } from "../src/dialogs.ts";
import type { Host } from "../src/host.ts";
import { SessionActions } from "../src/session-actions.ts";
import type { SessionView } from "../src/transcript.ts";

const KEY = "/tmp/fake/session.jsonl";
const ask: DialogRequest = {
  id: "g1",
  method: "select",
  title: "Permission Required\ntool    : bash\ncommand : sudo -V",
  options: ["Yes", 'Yes, allow bash "sudo -V" for this session', "No", "No, provide reason"],
  toriel: { grants: [{ surface: "bash", pattern: "sudo -V" }] },
};

function setup(over: { shownAgoMs?: number; fail?: boolean } = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const requests: Array<Record<string, unknown>> = [];
  const notices: string[] = [];
  const panel = new DialogPanel();
  const dialog = { ...withGrantRows(withOrigin(ask, 4, "Mealie"), ["1h", "session"]), shownAt: Date.now() - (over.shownAgoMs ?? 5000) };
  const view = { dialog } as unknown as SessionView;
  panel.sync(dialog);
  const host = {
    viewing: KEY,
    dialogPanel: panel,
    editor: { getText: () => "", setText: () => {} },
    metaForPath: () => ({ id: 4, attachedToYou: true }),
    send: (cmd: Record<string, unknown>) => void sent.push(cmd),
    request: (cmd: Record<string, unknown>) => {
      requests.push(cmd);
      return over.fail ? Promise.reject(new Error("the daemon is gone")) : Promise.resolve({ echo: 'granted bash "sudo -V" for 1 hour' });
    },
    notify: (m: string) => void notices.push(m),
    renderChrome: () => {},
  };
  return { sa: new SessionActions(host as unknown as Host), view, sent, requests, notices, dialog };
}

/** The value a ui_response sent to pi carried. */
const answered = (cmd: Record<string, unknown> | undefined): unknown => (cmd?.response as { value?: unknown } | undefined)?.value;
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("permission prompt: toriel's grant rows", () => {
  it("answers pi with a plain Yes and stores a timed grant when the hour row is picked", async () => {
    const t = setup();
    assert.equal(t.sa.dialogKeys(t.view, "5"), true);
    await settle();
    assert.deepEqual(t.sent, [{ type: "ui_response", session: 4, response: { type: "extension_ui_response", id: "g1", value: "Yes" } }]);
    assert.deepEqual(t.requests, [{ type: "permission_add", session: 4, surface: "bash", pattern: "sudo -V", for: "1h", source: "dialog" }]);
    assert.deepEqual(t.notices, ['granted bash "sudo -V" for 1 hour']);
    assert.equal(t.view.dialog, undefined);
  });

  it("stores a grant without expiry for the kept-across-restarts row", async () => {
    const t = setup();
    t.sa.dialogKeys(t.view, "6");
    await settle();
    assert.equal(t.requests[0]?.for, "session");
    assert.equal(answered(t.sent[0]), "Yes");
  });

  it("works from the highlighted row with enter", async () => {
    const t = setup();
    for (let i = 0; i < 4; i++) {
      t.sa.dialogKeys(t.view, "\x1b[B"); // down to the first toriel row
    }
    assert.equal(t.sa.dialogKeys(t.view, "\r"), true);
    await settle();
    assert.equal(t.requests[0]?.for, "1h");
  });

  it("leaves pi's own answers alone: no grant is stored for them", async () => {
    for (const [key, value] of [["1", "Yes"], ["2", 'Yes, allow bash "sudo -V" for this session'], ["3", "No"]] as const) {
      const t = setup();
      t.sa.dialogKeys(t.view, key);
      await settle();
      assert.equal(answered(t.sent[0]), value);
      assert.equal(t.requests.length, 0, key);
    }
  });

  it("treats escape as pi's No and stores nothing", async () => {
    const t = setup();
    t.sa.dialogKeys(t.view, "\x1b");
    await settle();
    assert.equal(answered(t.sent[0]), "No");
    assert.equal(t.requests.length, 0);
  });

  it("holds the pick back during the arrival guard, like any grant", async () => {
    const t = setup({ shownAgoMs: 100 });
    assert.equal(t.sa.dialogKeys(t.view, "5"), true);
    await settle();
    assert.deepEqual(t.sent, []);
    assert.deepEqual(t.requests, []);
    assert.ok(t.view.dialog, "the dialog stays up");
  });

  it("says so when the grant could not be stored, after pi was already answered Yes", async () => {
    const t = setup({ fail: true });
    t.sa.dialogKeys(t.view, "5");
    await settle();
    assert.equal(answered(t.sent[0]), "Yes");
    assert.match(t.notices[0] ?? "", /could not keep the permission grant: the daemon is gone/);
  });
});
