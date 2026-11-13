import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Host } from "../src/host.ts";
import { SessionActions } from "../src/session-actions.ts";
import { checkSlash, editDistance, nearestCommand } from "../src/unknown-command.ts";

const OWN = ["compact", "model", "mcp", "help"];
const PI = ["skill:review", "deploy"];

describe("nearestCommand", () => {
  it("prefers a prefix match, then a close spelling, and says nothing when nothing is close", () => {
    assert.equal(nearestCommand("comp", OWN), "compact");
    assert.equal(nearestCommand("compct", OWN), "compact");
    assert.equal(nearestCommand("modle", OWN), "model");
    assert.equal(nearestCommand("zzzzzz", OWN), undefined);
  });

  it("allows one edit on short names, not two", () => {
    assert.equal(nearestCommand("modl", OWN), "model");
    assert.equal(nearestCommand("hx", ["help"]), undefined);
  });

  it("measures edits", () => {
    assert.equal(editDistance("kitten", "sitting"), 3);
    assert.equal(editDistance("", "abc"), 3);
  });
});

describe("checkSlash", () => {
  it("sends toriel's own and pi's commands, in any case, with arguments", () => {
    assert.deepEqual(checkSlash("/compact keep the tests", OWN, PI), { send: true });
    assert.deepEqual(checkSlash("/Model", OWN, PI), { send: true });
    assert.deepEqual(checkSlash("/skill:review src/a.ts", OWN, PI), { send: true });
    assert.deepEqual(checkSlash("/deploy", OWN, PI), { send: true });
  });

  it("treats paths and a bare slash as ordinary text", () => {
    for (const line of ["/", "/tmp/x.log please look", "/home/ron/file", "/ hello", "//comment", "/1"]) {
      assert.deepEqual(checkSlash(line, OWN, PI), { send: true }, line);
    }
  });

  it("refuses an unknown command and suggests the nearest one", () => {
    const v = checkSlash("/compct now", OWN, PI);
    assert.equal(v.send, false);
    assert.match((v as { message: string }).message, /unknown command: \/compct - did you mean \/compact\?/);
    assert.match((v as { message: string }).message, /\/help/);
  });

  it("refuses without a suggestion when nothing is close", () => {
    const v = checkSlash("/nonsense", OWN, PI);
    assert.equal(v.send, false);
    assert.doesNotMatch((v as { message: string }).message, /did you mean/);
  });

  it("refuses, and says why, when pi's list has not arrived", () => {
    for (const list of [undefined, []]) {
      const v = checkSlash("/deploy", OWN, list);
      assert.equal(v.send, false);
      assert.match((v as { message: string }).message, /not loaded yet/);
    }
    assert.deepEqual(checkSlash("/compact", OWN, undefined), { send: true }, "toriel's own commands need no list");
  });
});

describe("submit", () => {
  function fake(piCommands: Array<{ name: string }>) {
    const notices: string[] = [];
    const prompts: string[] = [];
    const host = {
      piCommands,
      editor: { setText: () => {}, getText: () => "" },
      tui: { requestRender: () => {} },
      notify: (m: string) => void notices.push(m),
      viewing: "/tmp/s.jsonl",
      metaForPath: () => undefined,
    };
    const actions = new SessionActions(host as unknown as Host);
    // the ordinary send path is not under test: record that it was reached
    (actions as unknown as { prompt: (t: string) => Promise<void> }).prompt = async (t) => void prompts.push(t);
    return { actions, notices, prompts };
  }

  it("does not send an unknown /command: a notice instead, nothing to the model", () => {
    const { actions, notices, prompts } = fake([{ name: "deploy" }]);
    actions.submit("/nonsense");
    assert.equal(prompts.length, 0);
    assert.match(notices[0] as string, /unknown command: \/nonsense/);
  });

  it("forwards a command pi knows, unchanged", () => {
    const { actions, notices, prompts } = fake([{ name: "deploy" }]);
    actions.submit("/deploy now");
    assert.deepEqual(prompts, ["/deploy now"]);
    assert.deepEqual(notices, []);
  });
});
