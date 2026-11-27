import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { skillNameFromPath } from "../src/skill-notice.ts";

describe("skillNameFromPath", () => {
  it("names the skill for a read of its SKILL.md", () => {
    assert.equal(skillNameFromPath("pi/skills/messaging/SKILL.md"), "messaging");
    assert.equal(skillNameFromPath("/home/x/.pi/agent/skills/gdb-mcp/SKILL.md"), "gdb-mcp");
    assert.equal(skillNameFromPath("/home/x/.pi/agent/pi-hermes-memory/skills/vikunja-mcp/SKILL.md"), "vikunja-mcp");
  });

  it("does not name the skill for any other file of the skill", () => {
    assert.equal(skillNameFromPath("pi/skills/messaging/README.md"), undefined);
  });

  it("does not name a skill for a SKILL.md with no skills directory in it", () => {
    assert.equal(skillNameFromPath("/x/y/SKILL.md"), undefined);
    assert.equal(skillNameFromPath("SKILL.md"), undefined);
  });

  it("does not name a skill for a path that stops at the skill directory", () => {
    assert.equal(skillNameFromPath("skills/foo"), undefined);
  });

  it("does not name a skill for a SKILL.md with a directory between the skill and the file", () => {
    assert.equal(skillNameFromPath("skills/foo/bar.md"), undefined);
    assert.equal(skillNameFromPath("skills/foo/bar/SKILL.md"), undefined);
  });

  it("names the skill for a three-component path", () => {
    assert.equal(skillNameFromPath("skills/foo/SKILL.md"), "foo");
  });

  it("takes the last skills directory of a path with several", () => {
    assert.equal(skillNameFromPath("skills/a/skills/b/SKILL.md"), "b");
  });

  it("ignores values that are not paths", () => {
    assert.equal(skillNameFromPath(42), undefined);
    assert.equal(skillNameFromPath({ path: "pi/skills/messaging/SKILL.md" }), undefined);
    assert.equal(skillNameFromPath(undefined), undefined);
  });
});
