// The goal store (ticket 258): set/done/clear/get round-trip, persistence, and the /goal line parsing both scopes share.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { type CommandSpec, type CompletionSources, parseCommandLine } from "../src/cli.ts";
import { SESSION_COMMANDS, SWITCHER_COMMANDS } from "../src/commands.ts";
import { goalAction, GoalStore, goalNote } from "../src/goals.ts";

const fileOf = (): { dir: string; file: string } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goals-"));
  return { dir, file: path.join(dir, "goals.json") };
};

const stores: string[] = [];
afterEach(() => {
  for (const dir of stores.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("GoalStore", () => {
  it("sets, gets, marks done and clears, and the record persists", () => {
    const { dir, file } = fileOf();
    stores.push(dir);
    const a = new GoalStore(file, () => 1234);
    a.load();
    assert.equal(a.get("s1"), undefined);
    assert.deepEqual(a.set("s1", "fix the flaky build"), { text: "fix the flaky build", setAt: 1234 });
    assert.deepEqual(a.done("s1", "user"), { text: "fix the flaky build", setAt: 1234, done: true, doneAt: 1234, doneBy: "user" });
    assert.equal(a.done("s-never", "user"), undefined);

    const b = new GoalStore(file);
    b.load();
    assert.deepEqual(b.get("s1"), { text: "fix the flaky build", setAt: 1234, done: true, doneAt: 1234, doneBy: "user" });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).goals.s1, { text: "fix the flaky build", setAt: 1234, done: true, doneAt: 1234, doneBy: "user" });

    assert.deepEqual(b.clear("s1"), { text: "fix the flaky build", setAt: 1234, done: true, doneAt: 1234, doneBy: "user" });
    assert.equal(b.get("s1"), undefined);

    const c = new GoalStore(file);
    c.load();
    assert.equal(c.get("s1"), undefined);
  });

  it("replaces a goal on set (the new goal is not done), and copy keeps the record whole", () => {
    const { dir, file } = fileOf();
    stores.push(dir);
    const a = new GoalStore(file, () => 7);
    a.load();
    a.set("s1", "old job");
    a.done("s1", "agent");
    a.set("s1", "new job");
    assert.deepEqual(a.get("s1"), { text: "new job", setAt: 7 });
    assert.equal(a.copy("s1", "s2"), true);
    assert.deepEqual(a.get("s2"), { text: "new job", setAt: 7 });
    assert.equal(a.copy("s-missing", "s3"), false);
    assert.equal(a.get("s3"), undefined);
  });

  it("starts empty from a missing or damaged file", () => {
    const { dir } = fileOf();
    stores.push(dir);
    fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
    const nested = path.join(dir, "sub", "goals.json");
    fs.writeFileSync(nested, "not json");
    const s = new GoalStore(nested);
    s.load();
    assert.equal(s.get("s1"), undefined);
    s.set("s1", "text"); // also creates the missing directory
    assert.deepEqual(JSON.parse(fs.readFileSync(nested, "utf8")).goals.s1, { text: "text", setAt: s.get("s1")?.setAt });
  });
});

describe("the /goal line", () => {
  it("reads a first word that is not an action as the goal text", () => {
    assert.deepEqual(goalAction(""), { action: "get", text: "" });
    assert.deepEqual(goalAction("  "), { action: "get", text: "" });
    assert.deepEqual(goalAction("fix the flaky build"), { action: "set", text: "fix the flaky build" });
    assert.deepEqual(goalAction("set done"), { action: "set", text: "done" });
    assert.deepEqual(goalAction("set"), { error: "no text given - /goal <text> sets one (/goal shows the current goal)" });
  });

  it("takes done, clear and get as the action only as the one whole word", () => {
    assert.deepEqual(goalAction("get"), { action: "get", text: "" });
    assert.deepEqual(goalAction("done"), { action: "done", text: "" });
    assert.deepEqual(goalAction("clear"), { action: "clear", text: "" });
    // trailing words make it a goal text, not the action (so "done with refactor" never marks anything done)
    assert.deepEqual(goalAction("done with refactor"), { action: "set", text: "done with refactor" });
    assert.deepEqual(goalAction("clear the cache before deploy"), { action: "set", text: "clear the cache before deploy" });
    assert.deepEqual(goalAction("got to get the build green"), { action: "set", text: "got to get the build green" });
  });

  it("says what happened, in the words of the daemon's answer", () => {
    const rec = { text: "fix the flaky build", setAt: 1 } as const;
    const done = { ...rec, done: true, doneAt: 2, doneBy: "user" as const };
    assert.equal(goalNote("get", rec), "goal: fix the flaky build");
    assert.equal(goalNote("get", { ...rec, done: true, doneAt: 2, doneBy: "agent" }), "goal: fix the flaky build (done, by the agent)");
    assert.equal(goalNote("set", rec), "goal set: fix the flaky build");
    assert.equal(goalNote("done", done), "goal marked done: fix the flaky build");
    assert.equal(goalNote("done", null), "no goal to mark done");
    assert.equal(goalNote("get", null), "no goal - /goal <text> to set one");
    // clear's reply is the removed record, so the wording comes from the answer alone (no meta guess)
    assert.equal(goalNote("clear", done), "goal cleared");
    assert.equal(goalNote("clear", null), "no goal to clear");
  });

  it("is a command of both scopes, with its action words completed", async () => {
    assert.equal(parseCommandLine(SESSION_COMMANDS, "/goal done").kind, "run");
    assert.equal(parseCommandLine(SWITCHER_COMMANDS, "/goal fix the build").kind, "run");
    const spec = SWITCHER_COMMANDS.find((c) => c.name === "goal") as CommandSpec;
    assert.ok(spec, "the switcher lists /goal");
    const src = {} as unknown as CompletionSources; // the goal completer looks nothing up
    assert.deepEqual(await spec.complete?.("do", src), ["done"]);
    assert.deepEqual(await spec.complete?.("fix the build", src), []);
  });
});
