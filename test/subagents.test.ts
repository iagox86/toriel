import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentProfile } from "../src/agents.ts";
import { subagentDepth } from "../src/lineage.ts";
import { abnormalEnd, INJECT_TYPES, mayDelegate, childBudget, lastAssistantText, subagentResultText, messageTokens, DEFAULT_SUBAGENT_LIMITS, describeRecord, expiredSubagents, keepMsFrom, type SweepCandidate, limitBreach, parseHandle, refuseSpawn, resultText, SubagentBook } from "../src/subagents.ts";
import { isInjectType } from "../src/transcript.ts";

const L = DEFAULT_SUBAGENT_LIMITS;
const profile = (over: Partial<AgentProfile> = {}): AgentProfile => ({ name: "explore", description: "d", prompt: "", canSpawn: false, minimal: true, extensions: true, source: "built-in", file: "x", ...over });
const add = (book: SubagentBook, parent = "p", session = 1) => book.add({ parent, session, agent: "explore", description: "look", background: false, budget: 1000 });

describe("refuseSpawn", () => {
  it("allows a session the user started", () => {
    assert.equal(refuseSpawn({ limits: L, book: new SubagentBook(), parent: "p", parentDepth: 0 }), undefined);
  });

  it("refuses a subagent, whose profile cannot spawn, with the reason", () => {
    const why = refuseSpawn({ limits: L, book: new SubagentBook(), parent: "p", parentProfile: profile(), parentDepth: 1 });
    assert.match(why ?? "", /may not start subagents/);
  });

  it("refuses by depth even for a profile that may spawn, and honours a raised limit up to the hard cap", () => {
    const base = { book: new SubagentBook(), parent: "p", parentProfile: profile({ canSpawn: true }) };
    assert.match(refuseSpawn({ ...base, limits: L, parentDepth: 1 }) ?? "", /depth limit 1/);
    assert.equal(refuseSpawn({ ...base, limits: { ...L, maxDepth: 2 }, parentDepth: 1 }), undefined);
    assert.match(refuseSpawn({ ...base, limits: { ...L, maxDepth: 9 }, parentDepth: 2 }) ?? "", /depth limit 2/);
  });

  it("refuses the fourth concurrent subagent and the twenty-first for one parent", () => {
    const book = new SubagentBook();
    for (let i = 0; i < 3; i++) {
      add(book, `q${i}`, i);
    }
    assert.match(refuseSpawn({ limits: L, book, parent: "p", parentDepth: 0 }) ?? "", /3 subagents are already running/);
    const many = new SubagentBook();
    for (let i = 0; i < 20; i++) {
      const rec = add(many, "p", i);
      rec.state = "done";
    }
    assert.match(refuseSpawn({ limits: L, book: many, parent: "p", parentDepth: 0 }) ?? "", /already started 20/);
    assert.equal(refuseSpawn({ limits: L, book: many, parent: "other", parentDepth: 0 }), undefined);
  });
});

describe("childBudget", () => {
  it("uses the profile's budget, else the default, capped by what the parent has left", () => {
    assert.equal(childBudget(undefined, L, undefined), 150_000);
    assert.equal(childBudget(40_000, L, undefined), 40_000);
    assert.equal(childBudget(40_000, L, 10_000), 10_000);
    assert.equal(childBudget(undefined, L, 0), 0);
  });
});

describe("limitBreach", () => {
  it("cuts a run that goes on past its token budget or its turns, never one that is ending", () => {
    assert.match(limitBreach({ turns: 2, tokens: 120, budget: 100, continuing: true }) ?? "", /over its budget of 100/);
    assert.match(limitBreach({ turns: 3, maxTurns: 3, tokens: 1, budget: 100, continuing: true }) ?? "", /limit of 3 turns/);
    assert.equal(limitBreach({ turns: 3, maxTurns: 3, tokens: 500, budget: 100, continuing: false }), undefined);
    assert.equal(limitBreach({ turns: 2, maxTurns: 3, tokens: 1, budget: 100, continuing: true }), undefined);
  });
});

describe("records", () => {
  it("numbers handles, finds them by session and child, and describes them", () => {
    const book = new SubagentBook();
    const a = add(book, "p", 7);
    a.childId = "c1";
    assert.equal(a.handle, 1);
    assert.equal(book.bySession(7), a);
    assert.equal(book.byChild("c1"), a);
    assert.match(describeRecord(a, a.startedAt + 3000), /^#1 explore: look \[running, 0 turn\(s\), 0\/1000 tokens, 3s\]/);
  });

  it("words a result by how the subagent ended", () => {
    const book = new SubagentBook();
    const rec = add(book);
    assert.match(resultText(rec), /still running/);
    rec.state = "done";
    rec.result = "found it";
    assert.equal(resultText(rec), "found it");
    rec.state = "limit";
    rec.note = "stopped: it reached its limit of 3 turns";
    assert.match(resultText(rec), /limit of 3 turns[\s\S]*Partial result:\nfound it/);
  });

  it("reads #2 and 2 as handle 2 and nothing else", () => {
    assert.equal(parseHandle("#2"), 2);
    assert.equal(parseHandle(" 2 "), 2);
    assert.equal(parseHandle("two"), undefined);
    assert.equal(parseHandle(undefined), undefined);
  });
});

describe("subagentDepth", () => {
  it("counts subagent links above a session", () => {
    const parents = new Map([["c", "b"], ["b", "a"]]);
    assert.deepEqual([subagentDepth("a", parents), subagentDepth("b", parents), subagentDepth("c", parents), subagentDepth(undefined, parents)], [0, 1, 2, 0]);
  });
});

describe("expiredSubagents", () => {
  const HOUR = 3_600_000;
  const NOW = 10 * HOUR;
  const cand = (over: Partial<SweepCandidate> = {}): SweepCandidate => ({ uuid: "u", mtime: 0, live: false, ...over });
  const ids = (cs: SweepCandidate[]) => expiredSubagents(cs, NOW, 30 * 60_000).map((c) => c.uuid);

  it("expires a finished subagent 30 minutes after its parent had the result", () => {
    const rec = { state: "done" as const, endedAt: NOW - HOUR, deliveredAt: NOW - 31 * 60_000 };
    assert.deepEqual(ids([cand({ record: rec }), cand({ uuid: "late", record: { ...rec, deliveredAt: NOW - 29 * 60_000 } })]), ["u"]);
  });

  it("starts a background subagent's window at delivery, not at the end of its run", () => {
    const rec = { state: "done" as const, endedAt: NOW - 2 * HOUR, deliveredAt: NOW - 60_000 };
    assert.deepEqual(ids([cand({ record: rec })]), []);
  });

  it("keeps one that is running, live, or was written to since", () => {
    const old = { state: "done" as const, endedAt: NOW - 5 * HOUR, deliveredAt: NOW - 5 * HOUR };
    assert.deepEqual(ids([cand({ record: { ...old, state: "running" } }), cand({ uuid: "live", live: true, record: old }), cand({ uuid: "used", mtime: NOW - 60_000, record: old })]), []);
  });

  it("dates a subagent from before a restart by its file alone, and never expires one it cannot date", () => {
    assert.deepEqual(ids([cand({ uuid: "old", mtime: NOW - HOUR }), cand({ uuid: "fresh", mtime: NOW - 60_000 }), cand({ uuid: "unknown", mtime: 0 })]), ["old"]);
  });
});

describe("keepMsFrom", () => {
  it("reads a non-negative number of ms (0 included) and falls back to 30 minutes for anything else", () => {
    assert.deepEqual(["1500", "0", "-5", "abc", "", undefined].map(keepMsFrom), [1500, 0, 1_800_000, 1_800_000, 1_800_000, 1_800_000]);
  });
});

describe("messageTokens", () => {
  it("counts fresh input, output and cache writes but not the context a turn re-reads from the cache", () => {
    assert.equal(messageTokens({ input: 1229, output: 40, cacheWrite: 0 }), 1269);
    assert.equal(messageTokens({ input: 10, output: 5, cacheWrite: 100 }), 115);
    assert.equal(messageTokens(undefined), 0);
  });
});

describe("abnormalEnd", () => {
  it("calls a settle on an abort stopped and one on an error failed, with the reason", () => {
    assert.deepEqual(abnormalEnd("aborted", undefined), { state: "stopped", note: "was interrupted (aborted) before it finished" });
    assert.deepEqual(abnormalEnd("error", "rate limited"), { state: "failed", note: "ended with an error: rate limited" });
    assert.equal(abnormalEnd("error", undefined)?.note, "ended with an error");
  });

  it("leaves a normal finish alone", () => {
    assert.equal(abnormalEnd("stop", undefined), undefined);
    assert.equal(abnormalEnd("length", undefined), undefined);
  });

  it("does not take a run that settled without a final answer for done", () => {
    assert.equal(abnormalEnd("toolUse", undefined)?.state, "failed");
    assert.match(abnormalEnd("toolUse", undefined)?.note ?? "", /tool call, with no final answer/);
    assert.equal(abnormalEnd(undefined, undefined)?.state, "failed");
    assert.match(abnormalEnd(undefined, undefined)?.note ?? "", /without producing an answer/);
  });
});

describe("lastAssistantText", () => {
  it("finds the newest assistant text, skipping empty error messages and other roles", () => {
    const messages = [
      { role: "assistant", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: "the review so far" }] },
      { role: "toolResult", content: [{ type: "text", text: "Operation aborted" }] },
      { role: "assistant", content: [] },
    ];
    assert.equal(lastAssistantText(messages), "the review so far");
    assert.equal(lastAssistantText([{ role: "assistant", content: [] }]), undefined);
  });
});

describe("subagentResultText", () => {
  const report = "x".repeat(2000);
  const ack = "That is the same npm test run already reported above. Nothing new to add.";
  const mid = "y".repeat(1200);
  const notice = (customType: string) => ({ role: "custom", customType, content: [] });

  it("returns the report when a job notice sits between it and a short acknowledgment", () => {
    const messages = [
      { role: "assistant", content: [{ type: "text", text: report }] },
      notice("toriel-job"),
      { role: "assistant", content: [{ type: "text", text: ack }] },
    ];
    assert.equal(subagentResultText(messages), report);
  });

  it("returns the newest text when a notice sits between but the previous is not twice as long", () => {
    const messages = [
      { role: "assistant", content: [{ type: "text", text: mid }] },
      notice("toriel-inject"),
      { role: "assistant", content: [{ type: "text", text: "z".repeat(1000) }] },
    ];
    assert.equal(subagentResultText(messages), "z".repeat(1000));
  });

  it("returns the newest text when a terse answer follows a long text with no notice between", () => {
    const messages = [
      { role: "assistant", content: [{ type: "text", text: report }] },
      { role: "assistant", content: [{ type: "text", text: "src/foo.ts:42" }] },
    ];
    assert.equal(subagentResultText(messages), "src/foo.ts:42");
  });

  it("returns the long previous text when a notice-triggered terse answer follows it (the original bug)", () => {
    const messages = [
      { role: "assistant", content: [{ type: "text", text: report }] },
      notice("ronpi-inject"),
      { role: "assistant", content: [{ type: "text", text: "src/foo.ts:42" }] },
    ];
    assert.equal(subagentResultText(messages), report);
  });

  it("prefers the previous text at exactly twice the length when a notice sits between", () => {
    const messages = [
      { role: "assistant", content: [{ type: "text", text: "a".repeat(200) }] },
      notice("toriel-job"),
      { role: "assistant", content: [{ type: "text", text: "b".repeat(100) }] },
    ];
    assert.equal(subagentResultText(messages), "a".repeat(200));
  });

  it("returns the terse final answer when the previous text is short, notice or not", () => {
    const messages = [
      { role: "assistant", content: [{ type: "text", text: "some short note" }] },
      notice("toriel-job"),
      { role: "assistant", content: [{ type: "text", text: "src/foo.ts:42" }] },
    ];
    assert.equal(subagentResultText(messages), "src/foo.ts:42");
  });

  it("skips empty and whitespace-only texts, ignores non-assistant roles and non-array content", () => {
    const messages = [
      { role: "assistant", content: [{ type: "text", text: report }] },
      { role: "assistant", content: [{ type: "text", text: "   " }] },
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: "not an array" },
      notice("toriel-job"),
      { role: "assistant", content: [{ type: "text", text: ack }] },
    ];
    assert.equal(subagentResultText(messages), report);
  });

  it("returns undefined when there are no assistant texts", () => {
    const messages = [
      { role: "assistant", content: [] },
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ];
    assert.equal(subagentResultText(messages), undefined);
  });

  it("knows every inject type the transcript classifier knows (the copied set must not drift)", () => {
    for (const type of INJECT_TYPES) {
      assert.equal(isInjectType(type), true, `${type} is an inject type in transcript.ts too`);
    }
  });
});

describe("mayDelegate", () => {
  it("follows the limits it is given: sessions below maxDepth whose profile allows spawning", () => {
    assert.equal(mayDelegate(undefined, 0, L), true);
    assert.equal(mayDelegate(undefined, 1, L), false);
    assert.equal(mayDelegate(undefined, 1, { ...L, maxDepth: 2 }), true);
    assert.equal(mayDelegate(undefined, 2, { ...L, maxDepth: 9 }), false, "the hard cap holds");
    assert.equal(mayDelegate(profile(), 0, L), false, "a profile without canSpawn");
    assert.equal(mayDelegate(profile({ canSpawn: true }), 0, L), true);
  });
});
