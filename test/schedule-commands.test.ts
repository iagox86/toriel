import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Host } from "../src/host.ts";
import { operateSchedule } from "../src/schedule-commands.ts";
import type { ScheduleView } from "../src/shared.ts";

const view = (over: Partial<ScheduleView>): ScheduleView => ({
  id: 1,
  session: "11111111-2222-3333-4444-555555555555",
  prompt: "check the build",
  when: "every 30m",
  state: "active",
  next: Date.now() + 600_000,
  fired: 0,
  expiresAt: null,
  by: "user",
  catchup: "once",
  ...over,
});

function fakeHost(schedules: ScheduleView[]) {
  const requests: Array<Record<string, unknown>> = [];
  const notices: string[] = [];
  const panels: Array<{ title: string; choices: string[]; pick: (c: string) => void }> = [];
  const host = {
    notify: (m: string) => void notices.push(m),
    tui: { requestRender: () => {} },
    choicePanel: { open: (title: string, choices: string[], _current: unknown, pick: (c: string) => void) => void panels.push({ title, choices, pick }) },
    request: async (cmd: Record<string, unknown>) => {
      requests.push(cmd);
      if (cmd.type === "schedule_list") {
        return { schedules };
      }
      return { schedules: schedules.filter((s) => String(s.id) === cmd.ref), count: 1 };
    },
  };
  return { host: host as unknown as Host, requests, notices, panels };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("/cancel and friends with no schedule named", () => {
  it("offer a pick list of the schedules in scope, and acting on the pick uses its id", async () => {
    const { host, requests, notices, panels } = fakeHost([view({ id: 1, name: "poll" }), view({ id: 2, prompt: "other" })]);
    await operateSchedule(host, "cancel", { args: [], opts: {} }, 7);
    assert.equal(panels.length, 1);
    assert.equal(panels[0]?.title, "Cancel which schedule?");
    assert.match(panels[0]?.choices[0] ?? "", /^#1 poll - every 30m, next .*: check the build$/);
    assert.deepEqual(requests[0], { type: "schedule_list", session: 7 });
    panels[0]?.pick(panels[0].choices[1] as string);
    await settle();
    assert.deepEqual(requests.at(-1), { type: "schedule_op", op: "cancel", ref: "2", all: false, session: 7 });
    assert.deepEqual(notices, ["cancelled #2"]);
  });

  it("only offers what the command can act on", async () => {
    const schedules = [view({ id: 1, state: "paused", next: undefined }), view({ id: 2 })];
    const resume = fakeHost(schedules);
    await operateSchedule(resume.host, "resume", { args: [], opts: {} }, 1);
    assert.deepEqual(resume.panels[0]?.choices.map((c) => c.slice(0, 2)), ["#1"]);
    const pause = fakeHost(schedules);
    await operateSchedule(pause.host, "pause", { args: [], opts: {} }, 1);
    assert.deepEqual(pause.panels[0]?.choices.map((c) => c.slice(0, 2)), ["#2"]);
  });

  it("names the session on each choice when listing across sessions (the switcher)", async () => {
    const { host, panels } = fakeHost([view({ sessionName: "Mealie" })]);
    await operateSchedule(host, "cancel", { args: [], opts: {} }, undefined);
    assert.match(panels[0]?.choices[0] ?? "", /\[Mealie\]/);
  });

  it("says so instead of opening an empty list", async () => {
    const { host, notices, panels } = fakeHost([]);
    await operateSchedule(host, "cancel", { args: [], opts: {} }, 1);
    assert.equal(panels.length, 0);
    assert.match(notices[0] ?? "", /no schedules/);
  });

  it("does not pick when an id or --all was given", async () => {
    const { host, requests, panels } = fakeHost([view({})]);
    await operateSchedule(host, "cancel", { args: ["1"], opts: {} }, 1);
    await operateSchedule(host, "cancel", { args: [], opts: { all: true } }, 1);
    assert.equal(panels.length, 0);
    assert.deepEqual(requests.map((r) => r.type), ["schedule_op", "schedule_op"]);
  });
});
