// Bearer tokens and headers for URL MCP servers (ticket 10): the header builders, the mcp.yaml edit, and the secret prompt that
// asks for a token without echoing it.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { bearerEnvHeader, bearerTokenHeader, mcpEntry, parseHeaderArg, withHeaders } from "../src/mcp.ts";
import { addMcpServer, readMcpYaml, redactEntry, setMcpServerHeaders } from "../src/mcp-config.ts";
import { MASK_CHAR, SecretPrompt } from "../src/secret-prompt.ts";

const tmpFile = (content?: string): string => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "toriel-mcpauth-")), "mcp.yaml");
  if (content !== undefined) {
    fs.writeFileSync(file, content);
  }
  return file;
};

/** pi's ${NAME} syntax, written so the linter does not take it for a mistaken template string. */
const ref = (name: string): string => `\${${name}}`;

describe("the header builders", () => {
  it("--bearer-env writes a reference pi substitutes, never a value", () => {
    assert.deepEqual(bearerEnvHeader("DOCS_TOKEN"), { Authorization: `Bearer ${ref("DOCS_TOKEN")}` });
    assert.throws(() => bearerEnvHeader("not a name"), /environment variable name/);
    assert.throws(() => bearerEnvHeader("1ABC"), /environment variable name/);
  });

  it("a pasted token is one word", () => {
    assert.deepEqual(bearerTokenHeader("  abc.def-123  "), { Authorization: "Bearer abc.def-123" });
    assert.throws(() => bearerTokenHeader("two words"), /one word/);
    assert.throws(() => bearerTokenHeader("   "), /one word/);
  });

  it("--header NAME=VALUE keeps a $-brace variable and !command values whole, and the first = splits", () => {
    assert.deepEqual(parseHeaderArg(`X-Api-Key=${ref("KEY")}`), ["X-Api-Key", ref("KEY")]);
    assert.deepEqual(parseHeaderArg("Authorization=!echo Bearer $(gh auth token)"), ["Authorization", "!echo Bearer $(gh auth token)"]);
    assert.deepEqual(parseHeaderArg("X-Tag=a=b"), ["X-Tag", "a=b"]);
    assert.throws(() => parseHeaderArg("nonsense"), /NAME=VALUE/);
    assert.throws(() => parseHeaderArg("X-Empty="), /NAME=VALUE/);
    assert.throws(() => parseHeaderArg("bad name=1"), /NAME=VALUE/);
  });

  it("headers go on a URL entry, merged with its own, and are refused on a command", () => {
    assert.deepEqual(withHeaders(mcpEntry(["https://x/mcp"]), { Authorization: "Bearer t" }), { url: "https://x/mcp", headers: { Authorization: "Bearer t" } });
    assert.deepEqual(withHeaders({ url: "https://x/mcp", headers: { A: "1" } }, { B: "2" }).headers, { A: "1", B: "2" });
    assert.deepEqual(withHeaders(mcpEntry(["npx", "pkg"]), {}), { command: "npx", args: ["pkg"] });
    assert.throws(() => withHeaders(mcpEntry(["npx", "pkg"]), { A: "1" }), /URL/);
  });
});

describe("mcp.yaml with headers", () => {
  it("add keeps the header, and the file is owner-only", () => {
    const file = tmpFile();
    addMcpServer(file, "docs", withHeaders(mcpEntry(["https://docs.example.com/mcp"]), bearerEnvHeader("DOCS_TOKEN")));
    assert.deepEqual(readMcpYaml(file).servers.docs, { url: "https://docs.example.com/mcp", headers: { Authorization: `Bearer ${ref("DOCS_TOKEN")}` } });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  it("setMcpServerHeaders replaces one header and keeps the others and the comments", () => {
    const file = tmpFile("# mine\nservers:\n  docs:\n    url: https://docs.example.com/mcp\n    headers:\n      X-Team: blue\n      Authorization: Bearer old\n");
    setMcpServerHeaders(file, "docs", { Authorization: "Bearer new" });
    const text = fs.readFileSync(file, "utf8");
    assert.match(text, /# mine/);
    assert.deepEqual(readMcpYaml(file).servers.docs?.headers, { "X-Team": "blue", Authorization: "Bearer new" });
  });

  it("setMcpServerHeaders refuses a missing server and a command server", () => {
    const file = tmpFile("servers:\n  tool:\n    command: uvx\n");
    assert.throws(() => setMcpServerHeaders(file, "nope", { A: "1" }), /not in/);
    assert.throws(() => setMcpServerHeaders(file, "tool", { A: "1" }), /command server/);
  });

  it("a shown entry hides the token", () => {
    const shown = JSON.stringify(redactEntry({ url: "https://x/mcp", headers: { Authorization: "Bearer sekrit-token" } }));
    assert.ok(!shown.includes("sekrit-token"));
    assert.match(shown, /Authorization/);
  });
});

describe("SecretPrompt", () => {
  const type = (p: SecretPrompt, text: string) => {
    for (const ch of text) {
      p.key(ch);
    }
  };

  it("holds typed text and shows only dots", () => {
    const p = new SecretPrompt();
    p.open("token");
    type(p, "abc");
    assert.equal(p.masked(), MASK_CHAR.repeat(3));
    assert.ok(!p.masked().includes("a"));
    assert.deepEqual(p.key("\r"), { kind: "done", value: "abc" });
    assert.equal(p.isOpen, false);
    assert.equal(p.masked(), "");
  });

  it("backspace and ctrl-u edit, a paste (with its markers and trailing newline) is taken whole", () => {
    const p = new SecretPrompt();
    p.open("token");
    type(p, "abcd");
    p.key("\x7f");
    assert.equal(p.length, 3);
    p.key("\x15");
    assert.equal(p.length, 0);
    p.key("\x1b[200~tok-en-123\n\x1b[201~");
    assert.deepEqual(p.key("\r"), { kind: "done", value: "tok-en-123" });
  });

  it("esc cancels and forgets; an empty enter cancels too", () => {
    const p = new SecretPrompt();
    p.open("token");
    type(p, "abc");
    assert.deepEqual(p.key("\x1b"), { kind: "cancel" });
    assert.equal(p.length, 0);
    p.open("token");
    assert.deepEqual(p.key("\r"), { kind: "cancel" });
  });

  it("control sequences (arrows) are not part of the secret", () => {
    const p = new SecretPrompt();
    p.open("token");
    type(p, "ab");
    p.key("\x1b[A");
    p.key("\x1b[D");
    assert.deepEqual(p.key("\r"), { kind: "done", value: "ab" });
  });
});
