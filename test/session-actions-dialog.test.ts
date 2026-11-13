// A permission prompt in toriel's own layout (1 once, 2 allow 1h, 3 allow session, 4 No, 5 No with a reason): picking an allow
// row answers pi with its plain "Yes" and stores the grant through the daemon; the other rows answer pi in its own words, and
// the arrival guard is untouched.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DialogPanel, type DialogRequest, withOrigin, withOwnLayout } from "../src/dialogs.ts";
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

/** A file-path prompt: pi's own four options and the one grant it suggested (the file's directory). */
const pathAsk: DialogRequest = {
  id: "g1",
  method: "select",
  title: "Permission Required\ntool    : write\npath    : /p/deep/docs/a.md",
  options: ["Yes", 'Yes, allow path_write "/p/deep/docs/*" for this session', "No", "No, provide reason"],
  toriel: { grants: [{ surface: "path_write", pattern: "/p/deep/docs/*" }] },
};

/** `owner`: the dialog belongs to a subagent (daemon id 9) but is shown, and answered, while viewing its parent (daemon id 1). */
function setup(over: { shownAgoMs?: number; fail?: boolean; owner?: boolean; path?: boolean; base?: DialogRequest } = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const requests: Array<Record<string, unknown>> = [];
  const notices: string[] = [];
  const panel = new DialogPanel();
  const dialog = { ...withOwnLayout(withOrigin(over.base ?? (over.path ? pathAsk : ask), 4, "Mealie"), ["1h", "session"]), shownAt: Date.now() - (over.shownAgoMs ?? 5000) };
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
  return { sa: new SessionActions(host as unknown as Host), view, sent, requests, notices, dialog, panel };
}

type Setup = ReturnType<typeof setup>;
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const HOME = "\x1b[H";
const END = "\x1b[F";
const DELETE = "\x1b[3~";
const BACKSPACE = "\x7f";
const down = (t: Setup, n: number, key?: string) => {
  for (let i = 0; i < n; i++) {
    t.sa.dialogKeys(t.view, DOWN, key);
  }
};
const type = (t: Setup, text: string, key?: string) => {
  for (const ch of text) {
    t.sa.dialogKeys(t.view, ch, key);
  }
};

/** The value a ui_response sent to pi carried. */
const answered = (cmd: Record<string, unknown> | undefined): unknown => (cmd?.response as { value?: unknown } | undefined)?.value;
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("permission prompt: toriel's own layout", () => {
  it("answers pi with a plain Yes and stores a timed grant when the hour row is picked", async () => {
    const t = setup();
    assert.equal(t.sa.dialogKeys(t.view, "2"), true);
    await settle();
    assert.deepEqual(t.sent, [{ type: "ui_response", session: 4, response: { type: "extension_ui_response", id: "g1", value: "Yes" } }]);
    assert.deepEqual(t.requests, [{ type: "permission_add", session: 4, surface: "bash", pattern: "sudo -V", for: "1h", source: "dialog" }]);
    assert.deepEqual(t.notices, ['granted bash "sudo -V" for 1 hour']);
    assert.equal(t.view.dialog, undefined);
  });

  it("stores a grant without expiry for the kept-across-restarts row", async () => {
    const t = setup();
    t.sa.dialogKeys(t.view, "3");
    await settle();
    assert.equal(t.requests[0]?.for, "session");
    assert.equal(answered(t.sent[0]), "Yes");
  });

  it("works from the highlighted row with enter", async () => {
    const t = setup();
    down(t, 1); // the first allow row
    assert.equal(t.sa.dialogKeys(t.view, "\r"), true);
    await settle();
    assert.equal(t.requests[0]?.for, "1h");
  });

  it("answers once, No, and the reason row in pi's own words, and stores nothing for them", async () => {
    for (const [key, value] of [["1", "Yes"], ["4", "No"], ["5", "No, provide reason"]] as const) {
      const t = setup();
      t.sa.dialogKeys(t.view, key);
      await settle();
      assert.equal(answered(t.sent[0]), value, key);
      assert.equal(t.requests.length, 0, key);
    }
  });

  it("never answers with pi's own 'for this session' option when there is a grant to make instead", async () => {
    for (const key of ["1", "2", "3", "4", "5"]) {
      const t = setup();
      t.sa.dialogKeys(t.view, key);
      await settle();
      assert.notEqual(answered(t.sent[0]), 'Yes, allow bash "sudo -V" for this session', key);
    }
  });

  it("with no suggestion the session row answers pi's own session option", async () => {
    const t = setup({ base: { ...ask, toriel: undefined } });
    assert.deepEqual(t.dialog.options, ["Yes, this once", "Yes, and allow for this session (pi's own: lost on restart)", "No", "No, with a reason"]);
    t.sa.dialogKeys(t.view, "2");
    await settle();
    assert.equal(answered(t.sent[0]), 'Yes, allow bash "sudo -V" for this session');
    assert.equal(t.requests.length, 0, "toriel keeps nothing for it");
  });

  it("treats escape as No and stores nothing", async () => {
    const t = setup();
    t.sa.dialogKeys(t.view, "\x1b");
    await settle();
    assert.equal(answered(t.sent[0]), "No");
    assert.equal(t.requests.length, 0);
  });

  it("holds the pick back during the arrival guard, like any grant", async () => {
    const t = setup({ shownAgoMs: 100 });
    assert.equal(t.sa.dialogKeys(t.view, "2"), true);
    await settle();
    assert.deepEqual(t.sent, []);
    assert.deepEqual(t.requests, []);
    assert.ok(t.view.dialog, "the dialog stays up");
  });

  it("says so when the grant could not be stored, after pi was already answered Yes", async () => {
    const t = setup({ fail: true });
    t.sa.dialogKeys(t.view, "2");
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

  it("an ask about a protected file has no allow row to pick: the digits are once, No and the reason", async () => {
    const t = setup({ base: { ...ask, toriel: { protectedAsk: true } } });
    assert.deepEqual(t.dialog.options, ["Yes, this once", "No", "No, with a reason"]);
    t.sa.dialogKeys(t.view, "2");
    await settle();
    assert.equal(answered(t.sent[0]), "No");
    assert.equal(t.requests.length, 0);
  });

  it("a typed deny reason goes with pi's own reason option", () => {
    const t = setup();
    down(t, 4);
    t.sa.dialogKeys(t.view, "\t");
    type(t, "no");
    t.sa.dialogKeys(t.view, "\r");
    assert.equal(answered(t.sent[0]), "No, provide reason");
    assert.equal(t.requests.length, 0, "a reason is not a grant");
  });
});

describe("a file-path prompt: toriel's rows and the pattern edit", () => {
  it("stores the grant against the open prompt first, then answers pi Yes", async () => {
    const t = setup({ path: true });
    t.sa.dialogKeys(t.view, "2");
    assert.deepEqual(t.sent, [], "pi is not answered until the grant is kept");
    await settle();
    assert.deepEqual(t.requests, [{ type: "permission_add", session: 4, surface: "path_write", pattern: "/p/deep/docs/*", for: "1h", source: "dialog", dialog: "g1" }]);
    assert.equal(answered(t.sent[0]), "Yes");
    assert.equal(t.view.dialog, undefined);
  });

  it("keeps the prompt open, and pi unanswered, when the daemon refuses the grant", async () => {
    const t = setup({ path: true, fail: true });
    t.sa.dialogKeys(t.view, "2");
    await settle();
    assert.deepEqual(t.sent, []);
    assert.ok(t.view.dialog, "still asking");
    assert.match(t.notices.at(-1) ?? "", /could not keep the permission grant/);
  });

  it("lets you widen the directory, and stores what you typed", async () => {
    const t = setup({ path: true });
    down(t, 1);
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
    down(t, 1);
    t.sa.dialogKeys(t.view, "\t");
    for (let i = 0; i < "/p/deep/docs/*".length; i++) {
      t.sa.dialogKeys(t.view, BACKSPACE);
    }
    type(t, "/q/*");
    t.sa.dialogKeys(t.view, "\r");
    await settle();
    assert.deepEqual(t.requests, []);
    assert.deepEqual(t.sent, []);
    assert.match(t.notices.at(-1) ?? "", /does not cover "\/p\/deep\/docs\/\*"/);
    assert.ok(t.view.dialog);
  });

  it("leaves bash grants as they were: pi answered at once, no prompt id sent", async () => {
    const t = setup();
    t.sa.dialogKeys(t.view, "2");
    assert.equal(answered(t.sent[0]), "Yes", "answered before the store call");
    await settle();
    assert.equal("dialog" in (t.requests[0] ?? {}), false);
  });
});

describe("a subagent's prompt answered from its parent's view", () => {
  it("stores the grant on the subagent, not on the parent being viewed", async () => {
    const t = setup({ owner: true });
    t.sa.dialogKeys(t.view, "2", KEY);
    await settle();
    assert.equal(t.sent[0]?.session, 9, "pi's Yes goes to the subagent");
    assert.equal(t.requests[0]?.session, 9, "and so does the grant");
    assert.equal(t.requests[0]?.surface, "bash");
  });

  it("does the same for a pattern typed after tab", async () => {
    const t = setup({ owner: true });
    down(t, 1, KEY);
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
    down(t, 4, KEY);
    t.sa.dialogKeys(t.view, "\t", KEY);
    t.sa.dialogKeys(t.view, "x", KEY);
    t.sa.dialogKeys(t.view, "\r", KEY);
    assert.equal(t.sent[0]?.session, 9);
    assert.equal(t.requests.length, 0, "a reason is not a grant");
  });

  it("is answered only by the controller attached to the parent (two controllers on one parent must not both answer)", () => {
    const t = setup({ owner: true });
    (t.sa as unknown as { h: { metaForPath(k: string): unknown } }).h.metaForPath = (k: string) => (k === KEY ? { id: 9, attachedToYou: false } : { id: 1, attachedToYou: false });
    assert.equal(t.sa.dialogKeys(t.view, "1", KEY), false);
    assert.deepEqual(t.sent, []);
    assert.ok(t.view.dialog);
  });
});

describe("permission prompt: editing the grant pattern (tab on a toriel row)", () => {
  it("pre-fills the suggested pattern and stores the typed one with the row's duration", async () => {
    const t = setup();
    down(t, 1); // the 1h row
    assert.equal(t.sa.dialogKeys(t.view, "\t"), true);
    assert.equal(t.panel.editing, "sudo -V");
    for (let i = 0; i < 2; i++) {
      t.sa.dialogKeys(t.view, BACKSPACE);
    }
    type(t, "*");
    assert.equal(t.panel.editing, "sudo *");
    t.sa.dialogKeys(t.view, "\r");
    await settle();
    assert.deepEqual(t.sent, [{ type: "ui_response", session: 4, response: { type: "extension_ui_response", id: "g1", value: "Yes" } }]);
    assert.deepEqual(t.requests, [{ type: "permission_add", session: 4, surface: "bash", pattern: "sudo *", for: "1h", source: "dialog" }]);
    assert.equal(t.view.dialog, undefined);
    assert.equal(t.panel.editing, null);
  });

  it("keeps the session lifetime of the row it was started on", async () => {
    const t = setup();
    down(t, 2); // the session row
    t.sa.dialogKeys(t.view, "\t");
    t.sa.dialogKeys(t.view, "\r");
    await settle();
    assert.equal(t.requests[0]?.for, "session");
    assert.equal(t.requests[0]?.pattern, "sudo -V", "enter on the untouched pre-fill stores the suggested pattern");
  });

  it("refuses an empty pattern and keeps the dialog open", async () => {
    const t = setup();
    down(t, 1);
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
    down(t, 1);
    t.sa.dialogKeys(t.view, "\t");
    t.sa.dialogKeys(t.view, "\x1b");
    await settle();
    assert.deepEqual(t.sent, []);
    assert.deepEqual(t.requests, []);
    assert.ok(t.view.dialog);
  });

  it("does not offer editing on the once row", () => {
    const t = setup();
    t.sa.dialogKeys(t.view, "\t"); // "Yes, this once" is highlighted
    assert.equal(t.panel.editing, null);
  });

  it("does not offer editing when the ask carries several grants", () => {
    const t = setup();
    t.view.dialog = { ...t.dialog, toriel: { grants: [{ surface: "bash", pattern: "a" }, { surface: "bash", pattern: "b" }] } };
    down(t, 1);
    t.sa.dialogKeys(t.view, "\t");
    assert.equal(t.panel.editing, null);
  });

  it("moves a cursor: left, right, home, end and delete fix a character in the middle", async () => {
    const t = setup();
    down(t, 1);
    t.sa.dialogKeys(t.view, "\t");
    t.sa.dialogKeys(t.view, LEFT);
    t.sa.dialogKeys(t.view, LEFT);
    t.sa.dialogKeys(t.view, DELETE); // "sudo -V" -> "sudo V"
    assert.equal(t.panel.editing, "sudo V");
    type(t, "x");
    assert.equal(t.panel.editing, "sudo xV");
    t.sa.dialogKeys(t.view, HOME);
    t.sa.dialogKeys(t.view, RIGHT);
    t.sa.dialogKeys(t.view, BACKSPACE); // "udo xV"
    assert.equal(t.panel.editing, "udo xV");
    t.sa.dialogKeys(t.view, END);
    type(t, "!");
    assert.equal(t.panel.editing, "udo xV!");
  });

  it("keeps the edit and the highlighted row when up or down is pressed", () => {
    const t = setup();
    down(t, 1);
    t.sa.dialogKeys(t.view, "\t");
    type(t, "z");
    assert.equal(t.sa.dialogKeys(t.view, UP), true);
    assert.equal(t.sa.dialogKeys(t.view, DOWN), true);
    assert.equal(t.panel.editing, "sudo -Vz");
    assert.equal(t.panel.highlighted, 1);
  });
});

describe("a subagent's dialog shown in its parent's view", () => {
  const forwarded = () => {
    const t = setup();
    const host = (t.sa as unknown as { h: { viewing: string; metaForPath(k: string): unknown } }).h;
    host.viewing = PARENT_KEY;
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
    t.sa.dialogKeys(t.view, "2", KEY);
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
