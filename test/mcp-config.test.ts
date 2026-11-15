// toriel's MCP config (tickets 209 and 216): reading and checking mcp.yaml, the edits /mcp add, /mcp remove and the doctor make to it,
// the one-time move from pi's mcp.json, and the reachability probe a `whenUp` server depends on.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { checkEntry, parseMcpYaml, piConfig, probeUrl, redactUrl, serverUrl } from "../pi/extensions/lib/mcp-config.ts";
import { mcpYamlFile } from "../src/config-dir.ts";
import { addMcpServer, importMcpJson, readMcpYaml, redactEntry, removeMcpServer, renderMcpYaml, setMcpServerKey } from "../src/mcp-config.ts";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "toriel-mcpcfg-"));
const tmpFile = (content?: string): string => {
  const file = path.join(tmpDir(), "mcp.yaml");
  if (content !== undefined) {
    fs.writeFileSync(file, content);
  }
  return file;
};

describe("mcpYamlFile", () => {
  it("sits beside the settings file, and TORIEL_MCP overrides it", () => {
    assert.equal(mcpYamlFile({ XDG_CONFIG_HOME: "/x" }), "/x/toriel/mcp.yaml");
    assert.equal(mcpYamlFile({ HOME: "/home/u" }), "/home/u/.config/toriel/mcp.yaml");
    assert.equal(mcpYamlFile({ TORIEL_SETTINGS: "/t/dir/settings.yaml" }), "/t/dir/mcp.yaml");
    assert.equal(mcpYamlFile({ TORIEL_SETTINGS: "/t/dir/settings.yaml", TORIEL_MCP: "/m/mine.yaml" }), "/m/mine.yaml");
  });
});

describe("parseMcpYaml", () => {
  it("reads command and url servers with their options", () => {
    const { servers, problems } = parseMcpYaml(`
servers:
  git:
    command: node
    args: [x.js, 2]
    env: { TOKEN: abc, N: 3 }
    exposure: direct
    timeout: 300
  freecad:
    url: http://127.0.0.1:39280/mcp
    whenUp: true
    enabled: true
`);
    assert.deepEqual(problems, []);
    assert.deepEqual(servers.git, { command: "node", args: ["x.js", "2"], env: { TOKEN: "abc", N: "3" }, exposure: "direct", timeout: 300 });
    assert.deepEqual(servers.freecad, { url: "http://127.0.0.1:39280/mcp", whenUp: true, enabled: true });
  });

  it("leaves a bad entry out with the reason, and still loads the rest", () => {
    const { servers, problems } = parseMcpYaml(`
servers:
  ok: { command: x }
  both: { command: x, url: "http://h/mcp" }
  neither: { exposure: direct }
  badurl: { url: ftp://h }
  badexp: { command: x, exposure: sometimes }
  badkey: { command: x, lifecycle: lazy }
  badwhen: { command: x, whenUp: true }
  "bad name": { command: x }
  notmap: 5
`);
    assert.deepEqual(Object.keys(servers), ["ok"]);
    assert.equal(problems.length, 8);
    assert.match(problems.join("\n"), /"both": give exactly one of url/);
    assert.match(problems.join("\n"), /"badurl": url must be an http\(s\) URL/);
    assert.match(problems.join("\n"), /"badexp": exposure must be one of/);
    assert.match(problems.join("\n"), /"badkey": unknown key "lifecycle"/);
    assert.match(problems.join("\n"), /"badwhen": whenUp needs a url/);
    assert.match(problems.join("\n"), /server name "bad name"/);
    assert.match(problems.join("\n"), /"notmap": the entry must be a mapping/);
  });

  it("is no servers for an empty file, and says so for text that is not YAML or not a mapping, without throwing", () => {
    assert.deepEqual(parseMcpYaml(""), { servers: {}, problems: [] });
    assert.deepEqual(parseMcpYaml("# only a comment\n"), { servers: {}, problems: [] });
    assert.deepEqual(parseMcpYaml("servers:\n"), { servers: {}, problems: [] });
    assert.match(parseMcpYaml("servers: [\n").problems[0] ?? "", /not valid YAML/);
    assert.match(parseMcpYaml("- a\n- b\n").problems[0] ?? "", /must be a mapping/);
    assert.match(parseMcpYaml("servers:\n  a: { command: x }\nextra: 1\n").problems[0] ?? "", /unknown top-level key "extra"/);
  });

  it("serverUrl accepts http and https only, and piConfig drops toriel's own key", () => {
    assert.equal(serverUrl("https://h/mcp"), "https://h/mcp");
    assert.equal(serverUrl("file:///x"), undefined);
    assert.equal(serverUrl("h:80"), undefined);
    assert.equal(serverUrl(5), undefined);
    assert.deepEqual(piConfig({ url: "http://h/mcp", whenUp: true, exposure: "direct" }), { url: "http://h/mcp", exposure: "direct" });
    assert.ok("problem" in checkEntry("x", null));
    for (const bad of [{ command: "x", timeout: 1e9 }, { command: "x", timeout: 0 }, { command: "x", type: 5 }, { command: "x", cwd: "" }, { command: "x", toolExposure: { a: "sometimes" } }, { command: "x", toolExposure: [] }]) {
      assert.ok("problem" in checkEntry("x", bad), JSON.stringify(bad));
    }
    assert.ok("entry" in checkEntry("x", { command: "x", timeout: 600, type: "stdio", cwd: "/w", toolExposure: { "a*": "direct" } }));
  });
});

describe("redaction (review finding: no secret on screen)", () => {
  it("hides a URL's credentials and query, and never throws", () => {
    assert.equal(redactUrl("https://user:tok3n@host.example:8443/mcp?key=abc"), "https://***@host.example:8443/mcp?...");
    assert.equal(redactUrl("https://tok3n@host/mcp"), "https://***@host/mcp");
    assert.equal(redactUrl("http://127.0.0.1:39280/mcp"), "http://127.0.0.1:39280/mcp");
    assert.equal(redactUrl("not a url"), "(a URL)");
    assert.equal(redactUrl(undefined), "(no url)");
    assert.doesNotMatch(redactUrl("https://u:p4ss@h/x?token=zzz"), /p4ss|zzz/);
  });

  it("keeps the names of an entry's env and headers and hides their values", () => {
    const shown = redactEntry({ command: "uvx", env: { API_KEY: "sk-secret" }, headers: { Authorization: "Bearer s3cret" } });
    assert.deepEqual(shown, { command: "uvx", env: { API_KEY: "***" }, headers: { Authorization: "***" } });
    assert.equal(redactEntry({ url: "https://u:p@h/mcp?token=t" }).url, "https://***@h/mcp?...");
    assert.doesNotMatch(JSON.stringify(shown), /sk-secret|s3cret/);
  });
});

describe("addMcpServer", () => {
  it("creates the file with its header and the server in block style when there is none", () => {
    const file = tmpFile();
    addMcpServer(file, "a", { url: "http://x/mcp" });
    const text = fs.readFileSync(file, "utf8");
    assert.match(text, /^# MCP servers for toriel/);
    assert.match(text, /servers:\n {2}a:\n {4}url: http:\/\/x\/mcp\n/);
    assert.deepEqual(readMcpYaml(file).servers, { a: { url: "http://x/mcp" } });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, "an entry's env may hold a secret");
  });

  it("keeps existing servers, comments and ordering", () => {
    const file = tmpFile("# my notes\nservers:\n  old:\n    command: o   # the old one\n");
    addMcpServer(file, "new", { command: "n", args: ["x"] });
    const text = fs.readFileSync(file, "utf8");
    assert.match(text, /# my notes/);
    assert.match(text, /command: o\s+# the old one/);
    assert.deepEqual(Object.keys(readMcpYaml(file).servers), ["old", "new"]);
  });

  it("refuses to replace a server, an unusable entry, or a file that is not valid YAML", () => {
    const file = tmpFile("servers:\n  a: { command: o }\n");
    assert.throws(() => addMcpServer(file, "a", { command: "n" }), /already exists/);
    assert.throws(() => addMcpServer(file, "b", { command: "n", url: "http://h/mcp" }), /exactly one of url/);
    assert.throws(() => addMcpServer(file, "bad name", { command: "n" }), /server name/);
    const bad = tmpFile("servers: [\n");
    assert.throws(() => addMcpServer(bad, "a", { command: "n" }), /not valid YAML/);
    assert.equal(fs.readFileSync(bad, "utf8"), "servers: [\n");
    const notMap = tmpFile("servers: 5\n");
    assert.throws(() => addMcpServer(notMap, "a", { command: "n" }), /"servers" must be a mapping/);
  });
});

describe("removeMcpServer and setMcpServerKey", () => {
  it("removes one server and keeps the others and the comments", () => {
    const file = tmpFile("# keep\nservers:\n  a: { command: a }\n  b: { url: http://b/mcp }\n");
    removeMcpServer(file, "a");
    assert.match(fs.readFileSync(file, "utf8"), /# keep/);
    assert.deepEqual(Object.keys(readMcpYaml(file).servers), ["b"]);
  });

  it("says so when the server is not there or the file is not valid", () => {
    assert.throws(() => removeMcpServer(tmpFile("servers:\n  a: { command: a }\n"), "ghost"), /"ghost" is not in /);
    assert.throws(() => removeMcpServer(path.join(os.tmpdir(), "no-such-toriel-mcp.yaml"), "a"), /is not in/);
    const bad = tmpFile("servers: [\n");
    assert.throws(() => removeMcpServer(bad, "a"), /not valid YAML/);
    assert.equal(fs.readFileSync(bad, "utf8"), "servers: [\n");
  });

  it("sets one key of one entry, leaving its siblings", () => {
    const file = tmpFile("servers:\n  git: { command: node, args: [x] }\n  gdb: { command: uv, exposure: codemode }\n");
    setMcpServerKey(file, "gdb", "exposure", "direct");
    const { servers } = readMcpYaml(file);
    assert.deepEqual(servers.gdb, { command: "uv", exposure: "direct" });
    assert.deepEqual(servers.git, { command: "node", args: ["x"] });
    assert.throws(() => setMcpServerKey(file, "ghost", "exposure", "direct"), /not in/);
  });
});

describe("readMcpYaml", () => {
  it("is no servers and no problems when the file does not exist, and reports a file it cannot parse", () => {
    assert.deepEqual(readMcpYaml(path.join(tmpDir(), "nope.yaml")), { servers: {}, problems: [] });
    assert.match(readMcpYaml(tmpFile("servers: [\n")).problems[0] ?? "", /not valid YAML/);
  });
});

describe("importMcpJson (the move from pi's mcp.json)", () => {
  it("carries the entries over, and lists what it could not", () => {
    const file = path.join(tmpDir(), "mcp.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        settings: { toolPrefix: "x" },
        mcpServers: {
          git: { command: "node", args: ["x.js"], exposure: "direct", timeout: 300 },
          freecad: { url: "http://127.0.0.1:39280/mcp" },
          odd: { command: "x", lifecycle: "lazy" },
          broken: { exposure: "direct" },
          null: null,
        },
      }),
    );
    const r = importMcpJson(file);
    assert.deepEqual(Object.keys(r.servers).sort(), ["freecad", "git", "odd"]);
    assert.deepEqual(r.servers.odd, { command: "x" });
    assert.deepEqual(r.dropped, ["odd.lifecycle"]);
    assert.deepEqual(r.skipped.sort(), ["broken", "null"]);
  });

  it("is nothing for a file that is missing or not JSON", () => {
    assert.deepEqual(importMcpJson(path.join(tmpDir(), "no.json")), { servers: {}, dropped: [], skipped: [] });
    const bad = path.join(tmpDir(), "mcp.json");
    fs.writeFileSync(bad, "{ nope");
    assert.deepEqual(importMcpJson(bad).servers, {});
  });

  it("renders a file that reads back the same", () => {
    const servers = { a: { command: "x", args: ["1"] }, b: { url: "http://h/mcp", whenUp: true } };
    const text = renderMcpYaml(servers);
    assert.match(text, /^# MCP servers for toriel/);
    assert.deepEqual(parseMcpYaml(text), { servers, problems: [] });
  });
});

describe("probeUrl", () => {
  it("is true while something listens and false once it stops, without throwing", async () => {
    const server = net.createServer((s) => s.destroy());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    assert.equal(await probeUrl(`http://127.0.0.1:${port}/mcp`), true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    assert.equal(await probeUrl(`http://127.0.0.1:${port}/mcp`), false, "a refused port is down");
    assert.equal(await probeUrl("not a url"), false);
  });
});
