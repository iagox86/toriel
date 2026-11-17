import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { answerText, brief, type DecisionRecord, readDecisions, recordDecision } from "../src/decision-log.ts";
import { type Client, type Harness, type Msg, startDaemon } from "./helpers.ts";

const base = { session: 1, agent: null, surfaces: ["bash"], auto: false, attended: true, by: "user" as const };

describe("the log file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "decisions-"));
  const file = path.join(dir, "d.jsonl");

  it("appends one JSON line per record and reads a window back, oldest first", () => {
    recordDecision({ ...base, at: "2026-11-16T10:00:00.000Z", value: "a" }, file);
    recordDecision({ ...base, at: "2026-11-16T11:00:00.000Z", value: "b" }, file);
    recordDecision({ ...base, at: "2026-11-16T12:00:00.000Z", value: "c" }, file);
    assert.deepEqual(readDecisions("2026-11-16T10:30:00.000Z", "2026-11-16T12:00:00.000Z", file).map((r) => r.value), ["b", "c"]);
    assert.equal(readDecisions("2026-11-16T10:00:00.000Z", "2026-11-16T10:00:00.000Z", file)[0]?.v, 1);
  });

  it("skips a torn line, and never throws when the file cannot be written", () => {
    fs.appendFileSync(file, '{"at":"2026-11-16T11:30:00.000Z","session":\n');
    assert.equal(readDecisions("2026-11-16T00:00:00.000Z", "2026-11-17T00:00:00.000Z", file).length, 3);
    assert.doesNotThrow(() => recordDecision({ ...base }, path.join(file, "not-a-dir", "x.jsonl")));
  });

  it("rotates past 8 MB and still reads the rotated half", () => {
    const big = path.join(dir, "big.jsonl");
    fs.writeFileSync(big, `${JSON.stringify({ at: "2026-11-16T09:00:00.000Z", value: "old" })}\n${" ".repeat(8 * 1024 * 1024)}\n`);
    recordDecision({ ...base, at: "2026-11-16T09:30:00.000Z", value: "new" }, big);
    assert.ok(fs.existsSync(`${big}.1`));
    assert.deepEqual(readDecisions("2026-11-16T00:00:00.000Z", "2026-11-17T00:00:00.000Z", big).map((r) => r.value), ["old", "new"]);
  });
});

describe("answerText and brief", () => {
  it("names what a reply said", () => {
    assert.equal(answerText({ id: "x", value: "Yes" }), "yes");
    assert.equal(answerText({ id: "x", value: "Yes, for this session" }), "yes");
    assert.equal(answerText({ id: "x", value: "No: not now" }), "no");
    assert.equal(answerText({ id: "x", cancelled: true }), "cancelled");
    assert.equal(answerText({ id: "x", confirmed: true }), "yes");
    assert.equal(answerText({ id: "x", value: "Always allow npm" }), "Always allow npm");
  });

  it("squeezes a command onto one line and shortens it", () => {
    assert.equal(brief("a\n  b\tc"), "a b c");
    assert.equal(brief("x".repeat(300))?.length, 200);
    assert.equal(brief(undefined), undefined);
  });
});

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.stop();
  }
});

/** A daemon whose decision log is a file of its own, and one session that has answered once. */
async function setup(env: Record<string, string>) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "decisions-daemon-")), "decisions.jsonl");
  const h = await startDaemon({ TORIEL_DECISIONS: file, ...env });
  harnesses.push(h);
  const c = await h.connect();
  const { sessionId: session } = await c.request({ type: "spawn", cwd: h.dir });
  await c.waitFor((m: Msg) => m.type === "history" && m.session === session);
  await c.request({ type: "prompt", session, message: "hi" });
  await c.waitFor((m: Msg) => m.type === "event" && m.event?.type === "agent_settled");
  let uuid: string | undefined;
  for (let i = 0; i < 40 && !uuid; i++) {
    uuid = c.sessions().find((s) => s.id === session)?.sessionId;
    await new Promise((r) => setTimeout(r, 50));
  }
  const records = async (n: number): Promise<DecisionRecord[]> => {
    for (let i = 0; i < 60; i++) {
      const got = readDecisions("0", "9", file);
      if (got.length >= n) {
        return got;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return readDecisions("0", "9", file);
  };
  const reportAsk = async (value: string, rule?: { explicit: boolean; pattern?: string; origin?: string }) => {
    const link = await h.connect();
    await link.request({ type: "permission_check", uuid, grants: [{ surface: "bash", pattern: value }], value, ...(rule ? { rule } : {}) });
  };
  return { h, c: c as Client, session, records, reportAsk };
}

describe("daemon: the permission decision log (ticket 239)", () => {
  it("records a prompt auto mode answered, with the rule that let it through", async () => {
    const t = await setup({ FAKE_PI_ASK_COMMAND: "npm test" });
    await t.c.request({ type: "auto_mode", session: t.session, on: true });
    await t.reportAsk("npm test", { explicit: false, pattern: "*", origin: "builtin" });
    await t.c.request({ type: "prompt", session: t.session, message: "/ask-select" });
    const [r] = await t.records(1);
    assert.equal(r?.by, "auto");
    assert.equal(r?.answer, "yes");
    assert.equal(r?.auto, true);
    assert.equal(r?.value, "npm test");
    assert.deepEqual(r?.surfaces, ["bash"]);
    assert.deepEqual(r?.rule, { explicit: false, pattern: "*", origin: "builtin" });
    assert.equal(r?.agent, null, "a plain session");
    assert.equal(r?.session, t.session);
  });

  it("records who answered a prompt auto mode stood aside for, and why it stood aside", async () => {
    const t = await setup({ FAKE_PI_ASK_COMMAND: "npm test" });
    await t.c.request({ type: "auto_mode", session: t.session, on: true });
    await t.reportAsk("npm test", { explicit: true, pattern: "npm *", origin: "global" });
    await t.c.request({ type: "prompt", session: t.session, message: "/ask-select" });
    await t.c.waitFor((m: Msg) => m.type === "ui_request" && m.request?.id === "ask-select-1");
    await new Promise((r) => setTimeout(r, 150));
    await t.c.request({ type: "ui_response", session: t.session, response: { id: "ask-select-1", value: "Yes" } });
    const [r] = await t.records(1);
    assert.equal(r?.by, "user");
    assert.equal(r?.answer, "yes");
    assert.equal(r?.auto, true, "auto mode was on when it arrived");
    assert.match(r?.floor ?? "", /your permission config asks about this one \(rule "npm \*"\)/);
    assert.deepEqual(r?.rule, { explicit: true, pattern: "npm *", origin: "global" });
    assert.ok((r?.waitMs ?? 0) >= 100, `it waited: ${r?.waitMs}ms`);
  });

  it("records a prompt in a session without auto mode, answered No", async () => {
    const t = await setup({ FAKE_PI_ASK_COMMAND: "npm test" });
    await t.c.request({ type: "prompt", session: t.session, message: "/ask-select" });
    await t.c.waitFor((m: Msg) => m.type === "ui_request" && m.request?.id === "ask-select-1");
    await t.c.request({ type: "ui_response", session: t.session, response: { id: "ask-select-1", value: "No" } });
    const [r] = await t.records(1);
    assert.deepEqual([r?.by, r?.answer, r?.auto, r?.floor], ["user", "no", false, undefined]);
  });

  it("records a prompt the deny-after timer refused", async () => {
    const t = await setup({ FAKE_PI_ASK_COMMAND: "npm test", TORIEL_DENY_MIN_MS: "500" });
    await t.c.request({ type: "deny_after", session: t.session, after: "1 second" });
    await t.c.request({ type: "prompt", session: t.session, message: "/ask-select" });
    const [r] = await t.records(1);
    assert.deepEqual([r?.by, r?.answer], ["deny-after", "no"]);
    assert.ok((r?.waitMs ?? 0) >= 900);
  });

  it("does not record a question that is not a permission prompt", async () => {
    const t = await setup({});
    await t.c.request({ type: "prompt", session: t.session, message: "/ask-question" });
    await t.c.waitFor((m: Msg) => m.type === "ui_request" && m.request?.id === "question-1");
    await t.c.request({ type: "ui_response", session: t.session, response: { id: "question-1", value: "x" } });
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(await t.records(0), []);
  });
});
