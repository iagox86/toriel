import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { loadHandled, recordHandled } from "../src/handled-files.ts";
import { isExternalRow } from "../src/session-list.ts";
import { loadSettings } from "../src/settings.ts";
import { type SwitcherSession, Switcher } from "../src/switcher.ts";
import { SwitcherActions } from "../src/switcher-actions.ts";

const row = (over: Partial<SwitcherSession>): SwitcherSession => ({ key: "/s/a.jsonl", name: "a", state: "inactive", cwd: "/s", ...over }) as SwitcherSession;

describe("isExternalRow", () => {
  const none = new Set<string>();

  it("hides a file nothing in toriel has touched", () => {
    assert.equal(isExternalRow(row({}), none), true);
  });

  it("keeps daemon-owned sessions, including ones that are only inactive records", () => {
    assert.equal(isExternalRow(row({ daemonId: 3 }), none), false);
  });

  it("treats a presence pseudo-entry (negative id) as external", () => {
    assert.equal(isExternalRow(row({ daemonId: -1 }), none), true);
  });

  it("keeps sessions toriel ran a child on before, filed in a group, or being viewed", () => {
    assert.equal(isExternalRow(row({}), new Set(["/s/a.jsonl"])), false);
    assert.equal(isExternalRow(row({ group: "work" }), none), false);
    assert.equal(isExternalRow(row({}), none, new Set(["/s/a.jsonl"])), false);
  });
});

describe("the switcher list", () => {
  function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-ext-"));
    process.env.XDG_DATA_HOME = dir;
    process.env.TORIEL_SETTINGS = path.join(dir, "settings.json");
    const sw = new Switcher();
    const local = new Map(
      ["a", "b"].map((id) => [`/s/${id}.jsonl`, { path: `/s/${id}.jsonl`, id, cwd: "/w", firstMessage: id, lastActivity: "", modified: Date.now() - 3600_000, name: id }]),
    );
    const host = {
      tui: { requestRender() {}, terminal: { rows: 30 } },
      editor: { getText: () => "", setText() {} },
      switcher: sw,
      sessions: new Map(),
      local,
      views: new Map(),
      summaries: new Map(),
      viewing: "/s/b.jsonl",
      send() {},
      notify() {},
      request: async () => ({}),
      uniqueSessionName: (n: string) => n,
      metaForPath: () => undefined,
    };
    const actions = new SwitcherActions(host as never);
    (host as { switching?: unknown }).switching = actions;
    return { sw, actions, dir };
  }

  it("hides files toriel never ran, except the one being viewed, and says how many", () => {
    const { sw, actions } = setup();
    actions.refresh();
    assert.deepEqual(
      sw.sessions.map((s) => s.key),
      ["/s/b.jsonl"],
    );
    assert.match(sw.filterNote, /1 outside session hidden {2}- {2}\/external show/);
  });

  it("/external show lists them all, /external hide hides them again", async () => {
    const { sw, actions } = setup();
    actions.refresh();
    await actions.runCommand("/external show", undefined);
    assert.equal(sw.sessions.length, 2);
    assert.equal(sw.filterNote, "");
    await actions.runCommand("/external", undefined);
    assert.equal(sw.sessions.length, 1);
  });
});

describe("handled-files listing", () => {
  it("reads back what was recorded", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-handled-"));
    const file = path.join(dir, "handled.json");
    assert.equal(loadHandled(file).size, 0);
    recordHandled("/s/a.jsonl", file);
    assert.deepEqual([...loadHandled(file)], ["/s/a.jsonl"]);
  });
});

describe("showExternalSessions setting", () => {
  it("is a boolean, default off", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-set-"));
    const file = path.join(dir, "settings.json");
    assert.equal(loadSettings(file).settings.showExternalSessions, undefined);
    fs.writeFileSync(file, JSON.stringify({ showExternalSessions: true }));
    assert.equal(loadSettings(file).settings.showExternalSessions, true);
    fs.writeFileSync(file, JSON.stringify({ showExternalSessions: "yes" }));
    assert.match(loadSettings(file).problems.join(), /showExternalSessions must be true or false/);
  });
});
