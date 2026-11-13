import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type ActivityState, activityLines, reduceActivity } from "../src/activity.ts";

const fresh = (): ActivityState => ({ queue: [] });
const asst = { type: "message_start", message: { role: "assistant" } };
const strip = (s: ActivityState, now: number) => activityLines(s, 100, now).join("\n");

describe("slow provider hint", () => {
  it("says nothing while the provider keeps streaming", () => {
    const s = fresh();
    reduceActivity(s, { type: "agent_start" }, 0);
    reduceActivity(s, asst, 0);
    reduceActivity(s, { type: "message_update", assistantMessageEvent: { type: "thinking_delta" } }, 40_000);
    assert.doesNotMatch(strip(s, 60_000), /slower than usual/);
  });

  it("flags silence inside an open request, with how long", () => {
    const s = fresh();
    reduceActivity(s, { type: "agent_start" }, 0);
    reduceActivity(s, asst, 1000);
    assert.doesNotMatch(strip(s, 20_000), /slower than usual/);
    assert.match(strip(s, 151_000), /slower than usual - 2m30s/);
  });

  it("never counts tool or gap time, nor a user message", () => {
    const s = fresh();
    reduceActivity(s, { type: "agent_start" }, 0);
    reduceActivity(s, { type: "message_start", message: { role: "user" } }, 0);
    assert.doesNotMatch(strip(s, 120_000), /slower than usual/);
    reduceActivity(s, asst, 0);
    reduceActivity(s, { type: "message_end", message: { role: "assistant" } }, 1000);
    reduceActivity(s, { type: "tool_execution_start", toolName: "bash" }, 1000);
    assert.doesNotMatch(strip(s, 600_000), /slower than usual/);
  });

  it("is exempt during compaction and gone after settling", () => {
    const s = fresh();
    reduceActivity(s, { type: "agent_start" }, 0);
    reduceActivity(s, asst, 0);
    reduceActivity(s, { type: "compaction_start" }, 1000);
    assert.doesNotMatch(strip(s, 300_000), /slower than usual/);
    reduceActivity(s, asst, 400_000);
    reduceActivity(s, { type: "agent_settled" }, 401_000);
    assert.doesNotMatch(strip(s, 900_000), /slower than usual/);
  });
});
