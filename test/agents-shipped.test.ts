// Limits every shipped agent profile (agents/*.md) must keep, so a profile cannot grow into the
// prompt and tool bloat small models choke on, or ship with a loadout the permission system
// does not guard. Behaviour on a real model is still judged by hand.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { type AgentProfile, parseAgent } from "../src/agents.ts";

const DIR = path.join(import.meta.dirname, "..", "agents");
const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".md") && f !== "README.md").sort();
const profiles: Array<{ file: string; agent: AgentProfile }> = files.map((file) => ({
  file,
  agent: parseAgent(fs.readFileSync(path.join(DIR, file), "utf8"), "built-in", path.join(DIR, file)),
}));

const BUILT_IN_TOOLS = new Set(["read", "grep", "find", "ls", "bash", "edit", "write", "web_search", "fetch_content"]);
/** The first-wave profiles were written to the tighter 1500-character bar; later ones (tool-heavy, for a 27b model) may use 2500. */
const COMPACT = new Set(["explore", "summarize", "code-review", "plan", "test-runner", "git-archaeology"]);
/** Tools that change files or run commands: only the permission system (an extension) stands between them and the disk. */
const GATED = new Set(["bash", "edit", "write"]);

describe("shipped agent profiles", () => {
  it("has the profiles the delegation skill relies on", () => {
    for (const name of ["explore", "summarize", "code-review", "plan", "test-runner", "git-archaeology", "research-web", "edit-writing", "docs-writer", "implement", "triage", "advisory-diff", "binary-diff", "debug", "crash-analysis", "re-explain", "re-find", "re-trace", "vuln-hunt", "design"]) {
      assert.ok(profiles.some((p) => p.agent.name === name), `agents/${name}.md is missing`);
    }
  });

  for (const { file, agent } of profiles) {
    describe(file, () => {
      it("is named after its file and has a one-line description that says what it is for", () => {
        assert.equal(agent.name, file.replace(/\.md$/, ""));
        assert.ok(agent.description.length <= 160, `description is ${agent.description.length} characters (limit 160): it is shown in every parent's tool description`);
        assert.doesNotMatch(agent.description, /\n/);
      });

      it("keeps the system prompt short", () => {
        const limit = COMPACT.has(agent.name) ? 1500 : 2500;
        assert.ok(agent.prompt.length <= limit, `prompt is ${agent.prompt.length} characters (limit ${limit})`);
        assert.ok(agent.prompt.trim().length > 0);
      });

      it("lists its tools, using only known names, and may not spawn", () => {
        assert.ok(agent.tools && agent.tools.length > 0, "an explicit tools list keeps the loadout small");
        for (const t of agent.tools ?? []) {
          assert.ok(BUILT_IN_TOOLS.has(t) || t.startsWith("toriel_") || t.startsWith("mcp__"), `unknown tool ${t}`);
        }
        assert.equal(agent.canSpawn, false);
        // A profile may pin a model (implement defaults to the free/local qwen
        // lane); the model must be a provider/id string when present.
        if (agent.model !== undefined) {
          assert.equal(typeof agent.model, "string");
          assert.match(agent.model as string, /^[^/]+\/[^/]+\//, "model must be provider/lane/id");
        }
      });

      it("keeps extensions on when it names MCP tools: pi's MCP support is an extension", () => {
        if ((agent.tools ?? []).some((t) => t.startsWith("mcp__"))) {
          assert.equal(agent.extensions, true);
        }
      });

      it("keeps extensions on when it names web tools: pi-web-access is a pi package", () => {
        if ((agent.tools ?? []).some((t) => t === "web_search" || t === "fetch_content")) {
          assert.equal(agent.extensions, true);
        }
      });

      it("never reaches git's write or network tools", () => {
        for (const t of agent.tools ?? []) {
          assert.doesNotMatch(t, /git_write|git_net/);
        }
      });

      it("keeps the permission system whenever it can run commands or edit files", () => {
        const gated = (agent.tools ?? []).filter((t) => GATED.has(t));
        if (gated.length > 0) {
          assert.equal(agent.extensions, true, `${gated.join(", ")} would run unguarded with extensions: false`);
        }
        if ((agent.tools ?? []).includes("bash")) {
          assert.ok((agent.tools ?? []).includes("toriel_job"), "a profile with bash should name toriel_job");
        }
      });
    });
  }
});
