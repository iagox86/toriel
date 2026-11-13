import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_GRANT_DURATIONS, DIALOG_GUARD_MS, type DialogRequest, DialogPanel, dialogAnswer, dialogLines, dialogPrompt, editablePattern, grantGuarded, grantRowFor, isTypingKey, optionTakesReason, withGrantRows, withOrigin } from "../src/dialogs.ts";

const confirm = { id: "1", method: "confirm", title: "Run rm?", message: "rm -rf x" };
const select = { id: "2", method: "select", title: "Pick", options: ["a", "b", "c"] };

describe("dialogAnswer", () => {
  it("answers confirm dialogs with y and n only", () => {
    assert.deepEqual(dialogAnswer(confirm, "y"), { confirmed: true });
    assert.deepEqual(dialogAnswer(confirm, "n"), { confirmed: false });
    assert.equal(dialogAnswer(confirm, "x"), null);
  });

  it("picks select options by 1-based digit", () => {
    assert.deepEqual(dialogAnswer(select, "2"), { value: "b" });
    assert.equal(dialogAnswer(select, "4"), null);
    assert.equal(dialogAnswer(select, "0"), null);
  });

  it("answers the highlighted option on enter", () => {
    assert.deepEqual(dialogAnswer(select, "\r", 2), { value: "c" });
  });

  it("treats escape on a permission select as the explicit deny option", () => {
    const perm = { id: "4", method: "select", options: ["Yes", "Yes, for this session", "No", "No, provide reason"] };
    assert.deepEqual(dialogAnswer(perm, "\x1b"), { value: "No" });
  });

  it("denies via the last option when none starts with No", () => {
    assert.deepEqual(dialogAnswer(select, "\x1b"), { value: "c" });
  });

  it("treats escape on a confirm dialog as no", () => {
    assert.deepEqual(dialogAnswer(confirm, "\x1b"), { confirmed: false });
  });

  it("leaves free-text dialogs to the input box", () => {
    assert.equal(dialogAnswer({ id: "3", method: "input" }, "y"), null);
  });
});

describe("dialog rendering", () => {
  const perm = {
    id: "5",
    method: "select",
    title: "Permission Required\ntool    : bash\nrule    : sudo *\ncommand : sudo -V",
    options: ["Yes", 'Yes, allow bash "sudo -V" for this session', "No"],
  };

  it("shows every title line and the full option strings", () => {
    const text = dialogLines(perm, 0, 100).join("\n");
    assert.match(text, /rule {4}: sudo \*/);
    assert.match(text, /command : sudo -V/);
    assert.match(text, /2\. Yes, allow bash "sudo -V" for this session/);
  });

  it("keeps the status hint to one short line", () => {
    assert.doesNotMatch(dialogPrompt(perm), /\n/);
  });

  it("moves the highlight within the options and resets for a new dialog", () => {
    const panel = new DialogPanel();
    panel.sync(perm);
    panel.move(1);
    panel.move(1);
    panel.move(1);
    assert.equal(panel.highlighted, 2);
    panel.sync({ ...perm, id: "6" });
    assert.equal(panel.highlighted, 0);
  });

  it("shows the placeholder and how to skip for free-text dialogs", () => {
    const text = dialogLines({ id: "7", method: "input", title: "Why?", placeholder: "Reason shown back" }, 0, 100).join("\n");
    assert.match(text, /Reason shown back/);
    assert.match(text, /esc skips/);
  });

  it("offers an inline reason on the reason option and shows what is typed", () => {
    const withReason = { ...perm, options: ["Yes", "No", "No, provide reason"] };
    assert.match(dialogLines(withReason, 2, 100).join("\n"), /tab: type a reason/);
    assert.doesNotMatch(dialogLines(withReason, 1, 100).join("\n"), /tab: type a reason/);
    assert.match(dialogLines(withReason, 2, 100, "too risky").join("\n"), /No, provide reason: too risky/);
  });

  it("renders nothing without a dialog", () => {
    const panel = new DialogPanel();
    panel.sync(undefined);
    assert.deepEqual(panel.render(80), []);
  });

  it("names the session that raised the dialog, with its numeric id", () => {
    const labeled = withOrigin(perm, 3, "Worker");
    assert.equal(labeled.origin, "Session 3 'Worker'");
    assert.match(dialogLines(labeled, 0, 100).join("\n"), /Session 3 'Worker': Permission Required/);
    assert.match(dialogPrompt(labeled), /PERMISSION pending \(Session 3 'Worker'\)/);
  });

  it("falls back to the id alone for unnamed sessions", () => {
    const labeled = withOrigin(perm, 7);
    assert.equal(labeled.origin, "Session 7");
    assert.match(dialogLines(labeled, 0, 100).join("\n"), /Session 7: Permission Required/);
  });

  it("leaves unlabelled dialogs unchanged", () => {
    assert.doesNotMatch(dialogLines(perm, 0, 100).join("\n"), /Session/);
    assert.equal(dialogPrompt(perm), "PERMISSION pending - up/down choose, enter or 1-9 answer, tab reason or edit pattern, esc deny");
  });
});

describe("modal permission prompt", () => {
  const perm = { id: "9", method: "select", options: ["Yes", "No"], shownAt: 1000 };

  it("ignores a grant in the first moments after the prompt appears, so typing cannot allow it", () => {
    assert.equal(grantGuarded(perm, { value: "Yes" }, 1000 + DIALOG_GUARD_MS - 1), true);
    assert.equal(grantGuarded(perm, { value: "Yes" }, 1000 + DIALOG_GUARD_MS), false);
    assert.equal(grantGuarded({ ...confirm, shownAt: 1000 }, { confirmed: true }, 1100), true);
  });

  it("always lets a deny through", () => {
    assert.equal(grantGuarded(perm, { value: "No" }, 1001), false);
    assert.equal(grantGuarded({ ...confirm, shownAt: 1000 }, { confirmed: false }, 1001), false);
  });

  it("does not guard a dialog with no arrival time", () => {
    assert.equal(grantGuarded({ ...perm, shownAt: undefined }, { value: "Yes" }, 1001), false);
  });

  it("stamps the arrival time when labelling a request", () => {
    assert.ok((withOrigin(select, 1).shownAt ?? 0) > 0);
  });

  it("treats text and enter as typing, but not escape sequences or control chords", () => {
    assert.equal(isTypingKey("a"), true);
    assert.equal(isTypingKey("\r"), true);
    assert.equal(isTypingKey("\x7f"), true);
    assert.equal(isTypingKey("\x1b[A"), false);
    assert.equal(isTypingKey("\x03"), false);
  });
});

describe("toriel's grant rows on a permission prompt", () => {
  const ask = {
    id: "g1",
    method: "select",
    title: "Permission Required\ntool    : bash\ncommand : sudo -V",
    options: ["Yes", 'Yes, allow bash "sudo -V" for this session', "No", "No, provide reason"],
    toriel: { grants: [{ surface: "bash", pattern: "sudo -V" }] },
  };

  it("appends one marked row per duration after pi's options, leaving pi's options as they were", () => {
    const d = withGrantRows(ask, ["1h", "session"]);
    assert.deepEqual(d.options?.slice(0, 4), ask.options);
    assert.deepEqual(d.options?.slice(4), ['Yes, and allow "sudo -V" for 1 hour [toriel]', 'Yes, and allow "sudo -V" for this session, kept across restarts [toriel]']);
    assert.deepEqual(d.extraRows?.map((r) => r.for), ["1h", "session"]);
  });

  it("offers rows only for a select that carries a suggested grant and has a plain Yes", () => {
    assert.equal(withGrantRows({ ...ask, toriel: undefined }, ["1h"]).extraRows, undefined);
    assert.equal(withGrantRows({ ...ask, method: "confirm" }, ["1h"]).extraRows, undefined);
    assert.equal(withGrantRows({ ...ask, options: ["Allow", "Deny"] }, ["1h"]).extraRows, undefined);
    assert.equal(withGrantRows(ask, []).extraRows, undefined);
    assert.equal(withGrantRows({ ...ask, toriel: { grants: [] } }, ["1h"]).extraRows, undefined);
  });

  it("never adds rows twice, and keeps the whole list within nine so digits still pick", () => {
    const once = withGrantRows(ask, ["1h"]);
    assert.equal(withGrantRows(once, ["8h"]), once);
    assert.equal(withGrantRows(ask, ["1m", "2m", "3m", "4m", "5m", "6m", "7m"]).options?.length, 9);
  });

  it("answers a digit or enter on a toriel row with its label, which names the row", () => {
    const d = withGrantRows(ask, ["1h", "session"]);
    const fields = dialogAnswer(d, "5");
    assert.deepEqual(fields, { value: d.options?.[4] });
    assert.equal(grantRowFor(d, fields?.value)?.for, "1h");
    assert.equal(grantRowFor(d, d.options?.[5])?.for, "session");
    assert.equal(grantRowFor(d, "Yes"), undefined);
    assert.equal(grantRowFor(ask, "anything"), undefined);
    assert.deepEqual(dialogAnswer(d, "\r", 5), { value: d.options?.[5] });
  });

  it("still treats escape as pi's No, and a row's answer as a grant that the arrival guard holds back", () => {
    const d = { ...withGrantRows(ask, ["1h"]), shownAt: 1000 };
    assert.deepEqual(dialogAnswer(d, "\x1b"), { value: "No" });
    assert.equal(grantGuarded(d, { value: d.options?.[4] }, 1100), true);
    assert.equal(grantGuarded(d, { value: "No" }, 1100), false);
  });

  it("marks where toriel's rows start, and never offers a reason on one even if its pattern says reason", () => {
    const d = withGrantRows({ ...ask, toriel: { grants: [{ surface: "bash", pattern: "explain the reason" }] } }, ["1h"]);
    const lines = dialogLines(d, 4, 120).join("\n");
    assert.match(lines, /-- toriel: also remember this --/);
    const highlightedRow = dialogLines(d, 4, 120).find((l) => l.includes("explain the reason"));
    assert.ok(highlightedRow);
    assert.doesNotMatch(highlightedRow, /tab: type a reason/);
    assert.match(dialogLines(d, 3, 120).find((l) => l.includes("provide reason")) ?? "", /tab: type a reason/);
    assert.equal(optionTakesReason(d, d.options?.[4]), false);
    assert.equal(optionTakesReason(d, "No, provide reason"), true);
    const panel = new DialogPanel();
    panel.sync(d);
    panel.move(4);
    assert.equal(panel.highlightedOption, d.options?.[4]);
  });

  it("offers editing the pattern only on a toriel row of an ask with exactly one suggested grant", () => {
    const d = withGrantRows(ask, ["1h"]);
    assert.equal(editablePattern(d, d.options?.[4]), "sudo -V");
    assert.equal(editablePattern(d, "Yes"), undefined);
    assert.equal(editablePattern(d, undefined), undefined);
    const two = withGrantRows({ ...ask, toriel: { grants: [{ surface: "bash", pattern: "a" }, { surface: "bash", pattern: "b" }] } }, ["1h"]);
    assert.equal(editablePattern(two, two.options?.[4]), undefined);
    assert.match(dialogLines(d, 4, 120).find((l) => l.includes("Yes, and allow")) ?? "", /tab: edit the pattern/);
    assert.doesNotMatch(dialogLines(two, 4, 120).join("\n"), /edit the pattern/);
    assert.match(dialogLines(d, 4, 120, "sudo*").join("\n"), /Yes, and allow pattern \(1 hour\): sudo\*/);
  });

  it("offers an hour and a kept-across-restarts row unless the setting says otherwise", () => {
    assert.deepEqual([...DEFAULT_GRANT_DURATIONS], ["1h", "session"]);
  });
});

describe("long text in the prompt panel", () => {
  const plain = (lines: string[]): string[] => lines.map((l) => stripTerminalSequences(l));
  const longPath = `/home/user/projects/${"deeply/nested/".repeat(8)}file.txt`;
  const wide: DialogRequest = {
    id: "w1",
    method: "select",
    title: `Permission Required\ntool    : bash\ncommand : cat ${longPath}`,
    options: ["Yes", "No", "No, provide reason"],
  };
  const granting = (durations: string[]) => withGrantRows({ ...wide, options: ["Yes", "No"], toriel: { grants: [{ surface: "bash", pattern: `cat ${longPath}` }] } }, durations);

  it("wraps a typed reason so its end and the cursor stay in view", () => {
    const typed = "because this touches the production database and nobody asked for it, so please do not";
    const rows = plain(dialogLines(wide, 2, 40, typed));
    assert.ok(rows.every((r) => visibleWidth(r) <= 40), rows.join("|"));
    assert.ok(rows.at(-1)?.endsWith("█"), "the cursor is on the last row");
    assert.match(rows.join(" "), /please do not█$/);
  });

  it("breaks one unbroken word (a path) that is wider than the panel", () => {
    const rows = plain(dialogLines(wide, 2, 30, longPath));
    assert.ok(rows.every((r) => visibleWidth(r) <= 30), rows.join("|"));
    assert.ok(rows.join("").replaceAll(" ", "").includes("file.txt█"));
  });

  it("wraps a long command in the title instead of cutting it", () => {
    const rows = plain(dialogLines(wide, 0, 40));
    assert.ok(rows.every((r) => visibleWidth(r) <= 40), rows.join("|"));
    assert.ok(rows.join("").replaceAll(" ", "").includes("file.txt"), "the end of the command is shown");
  });

  it("keeps the tab hint visible on a toriel row whose pattern is long", () => {
    const rows = plain(dialogLines(granting(["1h"]), 2, 40));
    assert.ok(rows.every((r) => visibleWidth(r) <= 40), rows.join("|"));
    assert.match(rows.join(" ").replace(/\s+/g, " "), /\(tab: edit the pattern\)/);
    assert.ok(rows.join("").replaceAll(" ", "").includes("file.txt"), "the whole pattern is readable before you tab into it");
  });

  it("still cuts the rows you are not on, one line each", () => {
    const rows = plain(dialogLines(granting(["1h", "session"]), 0, 40));
    assert.ok(rows.every((r) => visibleWidth(r) <= 40), rows.join("|"));
    assert.equal(rows.filter((r) => /^\s+[34]\. /.test(r)).length, 2, "each unselected toriel row is a single line");
  });
});
