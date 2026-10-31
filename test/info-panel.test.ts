import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InfoPanel, wrapHanging } from "../src/info-panel.ts";

describe("info panel wrapping", () => {
  const long = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda";

  it("keeps the gutter on every line of a wrapped paragraph", () => {
    const lines = wrapHanging(long, 24);
    assert.ok(lines.length > 1);
    assert.ok(lines.every((l) => l.startsWith(" ") && !l.startsWith("  ")), lines.join("|"));
  });

  it("wraps indented text under its own indent", () => {
    const lines = wrapHanging(`    ${long}`, 30);
    assert.ok(lines.length > 1);
    assert.ok(lines.every((l) => l.startsWith("     ") && !l.startsWith("      ")), lines.join("|"));
  });

  it("hangs a bullet's continuation lines under its text", () => {
    const lines = wrapHanging(`  - ${long}`, 30);
    assert.ok(lines[0]?.startsWith("   - alpha"));
    assert.ok(lines.slice(1).every((l) => l.startsWith("     ") && !l.startsWith("      ")), lines.join("|"));
  });

  it("leaves short lines and blank lines alone", () => {
    assert.deepEqual(wrapHanging("short", 40), [" short"]);
    assert.deepEqual(wrapHanging("", 40), [" "]);
  });
});

describe("info panel actions", () => {
  it("runs the action for its key, closes, and ignores other keys", () => {
    const panel = new InfoPanel();
    const ran: string[] = [];
    panel.show("answer", [{ key: "c", label: "copies", run: () => ran.push("c") }]);
    assert.equal(panel.act("x"), false);
    assert.ok(panel.isOpen);
    assert.equal(panel.act("c"), true);
    assert.deepEqual(ran, ["c"]);
    assert.equal(panel.isOpen, false);
  });

  it("lists the keys in the footer", () => {
    const panel = new InfoPanel();
    panel.show("answer", [{ key: "s", label: "saves", run: () => {} }]);
    assert.match(panel.render(60).join("\n"), /s saves - esc or enter closes/);
  });
});
