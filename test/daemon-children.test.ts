// The MCP variables the daemon hands a session's child (src/daemon-children.ts, ticket 308): the explore
// records must not reach a session with an agent profile, whose --tools allowlist would make that child
// report only the allowlisted tools and stamp the subset as the last tool sighting.
process.env.TORIEL_SOCK = process.env.TORIEL_SOCK ?? "/tmp/toriel-daemon-children-test.sock";
process.env.TORIEL_MCP = "/tmp/toriel-daemon-children-test/mcp.yaml";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
const { MCP_EXPLORE_RECORDS_FILE, MCP_SUMMARIES_FILE } = await import("../src/config.ts");
const { mcpChildEnvOf } = await import("../src/daemon-children.ts");
import type { AgentProfile } from "../src/agents.ts";

const profile = (over: Partial<AgentProfile> = {}): AgentProfile => ({
  name: "code-review",
  description: "reviews code",
  prompt: "review it",
  canSpawn: false,
  minimal: true,
  extensions: true,
  source: "built-in",
  file: "agents/code-review.md",
  ...over,
});

describe("mcpChildEnvOf", () => {
  it("gives an agentless session mcp.yaml, the summaries and the explore records", () => {
    assert.deepEqual(mcpChildEnvOf(undefined), {
      mcpFile: "/tmp/toriel-daemon-children-test/mcp.yaml",
      mcpSummaries: MCP_SUMMARIES_FILE,
      mcpRecords: MCP_EXPLORE_RECORDS_FILE,
      mcpDirect: [],
    });
  });

  it("gives a profile session mcp.yaml and the summaries but no explore records, and names its own servers direct", () => {
    assert.deepEqual(mcpChildEnvOf(profile({ tools: ["mcp__git__git_read*"] })), {
      mcpFile: "/tmp/toriel-daemon-children-test/mcp.yaml",
      mcpSummaries: MCP_SUMMARIES_FILE,
      mcpRecords: undefined,
      mcpDirect: ["git"],
    });
  });

  it("gives a profile without MCP support no mcp.yaml and no summaries, and still no records", () => {
    assert.deepEqual(mcpChildEnvOf(profile({ tools: ["bash*"], extensions: false })), {
      mcpFile: undefined,
      mcpSummaries: undefined,
      mcpRecords: undefined,
      mcpDirect: [],
    });
  });
});
