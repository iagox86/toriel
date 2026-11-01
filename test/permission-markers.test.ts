import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionMeta } from "../src/shared.ts";
import { buildStatusLine } from "../src/status.ts";

const meta = (over: Partial<SessionMeta>): SessionMeta => ({ id: 1, cwd: "/x", model: "p/m", messageCount: 0, streaming: false, compacting: false, dead: false, active: true, pendingDialog: false, ...over }) as SessionMeta;
const render = (m: SessionMeta, width = 200) => buildStatusLine({ switcherOpen: false, viewing: "k", meta: m, stats: { tokens: 0, cost: 0 } as never, flash: "", width }).replace(/\x1b\[[0-9;]*m/g, "");

describe("status line: permission grants", () => {
  it("counts the active grants, with when the soonest timed one ends", () => {
    assert.match(render(meta({ grants: 2, nextGrantExpiry: Date.now() + 30 * 60_000 })), /grants 2, next ends \S+ \(in (29|30)m\)/);
    assert.match(render(meta({ grants: 1 })), /grants 1(?!,)/);
  });

  it("warns when saved grants are waiting to be turned on, and says how", () => {
    assert.match(render(meta({ grantsSaved: 1 })), /1 saved grant off \(\/permissions restore\)/);
    assert.match(render(meta({ grantsSaved: 3 })), /3 saved grants off/);
  });

  it("says nothing when there are none", () => {
    assert.doesNotMatch(render(meta({})), /grant/);
  });

  it("drops the grant count before the saved-grants warning when the line is tight", () => {
    const m = meta({ grants: 2, nextGrantExpiry: Date.now() + 3_600_000, grantsSaved: 1 });
    const tight = render(m, 70);
    assert.doesNotMatch(tight, /grants 2/);
    assert.match(tight, /saved grant/);
  });
});
