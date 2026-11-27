import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { explorePromptServerNames, mcpExploreAllFirstLine } from "../pi/extensions/lib/mcp-config.ts";
import { mcpExploreAllPrompt, mcpExplorePrompt } from "../src/mcp-explore-prompt.ts";

describe("mcpExplorePrompt", () => {
  it("names the server and tells the agent how to introspect it, updating an existing skill rather than overwriting", () => {
    const p = mcpExplorePrompt("freecad");
    assert.match(p, /freecad/);
    assert.match(p, /introspect/i);
    assert.match(p, /tool/i);
    assert.match(p, /parameter/i);
    assert.match(p, /resource/i);
    assert.match(p, /mcp/i);
    assert.match(p, /MCP tool namespace/i);
    assert.match(p, /update it rather than overwriting/i);
  });

  it("points at the memory extension's skills folder first, a filesystem-safe dir name, the pi skill format, and the description frontmatter", () => {
    const p = mcpExplorePrompt("freecad");
    assert.match(p, /pi-hermes-memory\/skills/i);
    assert.match(p, /skills\/ folder/i);
    assert.match(p, /SKILL\.md/);
    assert.match(p, /filesystem-safe/i);
    assert.match(p, /frontmatter/i);
    assert.match(p, /name/);
    assert.match(p, /description/);
    assert.match(p, /surfaces the skill/i);
  });

  it("requires the skill to cover purpose, gotchas and an example, and to stay factual", () => {
    const p = mcpExplorePrompt("freecad");
    assert.match(p, /what the server is for/i);
    assert.match(p, /gotcha/i);
    assert.match(p, /example/i);
    assert.match(p, /not what you guess/i);
  });

  it("keeps the skill short, leaves the schemas to the loaded tools, and opens with the one tool_search call that loads the common tools (ticket 306)", () => {
    const p = mcpExplorePrompt("freecad");
    assert.match(p, /about 4 KB at most/);
    assert.match(p, /Do not copy every tool's parameters/);
    assert.match(p, /exact tool_search call that loads the tools most tasks need in one go/);
    assert.match(p, /without the prompt cache/);
  });
});

describe("mcpExploreAllPrompt", () => {
  const servers = ["freecad", "git"];
  const all = mcpExploreAllPrompt(servers);

  it("opens with exactly the line the extension stamps records from, and that line parses back to the server list", () => {
    assert.ok(all.startsWith(`${mcpExploreAllFirstLine(servers)}\n`), "first line is mcpExploreAllFirstLine verbatim");
    assert.deepEqual(explorePromptServerNames(all), servers);
  });

  it("asks for introspection of each listed server with its full parameter schemas", () => {
    assert.match(all, /each of the servers named above/i);
    assert.match(all, /list and describe its tools to get their full parameter schemas/i);
    assert.match(all, /resources if it has any/i);
  });

  it("keeps the single-server rules: same skills-directory placement, the cap, the tool_search line after the frontmatter", () => {
    assert.match(all, /single-server prompt/i);
    assert.match(all, /pi-hermes-memory\/skills/i);
    assert.match(all, /skills\/ folder/i);
    assert.match(all, /filesystem-safe/i);
    assert.match(all, /about 4 KB at most/);
    assert.match(all, /frontmatter/);
    assert.match(all, /right after the frontmatter/i);
    assert.match(all, /tool_search/i);
    assert.match(all, /update .* rather than overwrite/i);
  });

  it("wants the result verified by reading back with the read tool, factually, and the unreachable servers said", () => {
    assert.match(all, /reading it back with your read tool/i);
    assert.match(all, /not what you guess/i);
    assert.match(all, /configured or is not connected, say so and continue with the rest/i);
  });
});
