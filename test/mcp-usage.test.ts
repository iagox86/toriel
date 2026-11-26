// How much each MCP server is used, and what that says about its exposure (ticket 304).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { exposureAdvice, MIN_SESSIONS, scanMcpUsage, serverOfTool, sessionUsage, USAGE_WINDOW_DAYS } from "../src/mcp-usage.ts";

const assistant = (...tools: string[]): string => JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "x" }, ...tools.map((name) => ({ type: "toolCall", id: "c", name, arguments: {} }))] } });
// a system entry that loaded tools: loading is not calling, so it must not count
const loaded = (...tools: string[]): string => JSON.stringify({ type: "message", message: { role: "system", content: "", toolsAdded: tools.map((name) => ({ name })) } });

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
    assert.equal(sessionUsage(loaded("mcp__git__git_read")).called, false, "a session that never called the model does not count");
  });
});

describe("scanning the session files", () => {
  it("counts each recent session once per server, and skips old sessions and sessions with no model call", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-mcpusage-"));
    fs.mkdirSync(path.join(dir, "--project--"));
    const write = (name: string, lines: string[], ageDays = 0): void => {
      const file = path.join(dir, "--project--", name);
      fs.writeFileSync(file, lines.join("\n"));
      const t = new Date(Date.now() - ageDays * 86_400_000);
      fs.utimesSync(file, t, t);
    };
    write("a.jsonl", [assistant("mcp__git__git_read"), assistant("mcp__git__git_read")]);
    write("b.jsonl", [assistant("mcp__git__git_read", "mcp__gdb__gdb_start")]);
    write("c.jsonl", [assistant("read")]);
    write("d.jsonl", [loaded("mcp__git__git_read")]);
    write("old.jsonl", [assistant("mcp__git__git_read")], USAGE_WINDOW_DAYS + 1);
    write("notes.txt", [assistant("mcp__git__git_read")]);
    assert.deepEqual(scanMcpUsage(dir), { sessions: 3, byServer: { git: 2, gdb: 1 } });
    assert.deepEqual(scanMcpUsage(path.join(dir, "missing")), { sessions: 0, byServer: {} });
  });
});

describe("what to recommend", () => {
  const usage = (byServer: Record<string, number>, sessions = 20) => ({ sessions, byServer });

  it("declares at once a server most sessions call, and defers a declared one few call", () => {
    const entries = { git: {}, "claude-code": { exposure: "deferred" }, gdb: { exposure: "direct" }, vikunja: { exposure: "direct" }, rare: {} };
    const advice = exposureAdvice(entries, usage({ git: 5, claude_code: 6, gdb: 0, vikunja: 15, rare: 1 }));
    assert.deepEqual(
      advice.map((a) => [a.server, a.exposure, a.used]),
      [
        ["git", "direct", 5],
        ["claude-code", "direct", 6],
        ["gdb", "deferred", 0],
      ],
    );
  });

  it("says nothing with too few sessions to judge, and leaves disabled, hidden and per-tool entries alone", () => {
    assert.deepEqual(exposureAdvice({ git: {} }, usage({ git: MIN_SESSIONS - 1 }, MIN_SESSIONS - 1)), []);
    assert.deepEqual(exposureAdvice({ a: { enabled: false }, b: { exposure: "hidden" }, c: { toolExposure: { x: "direct" } } }, usage({ a: 20, b: 20, c: 20 })), []);
  });
});
