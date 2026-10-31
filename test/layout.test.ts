import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import { buildLayouts, hiddenWhile } from "../src/layout.ts";

const text = (line: string): Component => ({ render: () => [line], invalidate: () => {} });

describe("panels behind a dialog", () => {
  it("hides a panel while the condition holds and brings it back unchanged", () => {
    let hidden = true;
    const panel = hiddenWhile(() => hidden, text("btw answer"));
    assert.deepEqual(panel.render(40), []);
    hidden = false;
    assert.deepEqual(panel.render(40), ["btw answer"]);
  });

  it("draws the dialog, but not the info or choice panels, in the chat view while a dialog is open", () => {
    let dialogOpen = true;
    const parts = {
      editor: text("editor"),
      statusLine: text("status"),
      scroll: text("scroll"),
      activityLine: text(""),
      rewindPicker: text(""),
      dialogPanel: text("PERMISSION DIALOG"),
      infoPanel: text("BTW ANSWER"),
      choicePanel: text("MODEL PICKER"),
      banner: text(""),
      switcher: text("switcher"),
      dialogOpen: () => dialogOpen,
    };
    const { chat } = buildLayouts(parts);
    const screen = () => chat.render(60).join("\n");
    assert.match(screen(), /PERMISSION DIALOG/);
    assert.doesNotMatch(screen(), /BTW ANSWER|MODEL PICKER/);
    dialogOpen = false;
    assert.match(screen(), /BTW ANSWER/);
    assert.match(screen(), /MODEL PICKER/);
  });
});
