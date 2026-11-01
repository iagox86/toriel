import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scheduleBadge } from "../src/switcher.ts";
import { buildStatusLine } from "../src/status.ts";
import type { SessionMeta } from "../src/shared.ts";

const NOW = new Date(2026, 9, 31, 14, 7);

describe("switcher schedule badge", () => {
  it("is empty without a schedule", () => {
    assert.equal(scheduleBadge({}, NOW), "");
  });

  it("shows the soonest run, and the count only when there are several", () => {
    const at = (h: number, m: number, d = 31) => new Date(2026, 9, d, h, m).getTime();
    assert.equal(scheduleBadge({ schedules: 1, nextFire: at(14, 30) }, NOW), " @14:30");
    assert.equal(scheduleBadge({ schedules: 3, nextFire: at(14, 30) }, NOW), " @14:30 x3");
    assert.equal(scheduleBadge({ schedules: 1, nextFire: new Date(2026, 10, 1, 9, 0).getTime() }, NOW), " @tmrw 09:00");
  });
});

describe("status line", () => {
  const meta = (over: Partial<SessionMeta>): SessionMeta => ({ id: 1, cwd: "/x", model: "p/m", messageCount: 0, streaming: false, compacting: false, dead: false, active: true, pendingDialog: false, ...over }) as SessionMeta;
  const render = (m: SessionMeta) => buildStatusLine({ switcherOpen: false, viewing: "k", meta: m, stats: { tokens: 0, cost: 0 } as never, flash: "", width: 200 });

  it("shows how many schedules the viewed session has and when the next runs", () => {
    const text = render(meta({ schedules: 2, nextFire: Date.now() + 12 * 60_000 })).replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(text, /sched 2, next \S+ \(in 1[12]m\)/);
  });

  it("says nothing when there are none", () => {
    assert.doesNotMatch(render(meta({})), /sched/);
  });
});
