// Bare /mcp explore (ticket 330): what re-exploring chooses from the explore records, that a fully fresh set
// sends no prompt at all, and that the combined prompt names the stale, connected servers.
// TORIEL_MCP_EXPLORE_RECORDS_FILE is read once at module load (src/config.ts), so this file pins it to a temp
// path before importing src, and rewrites that file per test.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Host } from "../src/host.ts";
import { mcpExploreAllPrompt } from "../src/mcp-explore-prompt.ts";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-mcpexplore-"));
process.env.TORIEL_MCP_EXPLORE_RECORDS_FILE = path.join(stateDir, "mcp-explore-records.json");

const { SessionCommands } = await import("../src/session-commands.ts");

const KEY = "/tmp/fake/session.jsonl";
const YAML = "servers:\n  git:\n    command: node\n    args: [x]\n  gdb:\n    command: node\n    args: [y]\n";
const CONNECTED = "git: connected, 12 tools (direct)\ngdb: connected, 4 tools (deferred)\n";

let dir: string;
let mcpFile: string;
let agentDir: string;
let saved: Record<string, string | undefined>;
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-mcpexplore-run-"));
  mcpFile = path.join(dir, "mcp.yaml");
  agentDir = path.join(dir, "agent");
  fs.writeFileSync(mcpFile, YAML);
  saved = { TORIEL_MCP: process.env.TORIEL_MCP, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  process.env.TORIEL_MCP = mcpFile;
  process.env.PI_CODING_AGENT_DIR = agentDir;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A skill pair so `hasSkill` is true for both servers (bare explore would otherwise re-explore them). */
const makeSkills = (...servers: string[]): void => {
  for (const name of servers) {
    const d = path.join(agentDir, "skills", name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "SKILL.md"), `# ${name}`);
  }
};

/** Explore records: the skill write time with the tool hash then, and the last-seen tool hash. */
const writeRecords = (records: { explored: Record<string, { at: string; hash: string }>; latest: Record<string, string> }): void => {
  fs.writeFileSync(process.env.TORIEL_MCP_EXPLORE_RECORDS_FILE as string, `${JSON.stringify(records, null, 2)}\n`);
};

const freshRecords = (): Parameters<typeof writeRecords>[0] => {
  const at = new Date().toISOString();
  return { explored: { git: { at, hash: "h-git" }, gdb: { at, hash: "h-gdb" } }, latest: { git: "h-git", gdb: "h-gdb" } };
};

function fakeHost(status: string) {
  const notices: string[] = [];
  const prompts: string[] = [];
  const typed: string[] = [];
  const requests: Array<Record<string, unknown>> = [];
  const host = {
    viewing: KEY,
    editor: { setText: (t: string) => typed.push(t) },
    tui: { requestRender: () => {} },
    notify: (m: string) => void notices.push(m),
    metaForPath: () => ({ id: 7, active: true, attachedToYou: true }),
    request: async (cmd: Record<string, unknown>) => {
      requests.push(cmd);
      return { text: status };
    },
    session: {
      prompt: async (t: string) => {
        prompts.push(t);
        return true;
      },
    },
  };
  return { host: host as unknown as Host, notices, prompts, typed, requests };
}

describe("bare /mcp explore", () => {
  it("sends no prompt when every connected server's skill is fresh, and says so", async () => {
    makeSkills("git", "gdb");
    writeRecords(freshRecords());
    const f = fakeHost(CONNECTED);
    new SessionCommands(f.host).run("/mcp explore");
    await settle();
    assert.deepEqual(f.requests.map((r) => r.type), ["mcp_status"], "connectivity is asked once");
    assert.deepEqual(f.prompts, [], "nothing re-explored: no prompt");
    assert.deepEqual(f.typed, [""], "run() clears the editor, as for every command");
    assert.ok(f.notices.some((n) => n.startsWith("no MCP skill needs re-exploring")));
  });

  it("re-explores one changed server, with its reason first and the combined prompt naming it", async () => {
    makeSkills("git", "gdb");
    const records = freshRecords();
    records.latest.git = "h-git-new";
    writeRecords(records);
    const f = fakeHost(CONNECTED);
    new SessionCommands(f.host).run("/mcp explore");
    await settle();
    assert.deepEqual(f.prompts, [mcpExploreAllPrompt(["git"])], "only the stale server goes through");
    const notice = f.notices.find((n) => n.includes("re-exploring")) ?? "";
    assert.match(notice, /^git: the server's tools changed after the explore on \d{4}-\d{2}-\d{2}$/m);
    assert.match(notice, /re-exploring 1 server\(s\)\.\.\.$/m);
    assert.deepEqual(f.typed, ["", ""], "the editor was cleared for the prompt (plus run()'s own clear)");
  });

  it("re-explores a 30-day-old skill and a changed one together, newest knowledge last", async () => {
    makeSkills("git", "gdb");
    const records = freshRecords();
    records.explored.gdb = { at: new Date(Date.now() - 40 * 86_400_000).toISOString(), hash: "h-gdb" };
    records.latest.git = "h-git-new";
    writeRecords(records);
    const f = fakeHost(CONNECTED);
    new SessionCommands(f.host).run("/mcp explore");
    await settle();
    assert.deepEqual(f.prompts, [mcpExploreAllPrompt(["git", "gdb"])]);
    assert.match(f.notices.find((n) => n.includes("re-exploring")) ?? "", /^gdb: explored 40 days ago$/m);
  });

  it("skips a stale server that is not connected instead of asking the session about it", async () => {
    makeSkills("git", "gdb");
    const records = freshRecords();
    records.latest.git = "h-git-new";
    writeRecords(records);
    const f = fakeHost("git: needs sign-in\ngdb: connected, 4 tools (deferred)\n");
    new SessionCommands(f.host).run("/mcp explore");
    await settle();
    assert.deepEqual(f.prompts, [], "nothing was sent for the server that is down");
    assert.match(f.notices.find((n) => n.includes("no MCP skill needs re-exploring")) ?? "", /git: not connected - \/mcp reconnect git/);
  });
});
