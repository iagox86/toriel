import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import type { DialogRequest } from "../src/dialogs.ts";
import { bodyOf, escapeMarkup, oneLine, promptFields, type Ask, type Notification, notifiable, notifySend, PermissionNotifier } from "../src/permission-notify.ts";

const perm = (id: string): DialogRequest => ({ id, method: "select", title: "Permission Required\ntool    : bash\ncommand : sudo -V", options: ["Yes", "No"] });
const plan: DialogRequest = { id: "p1", method: "select", title: "Plan mode: approve this plan?\n\n1. do it", options: ["Approve", "Keep planning", "Reject"] };
const away: Ask = { focused: false, session: 3, who: "Worker", enabled: true, critical: false };

function harness(): { sent: Notification[]; notifier: PermissionNotifier } {
  const sent: Notification[] = [];
  return { sent, notifier: new PermissionNotifier((n) => sent.push(n)) };
}

describe("permission notifications (ticket 234)", () => {
  it("pings for a permission prompt in a session that is not on screen, naming it and the tool", () => {
    const { sent, notifier } = harness();
    assert.equal(notifier.consider(perm("a"), away), true);
    assert.deepEqual(sent, [{ summary: "Worker needs permission", body: "<b>bash</b>\nsudo -V", critical: false, icon: "dialog-password" }]);
  });

  it("does not ping for the session on screen, when switched off, or for other dialogs", () => {
    const { sent, notifier } = harness();
    assert.equal(notifier.consider(perm("a"), { ...away, focused: true }), false);
    assert.equal(notifier.consider(perm("b"), { ...away, enabled: false }), false);
    assert.equal(notifier.consider({ id: "c", method: "select", title: "Pick one", options: ["x", "y"] }, away), false);
    assert.equal(notifier.consider({ id: "d", method: "input", title: "Name?" }, away), false);
    assert.deepEqual(sent, []);
  });

  it("pings once per dialog, not again for the same id, but again for a new id or the same id in another session", () => {
    const { sent, notifier } = harness();
    notifier.consider(perm("a"), away);
    notifier.consider(perm("a"), away);
    assert.equal(sent.length, 1);
    notifier.consider(perm("b"), away);
    notifier.consider(perm("a"), { ...away, session: 4 });
    assert.equal(sent.length, 3);
  });

  it("a dialog seen while on screen is never pinged later, and the critical setting and plan approvals come through", () => {
    const { sent, notifier } = harness();
    notifier.consider(perm("a"), { ...away, focused: true });
    assert.deepEqual(sent, []);
    notifier.consider(plan, { ...away, critical: true, who: "Subagent: Planner" });
    assert.deepEqual(sent, [{ summary: "Subagent: Planner has a plan to approve", body: "the agent has a plan for you to approve", critical: true, icon: "dialog-question" }]);
  });

  it("recognises exactly permission prompts and plan approvals, and cuts a long body", () => {
    assert.equal(notifiable(perm("a")), "permission");
    assert.equal(notifiable(plan), "plan");
    assert.equal(notifiable({ id: "x", method: "select", title: "Permission Required", options: ["Allow"] }), undefined);
    const long = { ...perm("a"), title: `Permission Required\ncommand : ${"x".repeat(500)}${"y".repeat(500)}` };
    assert.ok(bodyOf(long).length <= 160);
    assert.match(bodyOf(long), /^x+…y+$/, "cut in the middle: the head and the tail stay");
  });
});

describe("the notification's look (ticket 335)", () => {
  const prompt = (title: string): DialogRequest => ({ id: "a", method: "select", title, options: ["Yes", "No"] });

  it("puts the tool in bold on its own line and the path or command under it", () => {
    assert.equal(bodyOf(prompt("Permission Required\ntool    : write\npath    : /p/deep/docs/a.md")), "<b>write</b>\n/p/deep/docs/a.md");
    assert.equal(bodyOf(prompt("Permission Required (Subagent)\ntool    : bash\ncommand : ls")), "<b>bash</b>\nls", "a forwarded subagent prompt reads the same");
    assert.equal(bodyOf(prompt("Permission Required\ncommand : rm a")), "rm a", "no tool field: just the detail");
  });

  it("folds a multi-line command onto one line instead of joining raw dialog lines", () => {
    const title = "Permission Required\ntool    : bash\ncommand : for f in *.ts; do\n  echo   $f\ndone";
    assert.deepEqual(promptFields(title), [
      { key: "tool", value: "bash" },
      { key: "command", value: "for f in *.ts; do\n  echo   $f\ndone" },
    ]);
    assert.equal(bodyOf(prompt(title)), "<b>bash</b>\nfor f in *.ts; do echo $f done");
  });

  it("escapes what the dialog says, so a redirect or an ampersand cannot break the markup", () => {
    assert.equal(escapeMarkup("a < b && c > d"), "a &lt; b &amp;&amp; c &gt; d");
    assert.equal(bodyOf(prompt("Permission Required\ntool    : bash\ncommand : make 2>&1 </dev/null")), "<b>bash</b>\nmake 2&gt;&amp;1 &lt;/dev/null");
  });

  it("cuts a long line in the middle within the limit", () => {
    assert.equal(oneLine("short  text\n"), "short text");
    const cut = oneLine(`${"a".repeat(100)} ${"b".repeat(100)}`, 40);
    assert.ok(cut.length <= 40, cut);
    assert.match(cut, /^a+…b+$/);
  });
});

describe("notifySend", () => {
  it("runs notify-send detached with the summary and body as plain arguments (a leading dash is not an option)", () => {
    const calls: Array<{ cmd: string; args: string[]; opts: unknown }> = [];
    const child = Object.assign(new EventEmitter(), { unref() {} });
    const send = notifySend(() => {}, ((cmd: string, args: string[], opts: unknown) => {
      calls.push({ cmd, args, opts });
      return child;
    }) as never);
    send({ summary: "-s", body: "b", critical: true, icon: "dialog-password" });
    send({ summary: "s", body: "b", critical: false });
    assert.equal(calls[0]?.cmd, "notify-send");
    assert.deepEqual(calls[0]?.args, ["--app-name=toriel", "--urgency=critical", "--icon=dialog-password", "--", "-s", "b"]);
    assert.deepEqual(calls[1]?.args, ["--app-name=toriel", "--urgency=normal", "--", "s", "b"], "no icon: no flag");
    assert.deepEqual(calls[0]?.opts, { stdio: "ignore", detached: true });
  });

  it("logs a failure instead of throwing, whether the spawn throws or the child errors", () => {
    const logs: string[] = [];
    notifySend((l) => logs.push(l), (() => {
      throw new Error("EACCES");
    }) as never)({ summary: "s", body: "b", critical: false });
    const child = Object.assign(new EventEmitter(), { unref() {} });
    notifySend((l) => logs.push(l), (() => child) as never)({ summary: "s", body: "b", critical: false });
    child.emit("error", new Error("spawn notify-send ENOENT"));
    assert.deepEqual(logs, ["notify-send failed: EACCES", "notify-send failed: spawn notify-send ENOENT"]);
  });

  it("a log callback that fails itself is swallowed (KEY_LOG may be unwritable; nothing takes the controller down)", () => {
    const boom = () => {
      throw new Error("EACCES on the log append");
    };
    const quiet = notifySend(boom, (() => {
      throw new Error("EACCES");
    }) as never);
    quiet({ summary: "s", body: "b", critical: false }); // the spawn-failure path
    const child = Object.assign(new EventEmitter(), { unref() {} });
    const loud = notifySend(boom, (() => child) as never);
    loud({ summary: "s", body: "b", critical: false });
    child.emit("error", new Error("spawn notify-send ENOENT")); // the child-error path, inside the listener
  });
});
