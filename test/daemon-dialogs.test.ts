// Any controller can watch and answer a dialog; the first answer wins; every controller hears `ui_resolved` (ticket 270).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { resolvedDialogNote } from "../src/dialogs.ts";
import { type Client, type Harness, type Msg, startDaemon, until } from "./helpers.ts";

describe("the controller's box on ui_resolved (ticket 270)", () => {
  it("closes only the dialog that was resolved, and says why", () => {
    assert.equal(resolvedDialogNote(undefined, "d1", "user"), undefined);
    assert.equal(resolvedDialogNote({ id: "d2" }, "d1", "user"), undefined);
    assert.equal(resolvedDialogNote({ id: "d1" }, "d1", "user", "chatto"), "answered from chatto");
    assert.equal(resolvedDialogNote({ id: "d1" }, "d1", "user"), "answered from another client");
    assert.equal(resolvedDialogNote({ id: "d1" }, "d1", "expired"), "timed out");
    assert.match(resolvedDialogNote({ id: "d1" }, "d1", "deny-after") ?? "", /denied automatically/);
    assert.equal(resolvedDialogNote({ id: "d1" }, "d1", "dropped"), "dropped");
  });
});

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const isSettled = (m: Msg) => m.type === "event" && m.event?.type === "agent_settled";

/** A controller attached to a session that has answered once, so the session is live. */
async function attachedSession(h: Harness): Promise<{ a: Client; session: number }> {
  const a = await h.connect();
  const { sessionId } = await a.request({ type: "spawn", cwd: h.dir });
  await a.waitFor((m) => m.type === "history" && m.session === sessionId);
  await a.request({ type: "prompt", session: sessionId, message: "hi" });
  await a.waitFor(isSettled);
  return { a, session: sessionId };
}

/** A second controller (it has said `list`, as the real one does) that watches dialogs. */
async function observer(h: Harness): Promise<Client> {
  const b = await h.connect();
  await b.request({ type: "list" });
  await b.request({ type: "observe_dialogs" });
  return b;
}

/** What pi was told about dialogs (fake-pi writes each extension_ui_response it gets). */
const piAnswers = (h: Harness): Array<Record<string, unknown>> => {
  const file = path.join(h.sessionsDir, "ui-responses.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};

const isRequest = (id: string) => (m: Msg) => m.type === "ui_request" && m.request?.id === id;
const isResolved = (id: string) => (m: Msg) => m.type === "ui_resolved" && m.id === id;

describe("daemon: dialogs seen and answered from any controller (ticket 270)", () => {
  it("an observer sees the dialog without the attach, and the first answer wins", async () => {
    harness = await startDaemon();
    const { a, session } = await attachedSession(harness);
    const b = await observer(harness);
    // a controller that did not subscribe hears nothing of another controller's dialog
    const c = await harness.connect();
    await c.request({ type: "list" });

    await a.request({ type: "prompt", session, message: "/ask-select" });
    await a.waitFor(isRequest("ask-select-1"));
    const seen = await b.waitFor(isRequest("ask-select-1"));
    assert.equal(seen.session, session);
    assert.equal(b.sessions().find((s) => s.id === session)?.attachedToYou, false, "observing does not take the attach");
    await a.request({ type: "list" }); // a round trip behind everything the daemon sent so far
    await c.request({ type: "list" });
    assert.equal(c.messages.some((m) => m.type === "ui_request"), false, "an unsubscribed, unattached controller is not sent the dialog");

    // the observer answers first, saying where from; the attached controller answers a moment later and is told it is too late
    await b.request({ type: "ui_response", session, source: "chatto", response: { type: "extension_ui_response", id: "ask-select-1", value: "No" } });
    await assert.rejects(a.request({ type: "ui_response", session, response: { type: "extension_ui_response", id: "ask-select-1", value: "Yes" } }), /already answered/);

    for (const who of [a, b, c]) {
      const resolved = await who.waitFor(isResolved("ask-select-1"));
      assert.equal(resolved.by, "user");
      assert.equal(resolved.source, "chatto");
      assert.equal(resolved.session, session);
    }
    // pi got one answer, the first
    await until(() => piAnswers(harness as Harness).length > 0);
    assert.deepEqual(piAnswers(harness).map((r) => [r.id, r.value]), [["ask-select-1", "No"]]);
  });

  it("records where an answer came from in the decision log", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "decisions-dialogs-")), "decisions.jsonl");
    harness = await startDaemon({ TORIEL_DECISIONS: file });
    const { a, session } = await attachedSession(harness);
    await a.request({ type: "prompt", session, message: "/ask-select" });
    await a.waitFor(isRequest("ask-select-1"));
    await a.request({ type: "ui_response", session, source: "chatto", response: { type: "extension_ui_response", id: "ask-select-1", value: "Yes" } });
    await until(() => fs.existsSync(file));
    const rec = JSON.parse(fs.readFileSync(file, "utf8").trim().split("\n").pop() as string);
    assert.equal(rec.by, "user");
    assert.equal(rec.source, "chatto");
    assert.equal(rec.answer, "yes");
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it("an observer that connects while a dialog waits is sent it, and a dropped observer stops being sent anything", async () => {
    harness = await startDaemon();
    const { a, session } = await attachedSession(harness);
    await a.request({ type: "prompt", session, message: "/ask-select" });
    await a.waitFor(isRequest("ask-select-1"));

    const b = await observer(harness);
    await b.waitFor(isRequest("ask-select-1"));
    b.close();

    await a.request({ type: "ui_response", session, response: { type: "extension_ui_response", id: "ask-select-1", value: "No" } });
    // a later dialog still reaches the attached controller with a dead observer on the list
    await a.request({ type: "prompt", session, message: "/ask-question" });
    await a.waitFor(isRequest("question-1"));
    await a.request({ type: "ui_response", session, response: { type: "extension_ui_response", id: "question-1", cancelled: true } });
    await a.waitFor(isResolved("question-1"));
  });

  it("an answer for a dialog that is not pending is refused and never reaches pi", async () => {
    harness = await startDaemon();
    const { a, session } = await attachedSession(harness);
    await assert.rejects(a.request({ type: "ui_response", session, response: { type: "extension_ui_response", id: "nope", value: "Yes" } }), /already answered/);
    await a.request({ type: "prompt", session, message: "/ask-select" });
    await a.waitFor(isRequest("ask-select-1"));
    await assert.rejects(a.request({ type: "ui_response", session, response: { type: "extension_ui_response", id: "stale-1", value: "Yes" } }), /already answered/);
    // the real dialog is still open and answerable
    await a.request({ type: "ui_response", session, response: { type: "extension_ui_response", id: "ask-select-1", value: "Yes" } });
    await until(() => piAnswers(harness as Harness).length > 0);
    assert.deepEqual(piAnswers(harness).map((r) => r.id), ["ask-select-1"]);
  });

  it("pi's own timeout sends ui_resolved (expired)", async () => {
    harness = await startDaemon({ FAKE_PI_ASK_MS: "200" });
    const { a, session } = await attachedSession(harness);
    const b = await observer(harness);
    await a.request({ type: "prompt", session, message: "/ask" });
    await a.waitFor(isRequest("ask-1"));
    for (const who of [a, b]) {
      assert.equal((await who.waitFor(isResolved("ask-1"))).by, "expired");
    }
  });

  it("the deny-after timer sends ui_resolved (deny-after)", async () => {
    harness = await startDaemon({ TORIEL_DENY_MIN_MS: "500" });
    const { a, session } = await attachedSession(harness);
    const b = await observer(harness);
    await a.request({ type: "deny_after", session, after: "1 second" });
    await a.request({ type: "prompt", session, message: "/ask-select" });
    await a.waitFor(isRequest("ask-select-1"));
    for (const who of [a, b]) {
      assert.equal((await who.waitFor(isResolved("ask-select-1"))).by, "deny-after");
    }
  });

  it("observe_dialogs off stops the copies", async () => {
    harness = await startDaemon();
    const { a, session } = await attachedSession(harness);
    const b = await observer(harness);
    await b.request({ type: "observe_dialogs", on: false });
    await a.request({ type: "prompt", session, message: "/ask-select" });
    await a.waitFor(isRequest("ask-select-1"));
    await b.request({ type: "list" });
    assert.equal(b.messages.some((m) => m.type === "ui_request"), false);
  });
});
