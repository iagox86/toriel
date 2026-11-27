// The toriel-mcp extension (tickets 209 and 216): registers mcp.yaml's servers into pi at session start, `whenUp` ones only when they answer.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { learnSummaries, MCP_FILE_ENV, MCP_SUMMARIES_ENV, piConfig, summaryLine } from "../pi/extensions/lib/mcp-config.ts";
import setup, { addToolSearchGuideline, describeOutcomes, loadServers, loadSummaries, reconcile, recordSummaries, saveSummaries, TOOL_SEARCH_GUIDELINE, UP_COMMAND } from "../pi/extensions/toriel-mcp.ts";

async function listener(): Promise<{ port: number; close(): Promise<void> }> {
  const server = net.createServer((s) => s.destroy());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as net.AddressInfo).port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const yamlFile = (text: string): string => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "toriel-mcpext-")), "mcp.yaml");
  fs.writeFileSync(file, text);
  return file;
};

describe("loadServers", () => {
  it("reads the file, and is no servers when there is none or no path", () => {
    assert.deepEqual(Object.keys(loadServers(yamlFile("servers:\n  a: { command: x }\n")).servers), ["a"]);
    assert.deepEqual(loadServers(undefined), { servers: {}, problems: [] });
    assert.deepEqual(loadServers(path.join(os.tmpdir(), "toriel-no-such-mcp.yaml")), { servers: {}, problems: [] });
    assert.match(loadServers(yamlFile("servers: [\n")).problems[0] ?? "", /not valid YAML/);
  });
});

describe("reconcile", () => {
  const fakePi = (already: string[] = [], failing = false) => {
    const registered: Array<[string, Record<string, unknown>]> = [];
    return {
      registered,
      pi: {
        registerMcpServer(name: string, config: Record<string, unknown>) {
          if (failing) {
            throw new Error("refused");
          }
          registered.push([name, config]);
        },
        getMcpServers: () => already.map((name) => ({ name })),
      },
    };
  };
  const servers = {
    plain: { command: "node", args: ["x.js"], exposure: "direct" },
    bridge: { url: "http://127.0.0.1:39280/mcp", whenUp: true, exposure: "direct" },
    off: { command: "y", enabled: false },
  };

  it("registers a plain server at once, without toriel's own key, and a whenUp one only when it answers", async () => {
    const down = fakePi();
    assert.deepEqual(await reconcile(down.pi, servers, async () => false), { plain: "registered", bridge: "down", off: "registered" });
    assert.deepEqual(down.registered.map(([n]) => n), ["plain", "off"]);
    assert.deepEqual(down.registered[0]?.[1], { command: "node", args: ["x.js"], exposure: "direct" });
    assert.deepEqual(down.registered[1]?.[1], { command: "y", enabled: false, exposure: "deferred" }, "a disabled server is registered, so /mcp can switch it on for the session");
    const up = fakePi();
    await reconcile(up.pi, servers, async () => true);
    assert.deepEqual(up.registered.find(([n]) => n === "bridge")?.[1], { url: "http://127.0.0.1:39280/mcp", exposure: "direct" }, "whenUp is not handed to pi");
  });

  it("registers a server with no exposure as deferred, and the ones the session's profile names as direct (ticket 298)", async () => {
    const f = fakePi();
    await reconcile(f.pi, { plain: { command: "x" }, "my-srv": { command: "y", exposure: "codemode" }, set: { command: "z", exposure: "direct" } }, async () => true, undefined, new Set(["my_srv"]));
    assert.deepEqual(Object.fromEntries(f.registered.map(([n, c]) => [n, (c as { exposure?: string }).exposure])), { plain: "deferred", "my-srv": "direct", set: "direct" });
  });

  it("does not probe a disabled whenUp server, leaves registered ones alone, probes only the one named, and counts a refusal as failed", async () => {
    const probed: string[] = [];
    const f = fakePi(["plain"]);
    const recording = async (u: string): Promise<boolean> => {
      probed.push(u);
      return true;
    };
    const out = await reconcile(f.pi, { plain: servers.plain, bridge: { ...servers.bridge, enabled: false } }, recording);
    assert.deepEqual(out, { plain: "already", bridge: "registered" });
    assert.deepEqual(probed, []);
    const g = fakePi();
    assert.deepEqual(await reconcile(g.pi, servers, async () => true, "bridge"), { bridge: "registered" });
    assert.deepEqual(await reconcile(fakePi([], true).pi, { plain: servers.plain }), { plain: "failed" });
  });

  it("describes what happened in words, with the way out for a server that is down", () => {
    const text = describeOutcomes({ a: "registered", b: "down", c: "already", d: "failed" }, { a: { url: "http://a/mcp" }, b: { url: "http://127.0.0.1:1/mcp" }, c: {}, d: {} });
    assert.match(text, /a: up, connecting/);
    assert.match(text, new RegExp(`b: nothing is listening at http://127.0.0.1:1/mcp \\(start it, then /${UP_COMMAND}\\)`));
    assert.match(text, /c: already registered/);
    assert.match(text, /d: pi refused the entry/);
    assert.match(describeOutcomes({}, {}), /no server is marked whenUp/);
    const secret = describeOutcomes({ a: "registered", b: "down" }, { a: { url: "https://u:tok3n@h.example/mcp?key=k3y" }, b: { url: "https://u:tok3n@h.example/mcp?key=k3y" } });
    assert.doesNotMatch(secret, /tok3n|k3y/, "a bridge URL's credentials never reach the screen or the transcript");
    assert.match(secret, /https:\/\/\*\*\*@h\.example\/mcp\?\.\.\./);
  });
});

  function load(file: string | undefined, summaries?: string, tools: Array<{ name: string; namespace?: { aliases?: string[]; instructions?: string } }> = []) {
    const saved = { file: process.env[MCP_FILE_ENV], summaries: process.env[MCP_SUMMARIES_ENV] };
    const put = (key: string, value: string | undefined): void => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    };
    put(MCP_FILE_ENV, file);
    put(MCP_SUMMARIES_ENV, summaries);
    const handlers: Array<(e: unknown, ctx: never) => unknown> = [];
    const events: string[] = [];
    const commands = new Map<string, (args: string, ctx: { ui: { notify(m: string, t?: string): void } }) => Promise<void> | void>();
    const registered: string[] = [];
    const configs = new Map<string, Record<string, unknown>>();
    try {
      setup({
        on: (event, handler) => {
          events.push(event);
          handlers.push(handler);
        },
        registerCommand: (name, options) => commands.set(name, options.handler),
        registerMcpServer: (name, config) => {
          registered.push(name);
          configs.set(name, config);
        },
        getMcpServers: () => registered.map((name) => ({ name })),
        getAllTools: () => tools,
      });
    } finally {
      put(MCP_FILE_ENV, saved.file);
      put(MCP_SUMMARIES_ENV, saved.summaries);
    }
    return { handlers, events, commands, registered, configs };
  }

describe("the extension", () => {

  it("does nothing at all when there is no file path (a session without MCP support)", () => {
    const x = load(undefined);
    assert.equal(x.handlers.length, 0);
    assert.equal(x.commands.size, 0);
  });

  it("registers the servers at session start, skips a down whenUp one silently, and says which entries it could not use", async () => {
    const l = await listener();
    const file = yamlFile(`servers:\n  plain: { command: x }\n  up: { url: "http://127.0.0.1:${l.port}/mcp", whenUp: true }\n  down: { url: "http://127.0.0.1:1/mcp", whenUp: true }\n  broken: { exposure: direct }\n`);
    const x = load(file);
    const said: Array<[string, string | undefined]> = [];
    await x.handlers[0]?.({}, { ui: { notify: (m: string, t?: string) => void said.push([m, t]) } } as never);
    assert.deepEqual(x.registered.sort(), ["plain", "up"]);
    assert.equal(said.length, 1, "only the problem is said");
    assert.match(said[0]?.[0] ?? "", /"broken": give exactly one of url/);
    assert.equal(said[0]?.[1], "warning");
    await l.close();
  });

  it("/mcp-up looks again at the whenUp servers only, answers in words, and refuses a name that is not one", async () => {
    const l = await listener();
    const x = load(yamlFile(`servers:\n  plain: { command: x }\n  up: { url: "http://127.0.0.1:${l.port}/mcp", whenUp: true }\n  down: { url: "http://127.0.0.1:1/mcp", whenUp: true }\n`));
    const said: Array<[string, string | undefined]> = [];
    const ctx = { ui: { notify: (m: string, t?: string) => void said.push([m, t]) } };
    await x.commands.get(UP_COMMAND)?.("", ctx);
    assert.deepEqual(x.registered, ["up"], "plain is not this command's business");
    assert.match(said[0]?.[0] ?? "", /up: up, connecting[\s\S]*down: nothing is listening/);
    assert.equal(said[0]?.[1], "warning");
    await x.commands.get(UP_COMMAND)?.("plain", ctx);
    assert.match(said[1]?.[0] ?? "", /plain is not a whenUp server in mcp.yaml \(those are: up, down\)/);
    await x.commands.get(UP_COMMAND)?.("up", ctx);
    assert.match(said[2]?.[0] ?? "", /up: already registered/);
    assert.equal(said[2]?.[1], "info");
    await l.close();
  });
});

describe("remembered server summaries (ticket 303)", () => {
  const tmp = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "toriel-mcpsum-")), "state", "mcp-summaries.json");
  const tool = (name: string, server: string, instructions?: string) => ({ name, namespace: { aliases: [server], ...(instructions === undefined ? {} : { instructions }) } });

  it("shows the first line of the instructions, as pi does, capped", () => {
    assert.equal(summaryLine("  Git tools.  \nMore detail."), "Git tools.");
    assert.equal(summaryLine(undefined), "");
    assert.equal(summaryLine("x".repeat(400)).length, 250);
  });

  it("registers a deferred server with its remembered summary, but never over the entry's own description and never for a direct one", () => {
    assert.equal(piConfig({ command: "x" }, { summary: "Git tools." }).description, "Git tools.");
    assert.equal(piConfig({ command: "x", description: "Mine." }, { summary: "Git tools." }).description, "Mine.");
    assert.equal(piConfig({ command: "x" }, { summary: "Git tools.", direct: true }).description, undefined, "a direct server is not listed in the section");
    assert.equal(piConfig({ command: "x" }).description, undefined);
  });

  it("learns the summaries of connected servers that set no description, and reports no change when there is none", () => {
    const servers = { git: { command: "g" }, mine: { command: "m", description: "Mine." } };
    const tools = [tool("read", "git", "not an MCP tool"), tool("mcp__git__git_read", "git", "Git tools.\nUse repo:"), tool("mcp__mine__x", "mine", "Server text."), tool("mcp__gone__x", "gone", "Not in mcp.yaml."), tool("mcp__git__git_write", "git")];
    assert.deepEqual(learnSummaries({}, tools, servers), { git: "Git tools." });
    assert.equal(learnSummaries({ git: "Git tools." }, tools, servers), undefined, "unchanged: the file is not rewritten");
    assert.deepEqual(learnSummaries({ git: "Old.", other: "Kept." }, tools, servers), { git: "Git tools." }, "a name mcp.yaml no longer has is dropped");
  });

  it("removes the summary of a connected server whose instructions are now empty", () => {
    const servers = { git: { command: "g" } };
    const tools = [tool("mcp__git__git_read", "git", "")];
    assert.deepEqual(learnSummaries({ git: "Git tools.", other: "Gone." }, tools, { git: { command: "g" }, other: { command: "o" } }), { other: "Gone." });
    assert.deepEqual(learnSummaries({ git: "Git tools." }, tools, servers), {}, "emptied: the file is rewritten without the gone summary");
  });

  it("reads a missing or malformed file as no summaries, and writes it atomically", () => {
    const file = tmp();
    assert.deepEqual(loadSummaries(file), {});
    assert.deepEqual(loadSummaries(undefined), {});
    saveSummaries(file, { git: "Git tools." });
    assert.deepEqual(loadSummaries(file), { git: "Git tools." });
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["mcp-summaries.json"], "no temp file is left behind");
    fs.writeFileSync(file, "[1,2]");
    assert.deepEqual(loadSummaries(file), {});
    fs.writeFileSync(file, '{"git": "ok", "bad": 3}');
    assert.deepEqual(loadSummaries(file), { git: "ok" });
    fs.writeFileSync(file, "{not json");
    assert.deepEqual(loadSummaries(file), {});
  });

  it("lines every loaded value again and drops empty ones, as if it had just been learned", () => {
    const file = tmp();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ git: "  Git tools.\nUse repo: git.example.com  ", long: "x".repeat(400), empty: "   \n  ", gone: "", kept: 3 }));
    assert.deepEqual(loadSummaries(file), { git: "Git tools.", long: "x".repeat(250) });
  });

  it("records after a run without throwing, even when the file cannot be written", () => {
    const mcp = yamlFile("servers:\n  git: { command: g }\n");
    const file = tmp();
    recordSummaries(file, mcp, [tool("mcp__git__git_read", "git", "Git tools.")]);
    assert.deepEqual(loadSummaries(file), { git: "Git tools." });
    const blocked = path.join(yamlFile(""), "under-a-file", "s.json");
    assert.doesNotThrow(() => recordSummaries(blocked, mcp, [tool("mcp__git__git_read", "git", "Git tools.")]));
  });

  it("the extension registers with the remembered summary at start and records new ones at the end of each run", async () => {
    const mcp = yamlFile("servers:\n  git: { command: g }\n  gdb: { command: d }\n");
    const file = tmp();
    saveSummaries(file, { git: "Git tools." });
    const x = load(mcp, file, [tool("mcp__gdb__gdb_start", "gdb", "GDB tools.")]);
    assert.deepEqual(x.events, ["session_start", "before_agent_start", "agent_end"]);
    await x.handlers[0]?.({}, { ui: { notify: () => undefined } } as never);
    assert.equal(x.configs.get("git")?.description, "Git tools.");
    assert.equal(x.configs.get("gdb")?.description, undefined, "nothing remembered yet");
    await x.handlers[2]?.({}, {} as never);
    assert.deepEqual(loadSummaries(file), { git: "Git tools.", gdb: "GDB tools." });
  });

  it("does not listen for run ends when the daemon named no summaries file", () => {
    assert.deepEqual(load(yamlFile("servers: {}\n")).events, ["session_start", "before_agent_start"]);
  });
});

describe("loading MCP tools in one go (ticket 305)", () => {
  const event = () => ({ systemPromptOptions: { promptGuidelines: ["other"] } });

  it("adds the guideline once, only when tool_search is among the session's tools", () => {
    const e = event();
    addToolSearchGuideline(e, ["read", "tool_search"]);
    addToolSearchGuideline(e, ["read", "tool_search"]);
    assert.deepEqual(e.systemPromptOptions.promptGuidelines, ["other", TOOL_SEARCH_GUIDELINE]);
    const none = event();
    addToolSearchGuideline(none, ["read"]);
    assert.deepEqual(none.systemPromptOptions.promptGuidelines, ["other"]);
  });

  it("never throws on an event of another shape", () => {
    assert.doesNotThrow(() => addToolSearchGuideline(undefined, ["tool_search"]));
    assert.doesNotThrow(() => addToolSearchGuideline({ systemPromptOptions: {} }, ["tool_search"]));
  });

  it("says why loading costs, and asks for one early, named load", () => {
    assert.match(TOOL_SEARCH_GUIDELINE, /without the prompt cache/);
    assert.match(TOOL_SEARCH_GUIDELINE, /one tool_search call, as early as you can/);
    assert.match(TOOL_SEARCH_GUIDELINE, /set limit/);
  });
});
