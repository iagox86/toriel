import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { spawn } from "node:child_process";
import { type RouteInfo, applyDrift, bifrostRouteInfo, cachedFor, checkGatewaysAtStart, diffRoutes, gatewayKind, probeLitellm, probeLitellmAsync, readGateways, readLitellmEntries, readRoutesCache, resolveApiKey, routeInfo } from "../src/litellm-models.ts";

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

describe("gateway providers: litellm and bifrost (ticket 221)", () => {
  it("a provider is a gateway only when its key says so", () => {
    assert.equal(gatewayKind("litellm"), "litellm");
    assert.equal(gatewayKind("Work-Bifrost"), "bifrost");
    assert.equal(gatewayKind("openai"), undefined);
    assert.equal(gatewayKind("zai"), undefined);
  });

  it("reads every gateway of models.json and nothing else, tagged with its key and kind", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-gateways-"));
    try {
      const models = [{ id: "a" }];
      fs.writeFileSync(
        path.join(dir, "models.json"),
        JSON.stringify({ providers: { litellm: { baseUrl: "https://l/v1", models }, "work-bifrost": { baseUrl: "https://b/openai", apiKey: "BF_KEY", models }, openai: { baseUrl: "https://o/v1", models }, "empty-bifrost": { baseUrl: "https://e", models: [] } } }),
      );
      const found = readGateways(dir).map((g) => [g.provider, g.kind, g.baseUrl, g.apiKey]);
      assert.deepEqual(found, [
        ["litellm", "litellm", "https://l/v1", undefined],
        ["work-bifrost", "bifrost", "https://b/openai", "BF_KEY"],
      ]);
      assert.deepEqual(readGateways(path.join(dir, "nowhere")), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads a bifrost row's context window and output limit (the context length first), and leaves cost alone", () => {
    assert.deepEqual(bifrostRouteInfo({ id: "x/y", context_length: 200000, max_input_tokens: 190000, max_output_tokens: 8192, pricing: { prompt: "0.000003" } }), { contextWindow: 200000, maxTokens: 8192 });
    assert.deepEqual(bifrostRouteInfo({ id: "x/y", max_input_tokens: 1000 }), { contextWindow: 1000 });
    assert.deepEqual(bifrostRouteInfo({ id: "x/y", context_length: 0 }), {});
  });
});

describe("checkGatewaysAtStart: the daemon asks once and keeps the answers (ticket 221)", () => {
  const setup = (providers: Record<string, unknown> | undefined) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-litellm-start-"));
    if (providers !== undefined) {
      fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers }));
    }
    return { dir, cache: path.join(dir, "state", "litellm-routes.json") };
  };
  const litellm = (models: unknown) => ({ litellm: { baseUrl: "https://l.example/v1", apiKey: "sk-secret", models } });

  it("writes the routes and the proxy it asked per provider, never the credential", async () => {
    const s = setup({ ...litellm([{ id: "a" }]), "work-bifrost": { baseUrl: "https://b.example/openai", apiKey: "sk-bf-secret", models: [{ id: "x/y" }] } });
    try {
      const asked: unknown[] = [];
      const wrote = await checkGatewaysAtStart(
        s.dir,
        s.cache,
        async (t) => {
          asked.push(t);
          return { routes: (t.kind === "bifrost" ? { "x/y": { contextWindow: 7 } } : { a: { contextWindow: 5 } }) as Record<string, RouteInfo> };
        },
        1234,
      );
      assert.equal(wrote, true);
      assert.deepEqual(asked, [
        { baseUrl: "https://l.example/v1", apiKey: "sk-secret", kind: "litellm" },
        { baseUrl: "https://b.example/openai", apiKey: "sk-bf-secret", kind: "bifrost" },
      ]);
      assert.deepEqual(readRoutesCache(s.cache), {
        providers: {
          litellm: { checkedAt: 1234, baseUrl: "https://l.example/v1", routes: { a: { contextWindow: 5 } } },
          "work-bifrost": { checkedAt: 1234, baseUrl: "https://b.example/openai", routes: { "x/y": { contextWindow: 7 } } },
        },
      });
      assert.doesNotMatch(fs.readFileSync(s.cache, "utf8"), /secret/);
      assert.equal(cachedFor(readRoutesCache(s.cache), "litellm", "https://other/v1"), undefined, "a cache for another address is not this provider's");
      assert.equal(cachedFor(readRoutesCache(s.cache), "litellm", "https://l.example/v1")?.checkedAt, 1234);
    } finally {
      fs.rmSync(s.dir, { recursive: true, force: true });
    }
  });

  it("one gateway being down keeps the other's answer and the old one for the down one", async () => {
    const s = setup({ ...litellm([{ id: "a" }]), bifrost: { baseUrl: "https://b.example/v1", models: [{ id: "x/y" }] } });
    try {
      await checkGatewaysAtStart(s.dir, s.cache, async (t) => ({ routes: (t.kind === "bifrost" ? { "x/y": { contextWindow: 1 } } : { a: { contextWindow: 1 } }) as Record<string, RouteInfo> }), 1);
      await checkGatewaysAtStart(s.dir, s.cache, async (t) => (t.kind === "bifrost" ? "HTTP 401" : { routes: { a: { contextWindow: 2 } } }), 2);
      const cache = readRoutesCache(s.cache);
      assert.equal(cache.providers.litellm?.checkedAt, 2);
      assert.equal(cache.providers.bifrost?.checkedAt, 1, "the unreachable gateway's earlier answer stays");
    } finally {
      fs.rmSync(s.dir, { recursive: true, force: true });
    }
  });

  it("stays silent and writes nothing without a gateway provider, or when the proxy cannot be asked", async () => {
    const none = setup({ openai: { baseUrl: "https://o/v1", models: [{ id: "m" }] } });
    const down = setup(litellm([{ id: "a" }]));
    try {
      let probed = false;
      const probe = async () => {
        probed = true;
        return { routes: {} };
      };
      assert.equal(await checkGatewaysAtStart(none.dir, none.cache, probe), false);
      assert.equal(probed, false, "no gateway provider: the network is not touched, and an ordinary provider never gets the credential");
      assert.equal(await checkGatewaysAtStart(down.dir, down.cache, async () => "HTTP 401"), false);
      assert.equal(fs.existsSync(none.cache) || fs.existsSync(down.cache), false);
    } finally {
      fs.rmSync(none.dir, { recursive: true, force: true });
      fs.rmSync(down.dir, { recursive: true, force: true });
    }
  });

  it("an unreadable or missing cache reads as empty", () => {
    assert.deepEqual(readRoutesCache(undefined), { providers: {} });
    assert.deepEqual(readRoutesCache("/nonexistent/litellm-routes.json"), { providers: {} });
  });
});

describe("probing a bifrost gateway against a stand-in server (documented API; not yet tried against a real gateway)", () => {
  /** /v1/models in two pages (next_page_token), bearer required; the model-info path of litellm answers 404 so a wrong path shows. */
  async function serve(): Promise<{ url: string; stop(): void }> {
    const code = `
      const http = require("node:http");
      const s = http.createServer((req, res) => {
        res.setHeader("content-type", "application/json");
        if (req.headers.authorization !== "Bearer sk-bf-test") { res.statusCode = 401; res.end("{}"); return; }
        const u = new URL(req.url, "http://x");
        if (u.pathname !== "/v1/models") { res.statusCode = 404; res.end("{}"); return; }
        if (u.searchParams.get("page_token") === "p2") { res.end(JSON.stringify({ data: [{ id: "openai/gpt-x", context_length: 128000, max_output_tokens: 16384 }] })); return; }
        res.end(JSON.stringify({ data: [{ id: "anthropic/claude-x", context_length: 200000, max_input_tokens: 190000, max_output_tokens: 8192 }, { id: "no-limits" }], next_page_token: "p2" }));
      });
      s.listen(0, "127.0.0.1", () => console.log(s.address().port));
    `;
    const child = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "ignore"] });
    const port = await new Promise<string>((resolve) => child.stdout.once("data", (d) => resolve(String(d).trim())));
    return { url: `http://127.0.0.1:${port}`, stop: () => child.kill() };
  }

  it("follows the pages and keys the routes by their provider/model id, for each spelling of the base URL", async () => {
    const server = await serve();
    try {
      const want = { routes: { "anthropic/claude-x": { contextWindow: 200000, maxTokens: 8192 }, "openai/gpt-x": { contextWindow: 128000, maxTokens: 16384 }, "no-limits": {} } };
      for (const suffix of ["", "/v1", "/openai", "/openai/v1", "/openai/v1/"]) {
        assert.deepEqual(await probeLitellmAsync({ baseUrl: `${server.url}${suffix}`, apiKey: "sk-bf-test", kind: "bifrost" }), want, `base URL ${suffix || "(bare)"}`);
      }
      assert.deepEqual(probeLitellm({ baseUrl: `${server.url}/openai`, apiKey: "sk-bf-test", kind: "bifrost" }), want, "the blocking probe too");
      assert.equal(await probeLitellmAsync({ baseUrl: server.url, apiKey: "wrong", kind: "bifrost" }), "HTTP 401");
    } finally {
      server.stop();
    }
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

  it("asks the same question without blocking, a !command credential included (ticket 221)", async () => {
    const server = await serve();
    try {
      const ticks: number[] = [];
      const timer = setInterval(() => ticks.push(Date.now()), 5);
      const ok = await probeLitellmAsync({ baseUrl: server.url, apiKey: "!printf sk-test" });
      clearInterval(timer);
      assert.deepEqual(ok, { routes: { "local-model": { contextWindow: 262144, maxTokens: 65536, cost: { input: 1 } }, "no-info": {} } });
      assert.ok(ticks.length > 3, "the event loop kept running while the child asked");
      assert.equal(await probeLitellmAsync({ baseUrl: server.url, apiKey: "wrong" }), "HTTP 401");
      assert.equal(typeof (await probeLitellmAsync({ baseUrl: "http://127.0.0.1:1/v1", apiKey: "x" })), "string");
    } finally {
      server.stop();
    }
  });

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
