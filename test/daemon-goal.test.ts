// The daemon's goal wiring (ticket 258): the goal command, its SessionMeta fields, the user-done transcript notice, the delete and fork effects.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { Host } from "../src/host.ts";
import { SessionCommands } from "../src/session-commands.ts";
import { Switcher, rowBadge } from "../src/switcher.ts";
import { SwitcherActions } from "../src/switcher-actions.ts";
import { until, type Harness, type Msg, startDaemon } from "./helpers.ts";

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const isSettled = (m: Msg) => m.type === "event" && m.event?.type === "agent_settled";
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const GOAL_FILE = (h: Harness) => path.join(h.dir, "data", "toriel", "goals.json");
const GOAL_DONE_NOTICE = "Goal marked done by user (agent: if your goal was already marked done, ignore remaining goal reminders)";

/** A session with a saved UUID (a prompt behind it), so the goal command has a key. */
async function liveSession(h: Harness) {
  const c = await h.connect();
  const { sessionId } = await c.request({ type: "spawn", cwd: h.dir });
  await c.request({ type: "prompt", session: sessionId, message: "hi" });
  await c.waitFor(isSettled);
  let uuid: string | undefined;
  for (let i = 0; i < 80 && !uuid; i++) {
    uuid = c.sessions().find((x) => x.id === sessionId)?.sessionId;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(uuid, "the session got a UUID");
  return { c, session: sessionId, uuid };
}

describe("daemon: goal (ticket 258)", () => {
  it("sets, answers get, marks done, and the goal reaches the session list and the store file", async () => {
    harness = await startDaemon();
    const { c, session, uuid } = await liveSession(harness);

    await assert.rejects(c.request({ type: "goal", action: "set", sessionId: uuid, text: "   " }), /set needs a text/);
    const rec = await c.request({ type: "goal", action: "set", sessionId: uuid, text: "fix the flaky build" });
    assert.equal(rec.text, "fix the flaky build");
    assert.equal(rec.done, undefined);
    await c.waitFor((m) => m.type === "sessions" && m.sessions.some((x: Msg) => x.id === session && x.goal === "fix the flaky build" && x.goalDone === undefined));
    assert.deepEqual(JSON.parse(fs.readFileSync(GOAL_FILE(harness), "utf8")).goals[uuid].text, "fix the flaky build");

    assert.deepEqual(await c.request({ type: "goal", action: "get", sessionId: uuid }), rec);

    // the agent marking done: its reply says so, no user-done notice is left in the transcript
    const done = await c.request({ type: "goal", action: "done", sessionId: uuid, by: "agent" });
    assert.equal(done.text, "fix the flaky build");
    assert.equal(done.done, true);
    assert.equal(done.doneBy, "agent");
    assert.equal(typeof done.doneAt, "number");
    await c.waitFor((m) => m.type === "sessions" && m.sessions.some((x: Msg) => x.id === session && x.goalDone === true));
    assert.equal(c.messages.some((m) => m.type === "notice" && m.text === GOAL_DONE_NOTICE), false, "an agent-done says nothing");
    // clear answers with the goal it removed (ticket 258), and with null once there is none left
    assert.deepEqual(await c.request({ type: "goal", action: "clear", sessionId: uuid }), { text: rec.text, setAt: rec.setAt, done: true, doneAt: done.doneAt, doneBy: "agent" });
    assert.deepEqual(await c.request({ type: "goal", action: "clear", sessionId: uuid }), null);
    await c.waitFor((m) => m.type === "sessions" && m.sessions.some((x: Msg) => x.id === session && x.goal === undefined && x.goalDone === undefined));
  });

  it("marks done by the user leaves the durable notice in the live session's transcript", async () => {
    harness = await startDaemon();
    const { c, session, uuid } = await liveSession(harness);
    await c.request({ type: "goal", action: "set", sessionId: uuid, text: "ship the release" });
    assert.equal((await c.request({ type: "goal", action: "done", sessionId: uuid, by: "user" })).done, true);
    await c.waitFor((m) => m.type === "notice" && m.session === session && m.text === GOAL_DONE_NOTICE && m.durable === true);
  });

  it("collapses the goal text to one control-free line capped at 200 characters", async () => {
    harness = await startDaemon();
    const { c, uuid } = await liveSession(harness);
    const rec = await c.request({ type: "goal", action: "set", sessionId: uuid, text: `line one\nline two \x1b[31mred\x1b[0m\x1b[?25l, then ${"x".repeat(250)}` });
    assert.equal(rec.text.length, 200);
    assert.ok(!rec.text.includes("\n"), "no newline survives");
    assert.ok(!rec.text.includes("\x1b"), "no escape character survives");
    assert.match(rec.text, /^line one line two red, then x+$/);
    assert.deepEqual(JSON.parse(fs.readFileSync(GOAL_FILE(harness), "utf8")).goals[uuid].text, rec.text, "the store keeps the sanitized text");
    // a goal of nothing but controls is refused, not stored silently
    await assert.rejects(c.request({ type: "goal", action: "set", sessionId: uuid, text: "\n\t \x07" }), /set needs a text/);
  });

  it("a daemon restart keeps the goals: a second daemon on the same state dir still surfaces them (ticket 258)", async () => {
    harness = await startDaemon();
    const { c, uuid } = await liveSession(harness);
    const dataHome = path.join(harness.dir, "data");
    const set = await c.request({ type: "goal", action: "set", sessionId: uuid, text: "outlive the restart" });
    await c.request({ type: "goal", action: "done", sessionId: uuid, by: "user" });
    // orderly shutdown, so the lock is released and things survive on disk
    await c.request({ type: "shutdown" }).catch(() => undefined);
    const sock = harness.sock;
    await until(() => !fs.existsSync(sock), 10_000);

    // a second daemon on the same state directory: the goals file is the one above (and its session dir shows the same file)
    const again = await startDaemon({ XDG_DATA_HOME: dataHome, FAKE_PI_DIR: harness.sessionsDir });
    const first = harness;
    harness = again;
    const c2 = await again.connect();
    const got = await c2.request({ type: "goal", action: "get", sessionId: uuid });
    assert.equal(got.text, "outlive the restart");
    assert.equal(got.done, true);
    assert.equal(got.doneBy, "user");
    assert.equal(got.setAt, set.setAt, "the store reloads");
    c2.send({ type: "list" });
    const list = await c2.waitFor((m) => m.type === "sessions" && m.goals && m.goals[uuid]);
    assert.deepEqual(list.goals[uuid], { text: "outlive the restart", done: true }, "the session list carries the goal for a session with no live meta");
    // the old state dir can only be removed once daemon 2 is done with it: its goals.load() runs after the socket binds, so an early rmSync once raced the read away
    fs.rmSync(first.dir, { recursive: true, force: true });
  });

  it("deleting the session removes its goal", async () => {
    harness = await startDaemon();
    const { c, session, uuid } = await liveSession(harness);
    await c.request({ type: "goal", action: "set", sessionId: uuid, text: "doomed either way" });
    await c.request({ type: "delete", session });
    await c.waitFor((m) => m.type === "sessions" && !m.sessions.some((x: Msg) => x.id === session));
    const goals = JSON.parse(fs.readFileSync(GOAL_FILE(harness), "utf8")).goals;
    assert.equal(goals[uuid], undefined);
  });

  it("a fork copies the goal it was made from, done state included", async () => {
    harness = await startDaemon();
    const { c, uuid } = await liveSession(harness);
    await c.request({ type: "goal", action: "set", sessionId: uuid, text: "keep at it" });
    await c.request({ type: "goal", action: "done", sessionId: uuid, by: "agent" });
    const file = c.sessions().find((s) => s.sessionId === uuid)?.sessionFile as string;
    const forked = await c.request({ type: "adopt", path: file, cwd: harness.dir, fork: true });
    const copy = await c.request({ type: "goal", action: "get", sessionId: forked.sessionUuid });
    assert.equal(copy.text, "keep at it");
    assert.equal(copy.done, true);
    assert.equal(copy.doneBy, "agent");
    await c.waitFor((m) => m.type === "sessions" && m.sessions.some((x: Msg) => x.sessionId === forked.sessionUuid && x.goal === "keep at it" && x.goalDone === true));
  });
});

describe("the goal on a switcher row (ticket 258)", () => {
  it("the badge is ` goal: <text>` (a leading space and an ASCII prefix), cut to fit, dimmed once done", () => {
    const now = new Date();
    assert.equal(rowBadge({}, now), "");
    // the leading space keeps the badge off the name, and the prefix is ASCII: ambiguous-width glyphs break the row's width math
    assert.equal(plain(rowBadge({ goal: "fix the build" }, now)), " goal: fix the build");
    const long = plain(rowBadge({ goal: "a longer goal than fourteen chars" }, now));
    assert.ok(long.startsWith(" goal: "), "the badge still starts with the prefix");
    assert.match(long, /\.\.\.$/);
    assert.doesNotMatch(long, /chars/);
    assert.equal(plain(rowBadge({ goal: "fix the build", goalDone: true }, now)), " goal: fix the build");
    assert.notEqual(rowBadge({ goal: "fix the build", goalDone: true }, now), plain(rowBadge({ goal: "fix the build", goalDone: true }, now)), "a done goal's badge carries its own dim styling, not the row's");
    assert.doesNotMatch(rowBadge({ goal: "fix the build" }, now), /^\x1b\[/);
  });

  it("the goal badge comes last, after the schedule clock and ' chat' (its colour never reaches what follows)", () => {
    const now = new Date();
    assert.equal(plain(rowBadge({ goal: "x", published: true }, now)), " chat goal: x");
    const badge = rowBadge({ goal: "x", goalDone: true, published: true }, now);
    assert.ok(badge.startsWith(" chat\x1b["), "' chat' is plain, then the goal badge with its own dim styling");
    assert.match(plain(badge), /^ chat goal: x$/);
  });
});

/** A session-command host that only answers the goal request, so `/goal`'s controller wording can be read without a daemon. */
function goalHost(reply: (cmd: Msg) => unknown, sessionId?: string) {
  const notices: string[] = [];
  const requests: Msg[] = [];
  const h = {
    viewing: "/s/a.jsonl",
    local: new Map(),
    editor: { setText: () => {} },
    notify: (m: string) => void notices.push(m),
    metaForPath: () => (sessionId ? { id: 7, active: true, attachedToYou: true, sessionId } : { id: 7, active: true, attachedToYou: true }),
    request: async (cmd: Msg) => {
      requests.push(cmd);
      return reply(cmd);
    },
  };
  return { commands: new SessionCommands(h as unknown as Host), notices, requests };
}

describe("the /goal session command (ticket 258)", () => {
  it("refuses with no session id yet, and says so without asking the daemon", async () => {
    const f = goalHost(() => ({}));
    f.commands.run("/goal ship it");
    await until(() => f.notices.length > 0);
    assert.deepEqual(f.notices, ["no goal yet - send a message first"]);
    assert.deepEqual(f.requests, []);
  });

  it("shows the line's parse error without asking the daemon", async () => {
    const f = goalHost(() => ({}), "u1");
    f.commands.run("/goal set");
    await until(() => f.notices.length > 0);
    assert.deepEqual(f.notices, ["no text given - /goal <text> sets one (/goal shows the current goal)"]);
    assert.deepEqual(f.requests, []);
  });

  it("words set, and clear by whether the daemon really removed one (its reply, not a meta guess)", async () => {
    const f = goalHost((cmd) => {
      if (cmd.action === "clear") {
        return null;
      }
      return { text: cmd.text, setAt: 1 };
    }, "u1");
    f.commands.run("/goal done with refactor");
    await until(() => f.notices.length > 0);
    // "done with refactor" is a goal text, not a mark-done (ticket 258)
    assert.deepEqual(f.requests[0], { type: "goal", action: "set", sessionId: "u1", text: "done with refactor" });
    assert.deepEqual(f.notices, ["goal set: done with refactor"]);

    f.commands.run("/goal clear");
    await until(() => f.notices.length > 1);
    assert.deepEqual(f.requests[1], { type: "goal", action: "clear", sessionId: "u1" });
    assert.equal(f.notices[1], "no goal to clear");

    const g = goalHost(() => ({ text: "to forget", setAt: 1 }), "u1");
    g.commands.run("/goal clear");
    await until(() => g.notices.length > 0);
    assert.equal(g.notices[0], "goal cleared");
  });

  it("maps a daemon failure and a timed-out one onto one line each", async () => {
    const f = goalHost(() => {
      throw new Error("unknown action: nope");
    }, "u1");
    f.commands.run("/goal ship it");
    await until(() => f.notices.length > 0);
    assert.deepEqual(f.notices, ["goal failed: unknown action: nope"]);

    const g = goalHost(() => {
      throw new Error("request timed out");
    }, "u1");
    g.commands.run("/goal get");
    await until(() => g.notices.length > 0);
    assert.deepEqual(g.notices, ["goal: no answer from the daemon (is it older than this toriel? restart it: toriel kill-server)"]);
  });
});

describe("the /goal switcher command (ticket 258)", () => {
  const setup = () => {
    const sw = new Switcher();
    const host = {
      tui: { requestRender() {}, terminal: { rows: 30 } },
      editor: { getText: () => "", setText() {} },
      switcher: sw,
      sessions: new Map(),
      local: new Map(),
      views: new Map(),
      summaries: new Map(),
      goalSummaries: {},
      viewing: null,
      send() {},
      notify() {},
      request: async () => ({}),
      uniqueSessionName: (n: string) => n,
      metaForPath: () => undefined,
    };
    const actions = new SwitcherActions(host as never);
    (host as { switching?: unknown }).switching = actions;
    actions.refresh();
    return { sw, actions };
  };

  it("with nothing selectable, says which one (an empty list's only row is a heading)", async () => {
    const { sw, actions } = setup();
    await actions.runCommand("/goal ship it", undefined);
    assert.equal(sw.hint, "goal: select a session, not a heading");
  });

  it("with a highlighted session that has no id yet, says so instead of asking", async () => {
    const { sw, actions } = setup();
    await actions.runCommand("/goal ship it", { key: "/s/a.jsonl", name: "a" } as never);
    assert.equal(sw.hint, "goal: session has no id yet");
  });
});
