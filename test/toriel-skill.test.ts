import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { SESSION_COMMANDS, SWITCHER_COMMANDS } from "../src/commands.ts";
import { RESOURCES, TORIEL_TOOLS } from "../src/resources.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const text = fs.readFileSync(path.join(root, "pi", "skills", "toriel", "SKILL.md"), "utf8");

describe("the toriel skill (ticket 76)", () => {
  it("is a shipped resource with a name and a description rich in the phrases that should trigger it", () => {
    assert.ok(RESOURCES.some((r) => r.kind === "skill" && r.path === "skills/toriel"));
    assert.match(text, /^---\nname: toriel\ndescription: .+\n---\n/);
    const description = /^description: (.+)$/m.exec(text)?.[1] ?? "";
    for (const phrase of ["pi CLI", "pi mcp", "reload", "MCP server", "model", "fork", "compact", "schedule", "permissions"]) {
      assert.ok(description.includes(phrase), `the description should mention "${phrase}"`);
    }
  });

  it("documents every command a session has, so a new command cannot land undocumented", () => {
    for (const c of SESSION_COMMANDS) {
      assert.ok(text.includes(`\`/${c.name}`), `the skill does not mention /${c.name}`);
    }
  });

  it("documents the commands of the session list that are not session commands", () => {
    const own = new Set(SESSION_COMMANDS.map((c) => c.name));
    for (const c of SWITCHER_COMMANDS) {
      if (!own.has(c.name)) {
        assert.ok(text.includes(`\`/${c.name}`), `the skill does not mention the list command /${c.name}`);
      }
    }
  });

  it("names every tool toriel gives an agent, and no tool that does not exist", () => {
    const real = TORIEL_TOOLS.map((t) => t.replace(/^\+/, ""));
    for (const tool of real) {
      assert.ok(text.includes(tool), `the skill does not mention ${tool}`);
    }
    for (const mentioned of text.match(/toriel_[a-z_]+/g) ?? []) {
      assert.ok(real.includes(mentioned), `the skill names ${mentioned}, which is not a toriel tool`);
    }
  });

  it("tells the agent to ask the user rather than send them to the pi CLI", () => {
    assert.match(text, /Never tell them to use the pi CLI/);
  });
});
