// How much each MCP server is used, and what that says about its exposure (ticket 304).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { exposureAdvice, MAX_FILE_BYTES, MIN_SESSIONS, scanMcpUsage, serverOfTool, sessionUsage, USAGE_WINDOW_DAYS } from "../src/mcp-usage.ts";

const assistant = (...tools: string[]): string => JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "x" }, ...tools.map((name) => ({ type: "toolCall", id: "c", name, arguments: {} }))] } });
// a system entry that loaded tools: loading is not calling, so it must not count
const loaded = (...tools: string[]): string => JSON.stringify({ type: "message", message: { role: "system", content: "", toolsAdded: tools.map((name) => ({ name })) } });
// The leading system message of a real plain session (recorded 2026-11-26, descriptions shortened): the sections render the prompt,
// and toolsAdded carries the tools declared into the first call - the built-ins plus the tools of the `direct` servers. The
// mcp_servers section lists only the servers whose tools are NOT declared, suffixed with how they are reached.
const leadingSystem = (): string =>
  JSON.stringify({
    type: "message",
    id: "38e1760a",
    parentId: "82f7ac18",
    timestamp: 1764007947648,
    message: {
      role: "system",
      content: "",
      sections: {
        preamble: "You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.",
        tools: "<tools>\n- read: Read file contents\n- bash: Execute bash commands (ls, grep, find, etc.)\n- edit: Make precise file edits with exact text replacement\n- write: Create or overwrite files\n- codemode: Run JavaScript that calls other tools\n</tools>",
        rules: "<rules>\n- Use bash for file operations like ls, rg, find\n</rules>",
        cwd: "/var/home/ron/projects/toriel",
        mcp_servers:
          "<mcp_servers>\nMCP servers whose tools are not declared to you. Call the tools of `codemode` servers from codemode scripts.\n- mcp__freecad (codemode)\n- mcp__github (codemode)\n- mcp__mealie (codemode)\n- mcp__vikunja (codemode): Rich-text fields (task and project descriptions, comments) are HTML by default.\n</mcp_servers>",
      },
      toolsAdded: [
        { name: "read", description: "Read the contents of a file" },
        { name: "bash", description: "Execute bash commands" },
        { name: "codemode", description: "Run JavaScript that calls other tools" },
        { name: "mcp__git__git_read", description: "Read the contents of a file" },
        { name: "mcp__git__git_write", description: "Write a file" },
        { name: "mcp__ghidra__list_instances", description: "List Ghidra instances" },
        { name: "list_mcp_resources", description: "List MCP resources" },
      ],
    },
  });

describe("which servers a session called", () => {
  it("names the server of an MCP tool, including one with underscores, and nothing for other tools", () => {
    assert.equal(serverOfTool("mcp__git__git_read"), "git");
    assert.equal(serverOfTool("mcp__claude_code__claude_start"), "claude_code");
    assert.equal(serverOfTool("read"), undefined);
    assert.equal(serverOfTool("mcp__broken"), undefined);
  });

  it("counts tool calls of assistant messages only, not tools that were merely loaded", () => {
    const text = [loaded("mcp__github__merge_pull_request"), assistant("read", "mcp__git__git_read"), "not json", assistant("mcp__git__git_write", "mcp__vikunja__tasks_list")].join("\n");
    const u = sessionUsage(text);
    assert.equal(u.called, true);
    assert.deepEqual([...u.servers].sort(), ["git", "vikunja"]);
    assert.deepEqual([...u.declared], ["github"], "the tools the system entry declared are seen, but not as calls");
    assert.equal(sessionUsage(loaded("mcp__git__git_read")).called, false, "a session that never called the model does not count");
    assert.deepEqual([...sessionUsage(assistant("read")).declared], []);
  });

  it("reads the declarations from the leading system message's toolsAdded, which a later load delta joins; section mentions declare nothing", () => {
    const text = [leadingSystem(), loaded("mcp__github__get_commit"), assistant("mcp__git__git_read")].join("\n");
    const u = sessionUsage(text);
    assert.equal(u.called, true);
    assert.deepEqual([...u.declared].sort(), ["ghidra", "git", "github"], "the direct servers the first call carried, plus the later tool_search load");
    assert.equal(u.declared.has("freecad"), false, "the mcp_servers section names only the not-declared servers; a mention there declares nothing");
    assert.equal(sessionUsage(leadingSystem()).declared.has("ghidra"), true, "the leading message alone declares, no later entry needed");
  });
});

describe("scanning the session files", () => {
  it("counts each recent session once per server, and skips old sessions, sessions with no model call, and agent-profile sessions", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-mcpusage-"));
    fs.mkdirSync(path.join(dir, "--project--"));
    const write = (name: string, lines: string[], ageDays = 0): void => {
      const file = path.join(dir, "--project--", name);
      fs.writeFileSync(file, lines.join("\n"));
      const t = new Date(Date.now() - ageDays * 86_400_000);
      fs.utimesSync(file, t, t);
    };
    write("5a2f1e9b-3c4d-4f5a-9b8c-7d6e5f4a3b2c.jsonl", [assistant("mcp__git__git_read"), assistant("mcp__git__git_read")]);
    write("2026-11-26T19-05-28_8b7a6d5c-4e3f-4a2b-9c1d-0e9f8a7b6c5d.jsonl", [assistant("mcp__git__git_read", "mcp__gdb__gdb_start")]);
    write("c.jsonl", [assistant("read")]);
    write("d.jsonl", [loaded("mcp__git__git_read")]);
    write("old.jsonl", [assistant("mcp__git__git_read")], USAGE_WINDOW_DAYS + 1);
    write("notes.txt", [assistant("mcp__git__git_read")]);
    assert.deepEqual(scanMcpUsage(dir), { sessions: 3, byServer: { git: 2, gdb: 1 }, declared: {} });
    assert.deepEqual(scanMcpUsage(path.join(dir, "missing")), { sessions: 0, byServer: {}, declared: {} });
    // a session launched through an agent profile does not count (ticket 304): the agents state is keyed by the UUID inside the file name
    assert.deepEqual(scanMcpUsage(dir, { agents: new Set(["8b7a6d5c-4e3f-4a2b-9c1d-0e9f8a7b6c5d"]) }), { sessions: 2, byServer: { git: 1 }, declared: {} });
    // a fork is skipped the same way: its file repeats its parent's calls, so they would count twice
    assert.deepEqual(scanMcpUsage(dir, { forks: new Set(["5a2f1e9b-3c4d-4f5a-9b8c-7d6e5f4a3b2c"]) }), { sessions: 2, byServer: { git: 1, gdb: 1 }, declared: {} });
  });

  it("reads at most MAX_FILE_BYTES of a file: the declarations at its top are seen, tool lines beyond it are not", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-mcpusage-"));
    fs.mkdirSync(path.join(dir, "--project--"));
    const file = path.join(dir, "--project--", "big.jsonl");
    fs.writeFileSync(file, [assistant("read"), loaded("mcp__git__git_read"), "x".repeat(MAX_FILE_BYTES), assistant("mcp__gdb__gdb_start")].join("\n"));
    assert.deepEqual(scanMcpUsage(dir), { sessions: 1, byServer: {}, declared: { git: 1 } });
  });
});

describe("what to recommend", () => {
  const usage = (byServer: Record<string, number>, sessions = 20, declared: Record<string, number> = {}) => ({ sessions, byServer, declared });

  it("declares at once a server most sessions call, and defers a declared one few call", () => {
    const entries = { git: {}, "claude-code": { exposure: "deferred" }, gdb: { exposure: "direct" }, vikunja: { exposure: "direct" }, rare: {} };
    const advice = exposureAdvice(entries, usage({ git: 5, claude_code: 6, gdb: 0, vikunja: 15, rare: 1 }, 20, { gdb: 20 }));
    assert.deepEqual(
      advice.map((a) => [a.server, a.exposure, a.used]),
      [
        ["git", "direct", 5],
        ["claude-code", "direct", 6],
        ["gdb", "deferred", 0],
      ],
    );
    assert.deepEqual(advice[2]?.sessions, 20);
  });

  it("judges the deferred advice by the sessions that declared the server, so a fresh, usually-down or out-of-toriel server is not measured by sessions that never saw it", () => {
    // the server has existed for two days of the 30-day window: 12 sessions declared it, none called it
    assert.deepEqual(exposureAdvice({ fresh: { exposure: "direct" } }, usage({ fresh: 0 }, 200, { fresh: 12 })), [{ server: "fresh", exposure: "deferred", used: 0, sessions: 12 }]);
    // no session declares it (never connected): nothing to judge
    assert.deepEqual(exposureAdvice({ fresh: { exposure: "direct" } }, usage({ fresh: 0 }, 200, {})), []);
    // and fewer than the minimum sessions that declared it say too little
    assert.deepEqual(exposureAdvice({ fresh: { exposure: "direct" } }, usage({ fresh: 0 }, 200, { fresh: MIN_SESSIONS - 1 })), []);
  });

  it("says nothing with too few sessions to judge, and leaves disabled, hidden, codemode and per-tool entries alone", () => {
    assert.deepEqual(exposureAdvice({ git: {} }, usage({ git: MIN_SESSIONS - 1 }, MIN_SESSIONS - 1)), []);
    assert.deepEqual(exposureAdvice({ a: { enabled: false }, b: { exposure: "hidden" }, c: { toolExposure: { x: "direct" } }, d: { exposure: "codemode" } }, usage({ a: 20, b: 20, c: 20, d: 20 })), []);
  });
});
