import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Host } from "../src/host.ts";
import { SessionCommands } from "../src/session-commands.ts";

const KEY = "/tmp/fake/session.jsonl";

function fakeHost() {
  const requests: Array<Record<string, unknown>> = [];
  const notices: string[] = [];
  const opened: Array<{ title: string; choices: string[]; current: string | undefined; pick: (c: string) => void }> = [];
  const host = {
    viewing: KEY,
    editor: { setText: () => {} },
    tui: { requestRender: () => {} },
    notify: (m: string) => void notices.push(m),
    metaForPath: () => ({ id: 7, active: true }),
    choicePanel: { open: (title: string, choices: string[], current: string | undefined, pick: (c: string) => void) => void opened.push({ title, choices, current, pick }) },
    request: async (cmd: Record<string, unknown>) => {
      requests.push(cmd);
      return cmd.level === undefined ? { current: "medium", levels: ["off", "low", "medium", "high"] } : { level: cmd.level };
    },
  };
  return { host: host as unknown as Host, requests, notices, opened };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("/think", () => {
  it("opens a picker of the model's levels with the current one marked, and picking sets it", async () => {
    const { host, requests, notices, opened } = fakeHost();
    new SessionCommands(host).run("/think");
    await settle();
    assert.equal(opened.length, 1);
    assert.deepEqual([opened[0]?.title, opened[0]?.choices, opened[0]?.current], ["Thinking level", ["off", "low", "medium", "high"], "medium"]);
    opened[0]?.pick("high");
    await settle();
    assert.deepEqual(requests.at(-1), { type: "think", session: 7, level: "high" });
    assert.deepEqual(notices, ["thinking level: high"]);
  });

  it("with -l only shows the levels in a notice", async () => {
    const { host, notices, opened } = fakeHost();
    new SessionCommands(host).run("/think -l");
    await settle();
    assert.equal(opened.length, 0);
    assert.deepEqual(notices, ["thinking level: medium (available: off, low, medium, high)"]);
  });

  it("with a level sets it without a picker", async () => {
    const { host, requests, opened } = fakeHost();
    new SessionCommands(host).run("/think low");
    await settle();
    assert.equal(opened.length, 0);
    assert.deepEqual(requests, [{ type: "think", session: 7, level: "low" }]);
  });
});
