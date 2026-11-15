import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { spawn } from "node:child_process";
import { applyDrift, diffRoutes, probeLitellm, readLitellmEntries, resolveApiKey, routeInfo } from "../src/litellm-models.ts";

describe("routeInfo: litellm's /model/info row in pi's units", () => {
  it("maps tokens and per-token cost to per-million", () => {
    assert.deepEqual(routeInfo({ max_input_tokens: 262144, max_output_tokens: 65536, input_cost_per_token: 0.0000025, output_cost_per_token: 0.00001 }), {
      contextWindow: 262144,
      maxTokens: 65536,
      cost: { input: 2.5, output: 10 },
    });
  });

  it("falls back to max_tokens for both limits, and says nothing about what litellm does not state", () => {
    assert.deepEqual(routeInfo({ max_tokens: 8192 }), { contextWindow: 8192, maxTokens: 8192 });
    assert.deepEqual(routeInfo({}), {});
    assert.deepEqual(routeInfo(undefined), {});
    assert.deepEqual(routeInfo({ max_input_tokens: "big", max_output_tokens: -1, input_cost_per_token: null }), {});
  });
});

const entry = (over: Record<string, unknown>) => ({ id: "local-model", input: ["text"], reasoning: true, contextWindow: 122880, maxTokens: 65536, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...over });

describe("diffRoutes / applyDrift", () => {
  it("lists only the fields litellm states and that differ", () => {
    const { drift, gone, extra } = diffRoutes([entry({}), entry({ id: "old" })], { "local-model": { contextWindow: 262144, maxTokens: 65536 }, fresh: { contextWindow: 1 } });
    assert.deepEqual(drift, [{ id: "local-model", changes: [["contextWindow", 122880, 262144]] }]);
    assert.deepEqual(gone, ["old"]);
    assert.deepEqual(extra, ["fresh"]);
  });

  it("treats a missing cost as free, so only a priced route differs", () => {
    const bare = { id: "x", contextWindow: 10, maxTokens: 5 };
    assert.deepEqual(diffRoutes([bare], { x: { cost: { input: 0 } } }).drift, [], "free on both sides");
    assert.deepEqual(diffRoutes([bare], { x: { cost: { input: 2.5 } } }).drift, [{ id: "x", changes: [["cost.input", undefined, 2.5]] }]);
  });

  it("changes only the drifted fields and keeps everything else about an entry", () => {
    const models = [entry({}), entry({ id: "other", extra: "keep" })];
    const { drift } = diffRoutes(models, { "local-model": { contextWindow: 262144, cost: { input: 1 } }, other: {} });
    const next = applyDrift(models, drift);
    assert.deepEqual(next[0], entry({ contextWindow: 262144, cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } }));
    assert.equal(next[1], models[1], "an entry with no drift is the same object");
    assert.equal(models[0]?.contextWindow, 122880, "the input is not mutated");
  });
});

describe("readLitellmEntries / resolveApiKey", () => {
  it("reads the litellm provider and nothing else", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-litellm-"));
    try {
      assert.equal(readLitellmEntries(dir), undefined, "no models.json");
      fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: { ollama: { baseUrl: "http://x/v1", models: [{ id: "a" }] } } }));
      assert.equal(readLitellmEntries(dir), undefined, "no litellm provider");
      fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: { litellm: { baseUrl: "https://l.example/v1", apiKey: "!echo k", models: [{ id: "a" }, "junk", { name: "no id" }] } } }));
      assert.deepEqual(readLitellmEntries(dir), { baseUrl: "https://l.example/v1", apiKey: "!echo k", models: [{ id: "a" }] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs a !command, reads an environment variable by name, else takes the text as the key", () => {
    assert.equal(resolveApiKey("!printf sk-1", {}), "sk-1");
    assert.equal(resolveApiKey("!exit 3", {}), undefined);
    assert.equal(resolveApiKey("LITELLM_KEY", { LITELLM_KEY: "from-env" }), "from-env");
    assert.equal(resolveApiKey("literal-key", {}), "literal-key");
    assert.equal(resolveApiKey(undefined, {}), undefined);
    assert.equal(resolveApiKey("", {}), undefined);
  });
});

describe("probeLitellm against a real (child-process) server", () => {
  /** A litellm stand-in in its own process (the probe blocks this one): 401 without the bearer, /model/info with it. */
  async function serve(): Promise<{ url: string; stop(): void }> {
    const code = `
      const http = require("node:http");
      const s = http.createServer((req, res) => {
        if (req.headers.authorization !== "Bearer sk-test") { res.statusCode = 401; res.end("{}"); return; }
        if (req.url !== "/model/info") { res.statusCode = 404; res.end("{}"); return; }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: [{ model_name: "local-model", model_info: { max_input_tokens: 262144, max_output_tokens: 65536, input_cost_per_token: 0.000001 } }, { model_name: "no-info" }] }));
      });
      s.listen(0, "127.0.0.1", () => console.log(s.address().port));
    `;
    const child = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "ignore"] });
    const port = await new Promise<string>((resolve) => child.stdout.once("data", (d) => resolve(String(d).trim())));
    return { url: `http://127.0.0.1:${port}/v1`, stop: () => child.kill() };
  }

  it("sends the credential as a bearer token, reads the routes, and reports why when it cannot", async () => {
    const server = await serve();
    try {
      const ok = probeLitellm({ baseUrl: server.url, apiKey: "!printf sk-test" });
      assert.deepEqual(ok, { routes: { "local-model": { contextWindow: 262144, maxTokens: 65536, cost: { input: 1 } }, "no-info": {} } });
      assert.equal(probeLitellm({ baseUrl: server.url, apiKey: "wrong" }), "HTTP 401");
      assert.equal(probeLitellm({ baseUrl: server.url, apiKey: undefined }), "HTTP 401");
      assert.equal(typeof probeLitellm({ baseUrl: "http://127.0.0.1:1/v1", apiKey: "x" }), "string", "a dead server is a reason, not a throw");
    } finally {
      server.stop();
    }
  });
});
