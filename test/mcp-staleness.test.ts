// The staleness verdicts of /mcp explore records (tickets 308, 330): which servers need a re-explore, and the one-liners the
// command notice and the doctor finding show.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MCP_SKILL_STALE_DAYS, stalenessReason, stalenessVerdict, type StalenessInput } from "../src/mcp-staleness.ts";

const DAY = 86_400_000;
const NOW = new Date(2026, 4, 20, 12, 0, 0);
const AT = new Date(2026, 4, 10, 12, 0, 0);

const input = (over: Partial<StalenessInput> = {}): StalenessInput => ({
  server: "git",
  hasSkill: true,
  record: { at: AT.toISOString(), hash: "hash-a" },
  now: NOW,
  ...over,
});

describe("stalenessVerdict", () => {
  it("is fresh when the skill exists, the explore is recent, and the last-seen hash matches or is not known", () => {
    const fresh = { kind: "fresh" } as const;
    assert.deepEqual(stalenessVerdict(input({ latestHash: "hash-a" })), fresh, "the run that came after saw the same tools");
    assert.deepEqual(stalenessVerdict(input()), fresh, "the server was never seen connected: no latest hash");
    assert.deepEqual(stalenessVerdict(input({ record: { at: new Date(NOW.getTime() - (MCP_SKILL_STALE_DAYS * DAY - 1)).toISOString(), hash: "hash-a" }, latestHash: "hash-a" })), fresh, "one millisecond short of 30 days is still fresh");
  });

  it("is old at exactly the 30-day boundary, and later", () => {
    const boundary = input({ record: { at: new Date(NOW.getTime() - MCP_SKILL_STALE_DAYS * DAY).toISOString(), hash: "hash-a" } });
    assert.deepEqual(stalenessVerdict(boundary), { kind: "old" }, "age == MCP_SKILL_STALE_DAYS");
    const older = input({ record: { at: new Date(NOW.getTime() - (MCP_SKILL_STALE_DAYS * DAY + 1)).toISOString(), hash: "hash-a" } });
    assert.deepEqual(stalenessVerdict(older), { kind: "old" });
  });

  it("is changed when the last-seen hash differs from the explore record's, whatever the age", () => {
    assert.deepEqual(stalenessVerdict(input({ latestHash: "hash-b" })), { kind: "changed" }, "tools changed after the explore");
    const oldAndChanged = input({ latestHash: "hash-b", record: { at: new Date(NOW.getTime() - 90 * DAY).toISOString(), hash: "hash-a" } });
    assert.deepEqual(stalenessVerdict(oldAndChanged), { kind: "changed" }, "changed wins over old");
    assert.deepEqual(stalenessVerdict(input({ latestHash: "hash-b", record: { at: "not a date", hash: "hash-a" } })), { kind: "changed" }, "even with an unreadable date");
  });

  it("is old for an unreadable record date, without throwing", () => {
    assert.deepEqual(stalenessVerdict(input({ record: { at: "yesterday-ish", hash: "hash-a" } })), { kind: "old" });
  });

  it("knows nothing when there is no explore record, however much the server has been seen since", () => {
    assert.deepEqual(stalenessVerdict(input({ record: undefined })), { kind: "unknown-time" });
    assert.deepEqual(stalenessVerdict(input({ record: undefined, latestHash: "hash-b" })), { kind: "unknown-time" });
  });

  it("is no-skill before anything else", () => {
    assert.deepEqual(stalenessVerdict(input({ hasSkill: false })), { kind: "no-skill" });
    assert.deepEqual(stalenessVerdict(input({ hasSkill: false, latestHash: "hash-b" })), { kind: "no-skill" });
  });
});

describe("stalenessReason", () => {
  it("says what is wrong for each verdict", () => {
    assert.equal(stalenessReason({ kind: "no-skill" }, input({ hasSkill: false })), "no skill yet");
    assert.equal(stalenessReason({ kind: "unknown-time" }, input({ record: undefined })), "no record of a previous explore");
    assert.equal(stalenessReason({ kind: "changed" }, input({ latestHash: "hash-b" })), "the server's tools changed after the explore on 2026-05-10");
    assert.equal(stalenessReason({ kind: "old" }, input({ record: { at: new Date(NOW.getTime() - 45 * DAY).toISOString(), hash: "hash-a" } })), "explored 45 days ago");
    assert.equal(stalenessReason({ kind: "old" }, input({ record: { at: new Date(NOW.getTime() - MCP_SKILL_STALE_DAYS * DAY).toISOString(), hash: "hash-a" } })), "explored 30 days ago", "exactly at the boundary");
    assert.equal(stalenessReason({ kind: "fresh" }, input()), "up to date");
  });

  it("keeps a usable line when the record's date cannot be read", () => {
    assert.match(stalenessReason({ kind: "old" }, input({ record: { at: "not a date", hash: "hash-a" } })), /explored more than 30 days ago/);
    assert.match(stalenessReason({ kind: "changed" }, input({ latestHash: "hash-b", record: { at: "not a date", hash: "hash-a" } })), /changed since the skill was written/);
  });
});
