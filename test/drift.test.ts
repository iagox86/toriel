import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { drifted, messagesAdded } from "../src/drift.ts";
import { messagesFromFile } from "../src/transcript.ts";

describe("messagesAdded", () => {
  it("counts finished user, assistant, tool-result and custom messages once", () => {
    for (const role of ["user", "assistant", "toolResult", "custom", "system"]) {
      assert.equal(messagesAdded({ type: "message_end", message: { role } }), 1, role);
    }
    assert.equal(messagesAdded({ type: "message_start", message: { role: "user" } }), 0);
  });

  it("counts a completed compaction once (its marker row), not an aborted or failed one", () => {
    assert.equal(messagesAdded({ type: "compaction_end", reason: "manual", result: { summary: "s", tokensBefore: 5 }, aborted: false }), 1);
    // messagesFromFile makes a marker only for a string summary, so that is what counts
    assert.equal(messagesAdded({ type: "compaction_end", result: { tokensBefore: 5 } }), 0);
    assert.equal(messagesAdded({ type: "compaction_end", result: { summary: 7 } }), 0);
    assert.equal(messagesAdded({ type: "compaction_end", result: { summary: "s" }, aborted: true }), 0);
    assert.equal(messagesAdded({ type: "compaction_end", aborted: false, errorMessage: "failed" }), 0);
    assert.equal(messagesAdded({ type: "compaction_start" }), 0);
  });

  it("counts a boundary-appended custom message, which has no message events", () => {
    assert.equal(messagesAdded({ type: "entry_appended", entry: { type: "custom_message" } }), 1);
    assert.equal(messagesAdded({ type: "entry_appended", entry: { type: "label" } }), 0);
  });
});

describe("messagesAdded against a history replay (ticket 181)", () => {
  it("a view that counts a session's events as they happen ends on the length the replay of its file has", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-drift-"));
    const file = path.join(dir, "s.jsonl");
    // what pi writes and emits, in order: system prompt messages, a turn, a compaction, more messages
    const steps: Array<{ entry: Record<string, unknown>; events: Array<Record<string, unknown>> }> = [];
    let n = 0;
    const msg = (role: string) => {
      const message = { role, content: "x", timestamp: 1 };
      steps.push({ entry: { type: "message", id: `e${++n}`, message }, events: [{ type: "message_end", message }] });
    };
    msg("system");
    msg("user");
    msg("assistant");
    msg("toolResult");
    msg("assistant");
    steps.push({
      entry: { type: "compaction", id: `e${++n}`, summary: "s", firstKeptEntryId: "e4", tokensBefore: 9, timestamp: new Date().toISOString() },
      events: [{ type: "compaction_start" }, { type: "compaction_end", reason: "manual", result: { summary: "s", tokensBefore: 9 }, aborted: false }],
    });
    msg("system");
    msg("user");
    msg("assistant");
    // an aborted compaction leaves no entry and no row
    steps.push({ entry: { type: "label", id: `e${++n}` }, events: [{ type: "compaction_end", reason: "manual", aborted: true }] });

    fs.writeFileSync(file, `${[{ type: "session", version: 3, id: "s", timestamp: new Date().toISOString(), cwd: dir }, ...steps.map((s) => s.entry)].map((e) => JSON.stringify(e)).join("\n")}\n`);
    const counted = steps.flatMap((s) => s.events).reduce((sum, ev) => sum + messagesAdded(ev), 0);
    assert.equal(counted, messagesFromFile(file).length);
  });
});

describe("drifted", () => {
  it("is false when the counts agree, and while a run is streaming", () => {
    assert.equal(drifted(5, { messages: 5, streaming: false }), false);
    assert.equal(drifted(3, { messages: 5, streaming: true }), false);
  });

  it("is true when a settled session holds a different number of messages", () => {
    assert.equal(drifted(4, { messages: 5, streaming: false }), true);
    assert.equal(drifted(6, { messages: 5, streaming: false }), true);
  });

  it("does not judge a view that never had a history", () => {
    assert.equal(drifted(undefined, { messages: 5, streaming: false }), false);
  });
});
