// The staleness verdicts of /mcp explore records (tickets 308, 330): which servers need a re-explore, and the one-liners the
// command notice and the doctor finding show.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MCP_SKILL_STALE_DAYS, stalenessReason, stalenessVerdict, type StalenessInput } from "../src/mcp-staleness.ts";

const DAY = 86_400_000;
const NOW = new Date(2026, 4, 20, 12, 0, 0);
const AT = new Date(2026, 4, 10, 12, 0, 0);

const input = (over: Partial<StalenessInput> = {}): StalenessInput => ({
  hasSkill: true,
  record: { at: AT.toISOString(), hash: "hash-a" },
  now: NOW,
  ...over,
});

describe("stalenessVerdict", () => {
  it("is fresh when the skill exists, the explore is recent, and the sighting saw the same tools at or after it was written", () => {
    const fresh = { kind: "fresh" } as const;
    assert.deepEqual(stalenessVerdict(input({ latest: { hash: "hash-a", at: AT.toISOString() } })), fresh, "seen exactly at the write counts as seen");
    assert.deepEqual(stalenessVerdict(input({ latest: { hash: "hash-a", at: new Date(AT.getTime() + 86_400_000).toISOString() } })), fresh, "seen the day after");
    assert.deepEqual(stalenessVerdict(input()), fresh, "the server was never seen connected: no sighting");
    assert.deepEqual(stalenessVerdict(input({ record: { at: new Date(NOW.getTime() - (MCP_SKILL_STALE_DAYS * DAY - 1)).toISOString(), hash: "hash-a" }, latest: { hash: "hash-a", at: AT.toISOString() } })), fresh, "one millisecond short of 30 days is still fresh");
  });

  it("does not count a sighting from before the skill was written: the record's age decides (ticket 308)", () => {
    const fresh = { kind: "fresh" } as const;
    const oldSeen = { hash: "hash-a", at: new Date(AT.getTime() - 86_400_000).toISOString() };
    assert.deepEqual(stalenessVerdict(input({ latest: oldSeen })), fresh, "a fresh record with an older sighting is fresh");
    const oldRecord = { at: new Date(NOW.getTime() - 40 * DAY).toISOString(), hash: "hash-a" };
    assert.deepEqual(
      stalenessVerdict(input({ record: oldRecord, latest: { hash: "hash-a", at: new Date(NOW.getTime() - 60 * DAY).toISOString() } })),
      { kind: "old" },
      "with the record 40 days old and the sighting older still, the age decides",
    );
    assert.deepEqual(stalenessVerdict(input({ latest: { hash: "different", at: "not a date" } })), fresh, "an unreadable sighting is not evidence");
  });

  it("is old at exactly the 30-day boundary, and later", () => {
    const boundary = input({ record: { at: new Date(NOW.getTime() - MCP_SKILL_STALE_DAYS * DAY).toISOString(), hash: "hash-a" } });
    assert.deepEqual(stalenessVerdict(boundary), { kind: "old" }, "age == MCP_SKILL_STALE_DAYS");
    const older = input({ record: { at: new Date(NOW.getTime() - (MCP_SKILL_STALE_DAYS * DAY + 1)).toISOString(), hash: "hash-a" } });
    assert.deepEqual(stalenessVerdict(older), { kind: "old" });
  });

  it("is changed when a sighting from the write time on saw other tools, whatever the age", () => {
    assert.deepEqual(stalenessVerdict(input({ latest: { hash: "hash-b", at: AT.toISOString() } })), { kind: "changed" }, "tools changed after the explore");
    const oldAndChanged = input({ latest: { hash: "hash-b", at: new Date(NOW.getTime() - 89 * DAY).toISOString() }, record: { at: new Date(NOW.getTime() - 90 * DAY).toISOString(), hash: "hash-a" } });
    assert.deepEqual(stalenessVerdict(oldAndChanged), { kind: "changed" }, "changed wins over old");
    assert.deepEqual(stalenessVerdict(input({ latest: { hash: "hash-b", at: AT.toISOString() }, record: { at: "not a date", hash: "hash-a" } })), { kind: "changed" }, "even with an unreadable explore date");
    assert.deepEqual(stalenessVerdict(input({ latest: { hash: "hash-b", at: new Date(AT.getTime() - 86_400_000).toISOString() } })), { kind: "fresh" }, "but not from before the skill was written");
  });

  it("is old for an unreadable record date, without throwing", () => {
    assert.deepEqual(stalenessVerdict(input({ record: { at: "yesterday-ish", hash: "hash-a" } })), { kind: "old" });
  });

  it("knows nothing when there is no explore record, however much the server has been seen since", () => {
    const noRecord = { kind: "no-record" } as const;
    assert.deepEqual(stalenessVerdict(input({ record: undefined })), noRecord);
    assert.deepEqual(stalenessVerdict(input({ record: undefined, latest: { hash: "hash-b", at: AT.toISOString() } })), noRecord);
  });

  it("is no-skill before anything else", () => {
    const noSkill = { kind: "no-skill" } as const;
    assert.deepEqual(stalenessVerdict(input({ hasSkill: false })), noSkill);
    assert.deepEqual(stalenessVerdict(input({ hasSkill: false, latest: { hash: "hash-b", at: AT.toISOString() } })), noSkill);
  });
});

describe("stalenessReason", () => {
  it("says what is wrong for each verdict", () => {
    assert.equal(stalenessReason({ kind: "no-skill" }, input({ hasSkill: false })), "no skill yet");
    assert.equal(stalenessReason({ kind: "no-record" }, input({ record: undefined })), "no record of a previous explore");
    assert.equal(stalenessReason({ kind: "changed" }, input({ latest: { hash: "hash-b", at: AT.toISOString() } })), "the server's tools changed after the explore on 2026-05-10");
    assert.equal(stalenessReason({ kind: "old" }, input({ record: { at: new Date(NOW.getTime() - 45 * DAY).toISOString(), hash: "hash-a" } })), "explored 45 days ago");
    assert.equal(stalenessReason({ kind: "old" }, input({ record: { at: new Date(NOW.getTime() - MCP_SKILL_STALE_DAYS * DAY).toISOString(), hash: "hash-a" } })), "explored 30 days ago", "exactly at the boundary");
    assert.equal(stalenessReason({ kind: "fresh" }, input()), "up to date");
  });

  it("keeps a usable line when the record's date cannot be read", () => {
    assert.match(stalenessReason({ kind: "old" }, input({ record: { at: "not a date", hash: "hash-a" } })), /explored more than 30 days ago/);
    assert.match(stalenessReason({ kind: "changed" }, input({ latest: { hash: "hash-b", at: AT.toISOString() }, record: { at: "not a date", hash: "hash-a" } })), /changed since the skill was written/);
  });
});
