// The toriel-mcp extension (tickets 209 and 216): registers mcp.yaml's servers into pi at session start, `whenUp` ones only when they answer.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { MCP_FILE_ENV } from "../pi/extensions/lib/mcp-config.ts";
import setup, { describeOutcomes, loadServers, reconcile, UP_COMMAND } from "../pi/extensions/toriel-mcp.ts";

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

describe("the extension", () => {
  function load(file: string | undefined) {
    const previous = process.env[MCP_FILE_ENV];
    if (file === undefined) {
      delete process.env[MCP_FILE_ENV];
    } else {
      process.env[MCP_FILE_ENV] = file;
    }
    const handlers: Array<(e: unknown, ctx: never) => unknown> = [];
    const commands = new Map<string, (args: string, ctx: { ui: { notify(m: string, t?: string): void } }) => Promise<void> | void>();
    const registered: string[] = [];
    try {
      setup({
        on: (_event, handler) => handlers.push(handler),
        registerCommand: (name, options) => commands.set(name, options.handler),
        registerMcpServer: (name) => registered.push(name),
        getMcpServers: () => registered.map((name) => ({ name })),
      });
    } finally {
      if (previous === undefined) {
        delete process.env[MCP_FILE_ENV];
      } else {
        process.env[MCP_FILE_ENV] = previous;
      }
    }
    return { handlers, commands, registered };
  }

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
