// /mcp add --token | --bearer-env | --header and /mcp token (ticket 10): what lands in mcp.yaml, that the secret only ever goes through
// askSecret, and that a cancelled prompt changes nothing.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Host } from "../src/host.ts";
import { readMcpYaml } from "../src/mcp-config.ts";
import { SessionCommands } from "../src/session-commands.ts";

const KEY = "/tmp/fake/session.jsonl";
const TOKEN = "tok-SECRET-1234";
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** pi's ${NAME} syntax, written so the linter does not take it for a mistaken template string. */
const ref = (name: string): string => `\${${name}}`;

let file: string;
let saved: string | undefined;
beforeEach(() => {
  file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "toriel-mcptoken-")), "mcp.yaml");
  saved = process.env.TORIEL_MCP;
  process.env.TORIEL_MCP = file;
});
afterEach(() => {
  if (saved === undefined) {
    delete process.env.TORIEL_MCP;
  } else {
    process.env.TORIEL_MCP = saved;
  }
});

function fakeHost(answer: string | undefined) {
  const notices: string[] = [];
  const asked: string[] = [];
  const requests: Array<Record<string, unknown>> = [];
  const typed: string[] = [];
  const host = {
    viewing: KEY,
    editor: { setText: (t: string) => typed.push(t) },
    tui: { requestRender: () => {} },
    notify: (m: string) => void notices.push(m),
    metaForPath: () => ({ id: 7, active: true, attachedToYou: true }),
    askSecret: async (label: string) => {
      asked.push(label);
      return answer;
    },
    request: async (cmd: Record<string, unknown>) => {
      requests.push(cmd);
      return {};
    },
  };
  return { host: host as unknown as Host, notices, asked, requests, typed };
}

describe("/mcp add with authentication", () => {
  it("--token asks for the token, writes it as a bearer header, and never says it", async () => {
    const f = fakeHost(TOKEN);
    new SessionCommands(f.host).run("/mcp add docs https://docs.example.com/mcp --token");
    await settle();
    assert.deepEqual(f.asked, ["bearer token for docs"]);
    assert.deepEqual(readMcpYaml(file).servers.docs, { url: "https://docs.example.com/mcp", headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.ok(!JSON.stringify([f.notices, f.requests, f.typed]).includes(TOKEN), "the token appears in no notice, request or editor text");
    assert.ok(f.requests.some((r) => r.type === "reload"), "the session reloads to pick the server up");
  });

  it("a cancelled prompt adds nothing", async () => {
    const f = fakeHost(undefined);
    new SessionCommands(f.host).run("/mcp add docs https://docs.example.com/mcp --token");
    await settle();
    assert.equal(readMcpYaml(file).servers.docs, undefined);
    assert.ok(f.notices.some((n) => /not added/.test(n)));
  });

  it("--bearer-env writes a reference, and asks for nothing", async () => {
    const f = fakeHost(TOKEN);
    new SessionCommands(f.host).run("/mcp add docs https://docs.example.com/mcp --bearer-env DOCS_TOKEN");
    await settle();
    assert.deepEqual(f.asked, []);
    assert.deepEqual(readMcpYaml(file).servers.docs?.headers, { Authorization: `Bearer ${ref("DOCS_TOKEN")}` });
  });

  it("--header can be repeated", async () => {
    const f = fakeHost(undefined);
    new SessionCommands(f.host).run(`/mcp add docs https://docs.example.com/mcp --header X-Team=blue --header X-Key=${ref("KEY")}`);
    await settle();
    assert.deepEqual(readMcpYaml(file).servers.docs?.headers, { "X-Team": "blue", "X-Key": ref("KEY") });
  });

  it("refuses a token for a command server, and both --token and --bearer-env, before asking anything", async () => {
    const f = fakeHost(TOKEN);
    new SessionCommands(f.host).run("/mcp add tool --token -- uvx some-mcp");
    new SessionCommands(f.host).run("/mcp add docs https://docs.example.com/mcp --token --bearer-env X");
    await settle();
    assert.deepEqual(f.asked, []);
    assert.equal(fs.existsSync(file), false);
    assert.equal(f.notices.filter((n) => n.startsWith("/mcp add:")).length, 2);
  });
});

describe("/mcp token", () => {
  const seed = () => fs.writeFileSync(file, "servers:\n  docs:\n    url: https://docs.example.com/mcp\n    headers:\n      X-Team: blue\n  tool:\n    command: uvx\n");

  it("asks for the token and sets only the Authorization header", async () => {
    seed();
    const f = fakeHost(TOKEN);
    new SessionCommands(f.host).run("/mcp token docs");
    await settle();
    assert.deepEqual(readMcpYaml(file).servers.docs?.headers, { "X-Team": "blue", Authorization: `Bearer ${TOKEN}` });
    assert.ok(!JSON.stringify([f.notices, f.requests, f.typed]).includes(TOKEN));
  });

  it("--bearer-env sets a reference without asking", async () => {
    seed();
    const f = fakeHost(TOKEN);
    new SessionCommands(f.host).run("/mcp token docs --bearer-env DOCS_TOKEN");
    await settle();
    assert.deepEqual(f.asked, []);
    assert.equal(readMcpYaml(file).servers.docs?.headers?.Authorization, `Bearer ${ref("DOCS_TOKEN")}`);
  });

  it("a cancelled prompt leaves the file alone; unknown and command servers are refused", async () => {
    seed();
    const before = fs.readFileSync(file, "utf8");
    const f = fakeHost(undefined);
    new SessionCommands(f.host).run("/mcp token docs");
    await settle();
    new SessionCommands(f.host).run("/mcp token nope");
    new SessionCommands(f.host).run("/mcp token tool");
    await settle();
    assert.equal(fs.readFileSync(file, "utf8"), before);
    assert.ok(f.notices.some((n) => /not in/.test(n)));
    assert.ok(f.notices.some((n) => /URL/.test(n)));
  });
});
