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

const PARENT_KEY = "/tmp/fake/parent.jsonl";

/** `owner`: the dialog belongs to a subagent (daemon id 9) but is shown, and answered, while viewing its parent (daemon id 1). */
/** A file-path prompt: pi's own four options and the one grant it suggested (the file's directory). */
const pathAsk: DialogRequest = {
  id: "g1",
  method: "select",
  title: "Permission Required\ntool    : write\npath    : /p/deep/docs/a.md",
  options: ["Yes", 'Yes, allow path_write "/p/deep/docs/*" for this session', "No", "No, provide reason"],
  toriel: { grants: [{ surface: "path_write", pattern: "/p/deep/docs/*" }] },
};

function setup(over: { shownAgoMs?: number; fail?: boolean; owner?: boolean; path?: boolean } = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const requests: Array<Record<string, unknown>> = [];
  const notices: string[] = [];
  const panel = new DialogPanel();
  const dialog = { ...withGrantRows(withOrigin(over.path ? pathAsk : ask, 4, "Mealie"), ["1h", "session"]), shownAt: Date.now() - (over.shownAgoMs ?? 5000) };
  const view = { dialog } as unknown as SessionView;
  panel.sync(dialog);
  const host = {
    viewing: over.owner ? PARENT_KEY : KEY,
    dialogPanel: panel,
    editor: { getText: () => "", setText: () => {} },
    metaForPath: (key: string) => (over.owner ? (key === KEY ? { id: 9, attachedToYou: false } : { id: 1, attachedToYou: true }) : { id: 4, attachedToYou: true }),
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

  it("swallows tab so the input box completion never opens over a pending prompt", () => {
    const t = setup();
    assert.equal(t.sa.dialogKeys(t.view, "\t"), true);
    assert.deepEqual(t.sent, []);
    assert.ok(t.view.dialog, "the prompt stays open");
  });
});

describe("a file-path prompt: toriel's rows and the pattern edit", () => {
  const BACKSPACE = "\x7f";
  const down = (t: ReturnType<typeof setup>, n: number) => {
    for (let i = 0; i < n; i++) {
      t.sa.dialogKeys(t.view, "\x1b[B");
    }
  };

  it("stores the grant against the open prompt first, then answers pi Yes", async () => {
    const t = setup({ path: true });
    t.sa.dialogKeys(t.view, "5");
    assert.deepEqual(t.sent, [], "pi is not answered until the grant is kept");
    await settle();
    assert.deepEqual(t.requests, [{ type: "permission_add", session: 4, surface: "path_write", pattern: "/p/deep/docs/*", for: "1h", source: "dialog", dialog: "g1" }]);
    assert.equal(answered(t.sent[0]), "Yes");
    assert.equal(t.view.dialog, undefined);
  });

  it("keeps the prompt open, and pi unanswered, when the daemon refuses the grant", async () => {
    const t = setup({ path: true, fail: true });
    t.sa.dialogKeys(t.view, "5");
    await settle();
    assert.deepEqual(t.sent, []);
    assert.ok(t.view.dialog, "still asking");
    assert.match(t.notices.at(-1) ?? "", /could not keep the permission grant/);
  });

  it("lets you widen the directory, and stores what you typed", async () => {
    const t = setup({ path: true });
    down(t, 4);
    t.sa.dialogKeys(t.view, "\t");
    for (let i = 0; i < "deep/docs/*".length; i++) {
      t.sa.dialogKeys(t.view, BACKSPACE);
    }
    t.sa.dialogKeys(t.view, "*");
    t.sa.dialogKeys(t.view, "\r");
    await settle();
    assert.equal(t.requests[0]?.pattern, "/p/*");
    assert.equal(t.requests[0]?.dialog, "g1");
    assert.equal(answered(t.sent[0]), "Yes");
  });

  it("refuses a pattern that would not cover this very ask, and keeps editing", async () => {
    const t = setup({ path: true });
    down(t, 4);
    t.sa.dialogKeys(t.view, "\t");
    for (let i = 0; i < "/p/deep/docs/*".length; i++) {
      t.sa.dialogKeys(t.view, BACKSPACE);
    }
    for (const ch of "/q/*") {
      t.sa.dialogKeys(t.view, ch);
    }
    t.sa.dialogKeys(t.view, "\r");
    await settle();
    assert.deepEqual(t.requests, []);
    assert.deepEqual(t.sent, []);
    assert.match(t.notices.at(-1) ?? "", /does not cover "\/p\/deep\/docs\/\*"/);
    assert.ok(t.view.dialog);
  });

  it("leaves bash grants as they were: pi answered at once, no prompt id sent", async () => {
    const t = setup();
    t.sa.dialogKeys(t.view, "5");
    assert.equal(answered(t.sent[0]), "Yes", "answered before the store call");
    await settle();
    assert.equal("dialog" in (t.requests[0] ?? {}), false);
  });
});

describe("a subagent's prompt answered from its parent's view", () => {
  const BACKSPACE = "\x7f";

  it("stores the grant on the subagent, not on the parent being viewed", async () => {
    const t = setup({ owner: true });
    t.sa.dialogKeys(t.view, "5", KEY);
    await settle();
    assert.equal(t.sent[0]?.session, 9, "pi's Yes goes to the subagent");
    assert.equal(t.requests[0]?.session, 9, "and so does the grant");
    assert.equal(t.requests[0]?.surface, "bash");
  });

  it("does the same for a pattern typed after tab", async () => {
    const t = setup({ owner: true });
    for (let i = 0; i < 4; i++) {
      t.sa.dialogKeys(t.view, "\x1b[B", KEY);
    }
    t.sa.dialogKeys(t.view, "\t", KEY);
    t.sa.dialogKeys(t.view, BACKSPACE, KEY);
    t.sa.dialogKeys(t.view, "*", KEY);
    t.sa.dialogKeys(t.view, "\r", KEY);
    await settle();
    assert.equal(t.sent[0]?.session, 9);
    assert.deepEqual(t.requests.map((r) => [r.session, r.pattern]), [[9, "sudo -*"]]);
  });

  it("answers a typed deny reason on the subagent too", () => {
    const t = setup({ owner: true });
    for (let i = 0; i < 3; i++) {
      t.sa.dialogKeys(t.view, "\x1b[B", KEY);
    }
    t.sa.dialogKeys(t.view, "\t", KEY);
    t.sa.dialogKeys(t.view, "x", KEY);
    t.sa.dialogKeys(t.view, "\r", KEY);
    assert.equal(t.sent[0]?.session, 9);
    assert.equal(t.requests.length, 0, "a reason is not a grant");
  });
});

describe("permission prompt: editing the grant pattern (tab on a toriel row)", () => {
  const BACKSPACE = "\x7f";
  const type = (t: ReturnType<typeof setup>, text: string) => {
    for (const ch of text) {
      t.sa.dialogKeys(t.view, ch);
    }
  };

  it("pre-fills the suggested pattern and stores the typed one with the row's duration", async () => {
    const t = setup();
    t.sa.dialogKeys(t.view, "\x1b[B"); // 2
    t.sa.dialogKeys(t.view, "\x1b[B"); // 3
    t.sa.dialogKeys(t.view, "\x1b[B"); // 4
    t.sa.dialogKeys(t.view, "\x1b[B"); // 5: the 1h row
    assert.equal(t.sa.dialogKeys(t.view, "\t"), true);
    const panel = (t.sa as unknown as { h: { dialogPanel: DialogPanel } }).h.dialogPanel;
    assert.equal(panel.editing, "sudo -V");
    for (let i = 0; i < 2; i++) {
      t.sa.dialogKeys(t.view, BACKSPACE);
    }
    type(t, "*");
    assert.equal(panel.editing, "sudo *");
    t.sa.dialogKeys(t.view, "\r");
    await settle();
    assert.deepEqual(t.sent, [{ type: "ui_response", session: 4, response: { type: "extension_ui_response", id: "g1", value: "Yes" } }]);
    assert.deepEqual(t.requests, [{ type: "permission_add", session: 4, surface: "bash", pattern: "sudo *", for: "1h", source: "dialog" }]);
    assert.equal(t.view.dialog, undefined);
    assert.equal(panel.editing, null);
  });

  it("keeps the session lifetime of the row it was started on", async () => {
    const t = setup();
    for (let i = 0; i < 5; i++) {
      t.sa.dialogKeys(t.view, "\x1b[B"); // the session row
    }
    t.sa.dialogKeys(t.view, "\t");
    t.sa.dialogKeys(t.view, "\r");
    await settle();
    assert.equal(t.requests[0]?.for, "session");
    assert.equal(t.requests[0]?.pattern, "sudo -V", "enter on the untouched pre-fill stores the suggested pattern");
  });

  it("refuses an empty pattern and keeps the dialog open", async () => {
    const t = setup();
    for (let i = 0; i < 4; i++) {
      t.sa.dialogKeys(t.view, "\x1b[B");
    }
    t.sa.dialogKeys(t.view, "\t");
    for (let i = 0; i < "sudo -V".length; i++) {
      t.sa.dialogKeys(t.view, BACKSPACE);
    }
    t.sa.dialogKeys(t.view, "\r");
    await settle();
    assert.deepEqual(t.sent, []);
    assert.deepEqual(t.requests, []);
    assert.match(t.notices[0] ?? "", /cannot be empty/);
    assert.ok(t.view.dialog);
  });

  it("escape leaves the editor without answering", async () => {
    const t = setup();
    for (let i = 0; i < 4; i++) {
      t.sa.dialogKeys(t.view, "\x1b[B");
    }
    t.sa.dialogKeys(t.view, "\t");
    t.sa.dialogKeys(t.view, "\x1b");
    await settle();
    assert.deepEqual(t.sent, []);
    assert.deepEqual(t.requests, []);
    assert.ok(t.view.dialog);
  });

  it("does not offer editing on pi's own rows", () => {
    const t = setup();
    t.sa.dialogKeys(t.view, "\t"); // pi's "Yes" is highlighted
    const panel = (t.sa as unknown as { h: { dialogPanel: DialogPanel } }).h.dialogPanel;
    assert.equal(panel.editing, null);
  });

  it("does not offer editing when the ask carries several grants", () => {
    const t = setup();
    const two = { ...t.dialog, toriel: { grants: [{ surface: "bash", pattern: "a" }, { surface: "bash", pattern: "b" }] } };
    t.view.dialog = two;
    for (let i = 0; i < 4; i++) {
      t.sa.dialogKeys(t.view, "\x1b[B");
    }
    t.sa.dialogKeys(t.view, "\t");
    const panel = (t.sa as unknown as { h: { dialogPanel: DialogPanel } }).h.dialogPanel;
    assert.equal(panel.editing, null);
  });
});

describe("a subagent's dialog shown in its parent's view", () => {
  const PARENT = "/tmp/fake/parent.jsonl";
  const forwarded = () => {
    const t = setup();
    const host = (t.sa as unknown as { h: { viewing: string; metaForPath(k: string): unknown } }).h;
    host.viewing = PARENT;
    host.metaForPath = (k: string) => (k === KEY ? { id: 4, attachedToYou: false } : { id: 1, attachedToYou: true });
    return t;
  };

  it("answers the subagent's session, not the parent's, without the subagent being attached", async () => {
    const t = forwarded();
    assert.equal(t.sa.dialogKeys(t.view, "1", KEY), true);
    await settle();
    assert.deepEqual(t.sent, [{ type: "ui_response", session: 4, response: { type: "extension_ui_response", id: "g1", value: "Yes" } }]);
    assert.equal(t.view.dialog, undefined);
  });

  it("stores a picked grant row for the subagent's session", async () => {
    const t = forwarded();
    t.sa.dialogKeys(t.view, "5", KEY);
    await settle();
    assert.equal(t.requests[0]?.session, 4);
    assert.equal(t.requests[0]?.surface, "bash");
  });

  it("still refuses a session's own dialog when this controller does not hold its attach", () => {
    const t = setup();
    (t.sa as unknown as { h: { metaForPath(k: string): unknown } }).h.metaForPath = () => ({ id: 4, attachedToYou: false });
    assert.equal(t.sa.dialogKeys(t.view, "1"), false);
    assert.deepEqual(t.sent, []);
  });
});
