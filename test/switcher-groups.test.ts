import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadGroups, saveGroups } from "../src/groups.ts";
import { SWITCHER_COMMANDS } from "../src/commands.ts";
import { INIT_PROMPT } from "../src/init-prompt.ts";
import { SwitcherActions } from "../src/switcher-actions.ts";
import { Switcher } from "../src/switcher.ts";

const CTRL_X = "\x18";
let dir: string;
const saved = process.env.XDG_DATA_HOME;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-sw-"));
  process.env.XDG_DATA_HOME = dir;
});

afterEach(() => {
  process.env.XDG_DATA_HOME = saved;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A switcher over one ungrouped session, a group holding one session, and an empty group. */
function setup(request: (cmd: Record<string, unknown>) => Promise<unknown> = async () => ({})) {
  saveGroups({ groups: ["Full", "Empty"], assignments: { a: null, b: "Full" } });
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
    viewing: null,
    send() {},
    notify() {},
    request,
    uniqueSessionName: (n: string) => n,
    metaForPath: () => undefined,
  };
  const actions = new SwitcherActions(host as never);
  (host as { switching?: unknown }).switching = actions;
  actions.refresh();
  const goTo = (title: string) => {
    for (let i = 0; i < 10 && !(sw.currentIsHeader() && sw.currentHeaderTitle() === title); i++) {
      sw.move(1);
    }
    assert.equal(sw.currentHeaderTitle(), title);
  };
  return { sw, actions, goTo, host };
}

describe("deleting a group", () => {
  it("asks for a second ctrl-x before deleting an empty group", () => {
    const { sw, actions, goTo } = setup();
    goTo("Empty");
    actions.keys(CTRL_X);
    assert.match(sw.hint, /ctrl-x again to delete this group/);
    assert.ok(loadGroups().groups.includes("Empty"));
    actions.keys(CTRL_X);
    assert.ok(!loadGroups().groups.includes("Empty"));
  });

  it("explains why a group with sessions cannot be deleted, without arming it", () => {
    const { sw, actions, goTo } = setup();
    goTo("Full");
    actions.keys(CTRL_X);
    assert.doesNotMatch(sw.hint, /again/);
    actions.keys(CTRL_X);
    assert.ok(loadGroups().groups.includes("Full"));
  });
});

describe("session commands on a group heading", () => {
  const flagged = SWITCHER_COMMANDS.filter((c) => "needsSession" in c);

  it("flags the commands that act on the highlighted session", () => {
    assert.deepEqual(
      flagged.map((c) => c.name).sort(),
      ["adopt", "comment", "delete", "detach", "group", "park", "rename", "stop", "ungroup"],
    );
  });

  it("answers each of them with a red 'select a session, not a heading'", async () => {
    const { sw, actions, goTo } = setup();
    goTo("Full");
    for (const c of flagged) {
      sw.hint = "";
      await actions.runCommand(`/${c.name}`, sw.current());
      assert.equal(sw.hint, `${c.name}: select a session, not a heading`);
      assert.ok(sw.render(80).some((l) => /\x1b\[[0-9;]*m[^\x1b]*select a session, not a heading/.test(l)));
    }
  });

  it("still answers with an error when the highlighted row is not a session", async () => {
    const { sw, actions } = setup();
    await actions.runCommand("/stop", undefined);
    assert.match(sw.hint, /^stop: (highlight a session first|select a session, not a heading)$/);
  });
});

describe("/init in the switcher", () => {
  const spawning = () => {
    const requests: Array<Record<string, unknown>> = [];
    const harness = setup(async (cmd) => {
      requests.push(cmd);
      return { sessionId: 5 };
    });
    return { ...harness, requests };
  };

  it("starts a new session in the given directory and queues the init prompt as its first message", async () => {
    const { actions, host, requests } = spawning();
    await actions.runCommand(`/init -C ${dir}`, undefined);
    assert.deepEqual(requests, [{ type: "spawn", cwd: dir, name: `init ${path.basename(dir)}`, agent: undefined }]);
    assert.equal((host as { pendingPrompt?: string | null }).pendingPrompt, INIT_PROMPT);
    assert.equal((host as { pendingEnterId?: number }).pendingEnterId, 5);
  });

  it("takes a name, and runs from the highlighted row's context without needing a session", async () => {
    const { sw, actions, goTo, requests } = spawning();
    goTo("Full");
    await actions.runCommand(`/init -n docs -C ${dir}`, sw.current());
    assert.equal(requests[0]?.name, "docs");
  });

  it("refuses a directory that does not exist, in red, without spawning", async () => {
    const { sw, actions, requests } = spawning();
    await actions.runCommand("/init -C /nonexistent/dir", undefined);
    assert.equal(requests.length, 0);
    assert.match(sw.hint, /init: \/nonexistent\/dir is not a directory/);
  });
});
