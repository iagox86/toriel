import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import type { DialogRequest } from "../src/dialogs.ts";
import { bodyOf, type Ask, type Notification, notifiable, notifySend, PermissionNotifier } from "../src/permission-notify.ts";

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
    assert.deepEqual(sent, [{ summary: "Permission request: Worker", body: "tool    : bash | command : sudo -V", critical: false }]);
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
    assert.deepEqual(sent, [{ summary: "Plan to approve: Subagent: Planner", body: "the agent has a plan for you to approve", critical: true }]);
  });

  it("recognises exactly permission prompts and plan approvals, and cuts a long body", () => {
    assert.equal(notifiable(perm("a")), "permission");
    assert.equal(notifiable(plan), "plan");
    assert.equal(notifiable({ id: "x", method: "select", title: "Permission Required", options: ["Allow"] }), undefined);
    const long = { ...perm("a"), title: `Permission Required\ncommand : ${"x".repeat(1000)}` };
    assert.ok(bodyOf(long).length <= 240);
    assert.match(bodyOf(long), /…$/);
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
    send({ summary: "-s", body: "b", critical: true });
    assert.equal(calls[0]?.cmd, "notify-send");
    assert.deepEqual(calls[0]?.args, ["--app-name=toriel", "--urgency=critical", "--", "-s", "b"]);
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
});
