import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { continuePrompt } from "../src/continue-prompt.ts";
import type { Host } from "../src/host.ts";
import { SessionCommands } from "../src/session-commands.ts";

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("continuePrompt", () => {
  it("is the standard sentence alone, or with the extra instruction after it", () => {
    assert.equal(continuePrompt(""), "That interruption was accidental, please continue where you left off.");
    assert.equal(continuePrompt("  "), continuePrompt(""));
    assert.equal(continuePrompt("and focus on the tests"), "That interruption was accidental, please continue where you left off. and focus on the tests");
  });
});

describe("/continue", () => {
  it("sends the prompt through the ordinary prompt path and clears the editor", async () => {
    const sent: string[] = [];
    let text = "/continue and focus on the tests";
    const host = {
      editor: { setText: (t: string) => void (text = t) },
      tui: { requestRender: () => {} },
      notify: () => {},
      session: { prompt: async (p: string) => void sent.push(p) },
    };
    assert.equal(new SessionCommands(host as unknown as Host).run("/continue and focus on the tests"), true);
    await settle();
    assert.deepEqual(sent, [continuePrompt("and focus on the tests")]);
    assert.equal(text, "");
  });
});
