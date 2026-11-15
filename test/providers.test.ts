// Provider set-up without editing JSON (ticket 12): the models.json edits, the model-list reader, and the /provider and /login flows.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Host } from "../src/host.ts";
import { addProvider, apiKeyValue, fetchModels, keyKind, listProviders, parseModelList, removeProvider, resolveForProbe, setProviderKey } from "../src/providers.ts";
import { SessionCommands } from "../src/session-commands.ts";

const SECRET = "sk-SECRET-key-123";
const NOW = new Date(2026, 10, 15, 9, 30, 5);

/** pi's own `$NAME` spelling, built so the linter does not take it for a mistaken template string. */
const dollar = (name: string): string => `$${name}`;

let dir: string;
let file: string;
let savedDir: string | undefined;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-providers-"));
  file = path.join(dir, "models.json");
  savedDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
});
afterEach(() => {
  if (savedDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = savedDir;
  }
});
const readJson = () => JSON.parse(fs.readFileSync(file, "utf8")) as { providers: Record<string, Record<string, unknown>>; other?: unknown };

describe("keyKind and apiKeyValue", () => {
  it("tells how a key is held without exposing it", () => {
    assert.equal(keyKind("sk-abc"), "literal");
    assert.equal(keyKind(dollar("MY_KEY")), "env");
    assert.equal(keyKind("!pass show x"), "command");
    assert.equal(keyKind(""), "none");
    assert.equal(keyKind(undefined), "none");
  });

  it("an environment variable is written as $NAME; a literal must be one word", () => {
    assert.equal(apiKeyValue({ env: "MY_KEY" }), dollar("MY_KEY"));
    assert.throws(() => apiKeyValue({ env: "my key" }), /environment variable name/);
    assert.equal(apiKeyValue({ literal: `  ${SECRET}  ` }), SECRET);
    assert.throws(() => apiKeyValue({ literal: "two words" }), /one word/);
    assert.throws(() => apiKeyValue({ literal: "" }), /one word/);
  });

  it("resolves a key for asking the endpoint: literal as is, a variable from the environment, a command not at all", () => {
    assert.equal(resolveForProbe("sk-abc", {}), "sk-abc");
    assert.equal(resolveForProbe(dollar("K"), { K: "from-env" }), "from-env");
    assert.equal(resolveForProbe(dollar("K"), {}), undefined);
    assert.equal(resolveForProbe("!cmd", {}), undefined);
  });
});

describe("the models.json edits", () => {
  it("adds a provider to a file that does not exist yet, owner-only, with no backup to make", () => {
    const backup = addProvider(dir, { id: "home", baseUrl: "http://server2:11434/v1/", api: "openai-completions", models: [{ id: "llama3", contextWindow: 8192, maxTokens: 2048 }] }, NOW);
    assert.equal(backup, undefined);
    assert.deepEqual(readJson().providers.home, { baseUrl: "http://server2:11434/v1", api: "openai-completions", models: [{ id: "llama3", contextWindow: 8192, maxTokens: 2048 }] });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  it("keeps everything else in the file and the original as a backup", () => {
    fs.writeFileSync(file, JSON.stringify({ other: { keep: 1 }, providers: { litellm: { baseUrl: "https://l/v1", apiKey: SECRET, models: [{ id: "a" }] } } }), { mode: 0o640 });
    const backup = addProvider(dir, { id: "extra", baseUrl: "https://x/v1", api: "openai-completions", apiKey: dollar("X_KEY"), models: [{ id: "m", cost: { input: 1.5, output: 3 } }] }, NOW);
    assert.equal(backup, `${file}.bak-20261115-093005`);
    assert.ok(fs.readFileSync(backup as string, "utf8").includes('"litellm"'), "the backup is the original");
    const after = readJson();
    assert.deepEqual(after.other, { keep: 1 });
    assert.equal(after.providers.litellm?.apiKey, SECRET, "the other provider is untouched");
    assert.deepEqual(after.providers.extra?.models, [{ id: "m", cost: { input: 1.5, output: 3, cacheRead: 0, cacheWrite: 0 } }]);
    assert.equal(after.providers.extra?.apiKey, dollar("X_KEY"));
    assert.equal(fs.statSync(file).mode & 0o777, 0o640, "the file's mode is kept");
  });

  it("refuses an existing provider, a bad name, a bad URL and an unknown api", () => {
    addProvider(dir, { id: "p", baseUrl: "https://p/v1", api: "openai-completions", models: [] }, NOW);
    assert.throws(() => addProvider(dir, { id: "p", baseUrl: "https://p/v1", api: "openai-completions", models: [] }, NOW), /already/);
    assert.throws(() => addProvider(dir, { id: "bad name", baseUrl: "https://p/v1", api: "openai-completions", models: [] }, NOW), /provider name/);
    assert.throws(() => addProvider(dir, { id: "q", baseUrl: "ftp://p", api: "openai-completions", models: [] }, NOW), /http/);
    assert.throws(() => addProvider(dir, { id: "q", baseUrl: "https://p", api: "nope", models: [] }, NOW), /api must be/);
  });

  it("will not touch a file that is not valid JSON", () => {
    fs.writeFileSync(file, "{ not json");
    assert.throws(() => addProvider(dir, { id: "p", baseUrl: "https://p/v1", api: "openai-completions", models: [] }, NOW), /not valid JSON/);
    assert.equal(fs.readFileSync(file, "utf8"), "{ not json");
  });

  it("sets a key on a provider, keeping the rest; a built-in provider becomes just a key", () => {
    fs.writeFileSync(file, JSON.stringify({ providers: { litellm: { baseUrl: "https://l/v1", models: [{ id: "a" }] } } }));
    assert.equal(setProviderKey(dir, "litellm", SECRET, NOW).created, false);
    assert.deepEqual(readJson().providers.litellm, { baseUrl: "https://l/v1", models: [{ id: "a" }], apiKey: SECRET });
    assert.equal(setProviderKey(dir, "openrouter", dollar("OPENROUTER_API_KEY"), NOW).created, true);
    assert.deepEqual(readJson().providers.openrouter, { apiKey: dollar("OPENROUTER_API_KEY") });
  });

  it("removes a provider and says when it is not there", () => {
    addProvider(dir, { id: "p", baseUrl: "https://p/v1", api: "openai-completions", models: [] }, NOW);
    removeProvider(dir, "p", NOW);
    assert.deepEqual(readJson().providers, {});
    assert.throws(() => removeProvider(dir, "p", NOW), /not in/);
  });

  it("lists the providers with how each key is held, and never the key", () => {
    fs.writeFileSync(
      file,
      JSON.stringify({ providers: { a: { baseUrl: "https://a/v1", api: "openai-completions", apiKey: SECRET, models: [{ id: "m" }, { id: "n" }] }, b: { apiKey: dollar("B_KEY") }, c: { apiKey: "!pass c" }, d: {} } }),
    );
    const rows = listProviders(dir);
    assert.deepEqual(
      rows.map((r) => [r.id, r.key, r.keyEnv, r.models]),
      [
        ["a", "literal", undefined, 2],
        ["b", "env", "B_KEY", 0],
        ["c", "command", undefined, 0],
        ["d", "none", undefined, 0],
      ],
    );
    assert.ok(!JSON.stringify(rows).includes(SECRET));
    assert.deepEqual(listProviders(path.join(dir, "missing")), []);
  });
});

describe("parseModelList and fetchModels", () => {
  it("reads ids and the sizes a gateway states, skipping duplicates and odd ids", () => {
    const body = { data: [{ id: "a/b", context_length: 128000, max_output_tokens: 4096 }, { id: "plain" }, { id: "a/b" }, { id: "has space" }, { id: 7 }, { id: "ctx", max_input_tokens: 32000 }] };
    assert.deepEqual(parseModelList(body), [{ id: "a/b", contextWindow: 128000, maxTokens: 4096 }, { id: "plain" }, { id: "ctx", contextWindow: 32000 }]);
    assert.deepEqual(parseModelList({}), []);
    assert.deepEqual(parseModelList(null), []);
  });

  it("asks <base>/models with the key as a Bearer token, and says why when it cannot", async () => {
    const seen: Array<string | undefined> = [];
    const ok = (async (url: string, init: { headers: Record<string, string> }) => {
      seen.push(`${url} ${init.headers.Authorization}`);
      return new Response(JSON.stringify({ data: [{ id: "m1" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    assert.deepEqual(await fetchModels("https://h/v1/", SECRET, ok), [{ id: "m1" }]);
    assert.deepEqual(seen, [`https://h/v1/models Bearer ${SECRET}`]);
    const refused = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    assert.match(String(await fetchModels("https://h/v1", SECRET, refused)), /refused the key \(401\)/);
    const down = (async () => {
      throw new Error(`connect failed with Bearer ${SECRET}`);
    }) as unknown as typeof fetch;
    const why = String(await fetchModels("https://h/v1", SECRET, down));
    assert.match(why, /could not ask h/);
    assert.ok(!why.includes(SECRET), "a key in an error message is hidden");
    const empty = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch;
    assert.match(String(await fetchModels("https://h/v1", undefined, empty)), /lists no models/);
  });
});

/** A stand-in endpoint: answers /models (and a bifrost-style /v1/models) with two models when the key is right. */
function stub(): Promise<{ url: string; auth: Array<string | undefined>; close: () => void }> {
  const auth: Array<string | undefined> = [];
  const server = http.createServer((req, res) => {
    auth.push(req.headers.authorization);
    if (req.headers.authorization !== `Bearer ${SECRET}` && req.headers.authorization !== undefined) {
      res.writeHead(401).end();
      return;
    }
    if (req.url === "/v1/models" || req.url === "/models") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "open/one", context_length: 64000, max_output_tokens: 8000 }, { id: "open/two" }] }));
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, auth, close: () => server.close() }));
  });
}

function fakeHost(secret: string | undefined) {
  const notices: string[] = [];
  const asked: string[] = [];
  const requests: Array<Record<string, unknown>> = [];
  const panels: string[] = [];
  const choices: Array<{ title: string; pick: (c: string) => void }> = [];
  const host = {
    viewing: "/tmp/fake/session.jsonl",
    editor: { setText: () => {} },
    tui: { requestRender: () => {} },
    notify: (m: string) => void notices.push(m),
    metaForPath: () => ({ id: 7, active: true, attachedToYou: true }),
    askSecret: async (label: string) => {
      asked.push(label);
      return secret;
    },
    infoPanel: { show: (t: string) => void panels.push(t) },
    choicePanel: { open: (title: string, _c: string[], _cur: unknown, pick: (c: string) => void) => void choices.push({ title, pick }) },
    request: async (cmd: Record<string, unknown>) => {
      requests.push(cmd);
      return {};
    },
  };
  return { host: host as unknown as Host, notices, asked, requests, panels, choices };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
const leaks = (f: ReturnType<typeof fakeHost>) => JSON.stringify([f.notices, f.requests, f.panels, f.choices.map((c) => c.title)]).includes(SECRET);

describe("/provider add", () => {
  it("asks for the key, asks the endpoint for its models, writes models.json, reloads, and never repeats the key", async () => {
    const s = await stub();
    try {
      const f = fakeHost(SECRET);
      new SessionCommands(f.host).run(`/provider add home ${s.url}`);
      await settle();
      assert.deepEqual(f.asked, ["API key for home"]);
      assert.deepEqual(readJson().providers.home, { baseUrl: s.url, api: "openai-completions", apiKey: SECRET, models: [{ id: "open/one", contextWindow: 64000, maxTokens: 8000 }, { id: "open/two" }] });
      assert.ok(s.auth.includes(`Bearer ${SECRET}`), "the key was used to ask");
      assert.ok(f.requests.some((r) => r.type === "reload"));
      assert.ok(f.notices.some((n) => /2 models/.test(n)));
      assert.equal(leaks(f), false);
    } finally {
      s.close();
    }
  });

  it("a gateway by its name is asked the way the doctor asks it (bifrost: /v1/models)", async () => {
    const s = await stub();
    try {
      const f = fakeHost(SECRET);
      new SessionCommands(f.host).run(`/provider add work-bifrost ${s.url}/v1`);
      await settle();
      await new Promise((r) => setTimeout(r, 500));
      const models = readJson().providers["work-bifrost"]?.models as Array<Record<string, unknown>>;
      assert.deepEqual(
        models.map((m) => m.id),
        ["open/one", "open/two"],
      );
      assert.equal(models[0]?.contextWindow, 64000);
      assert.equal(leaks(f), false);
    } finally {
      s.close();
    }
  });

  it("a cancelled key prompt adds nothing", async () => {
    const f = fakeHost(undefined);
    new SessionCommands(f.host).run("/provider add home http://127.0.0.1:1/v1");
    await settle();
    assert.equal(fs.existsSync(file), false);
    assert.ok(f.notices.some((n) => /not added/.test(n)));
  });

  it("--key-env writes $NAME and asks for nothing; --no-key writes no key; --no-models writes none", async () => {
    const f = fakeHost(SECRET);
    new SessionCommands(f.host).run("/provider add a http://127.0.0.1:1/v1 --key-env A_KEY --no-models");
    new SessionCommands(f.host).run("/provider add b http://127.0.0.1:1/v1 --no-key --no-models --api openai-responses");
    await settle();
    assert.deepEqual(f.asked, []);
    const { providers } = readJson();
    assert.deepEqual(providers.a, { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: dollar("A_KEY"), models: [] });
    assert.deepEqual(providers.b, { baseUrl: "http://127.0.0.1:1/v1", api: "openai-responses", models: [] });
  });

  it("when the endpoint cannot be asked, the provider is still added, with the reason said", async () => {
    const f = fakeHost(SECRET);
    new SessionCommands(f.host).run("/provider add down http://127.0.0.1:1/v1");
    await settle();
    assert.equal(readJson().providers.down?.apiKey, SECRET);
    assert.deepEqual(readJson().providers.down?.models, []);
    assert.ok(f.notices.some((n) => /no models written: could not ask/.test(n)));
    assert.equal(leaks(f), false);
  });

  it("refuses a duplicate, a bad name, and --key-env with --no-key, before asking for a key", async () => {
    addProvider(dir, { id: "home", baseUrl: "https://h/v1", api: "openai-completions", models: [] }, NOW);
    const f = fakeHost(SECRET);
    new SessionCommands(f.host).run("/provider add home https://h/v1");
    new SessionCommands(f.host).run("/provider add bad/name https://h/v1");
    new SessionCommands(f.host).run("/provider add x https://h/v1 --key-env K --no-key");
    await settle();
    assert.deepEqual(f.asked, []);
    assert.equal(f.notices.filter((n) => n.startsWith("/provider add:")).length, 3);
  });
});

describe("/provider list, /provider remove and /login", () => {
  it("list shows each provider and how its key is held, and no key", async () => {
    fs.writeFileSync(file, JSON.stringify({ providers: { a: { baseUrl: "https://a/v1", apiKey: SECRET, models: [{ id: "m" }] }, b: { baseUrl: "https://b/v1", apiKey: dollar("B_KEY") } } }));
    const f = fakeHost(undefined);
    new SessionCommands(f.host).run("/provider list");
    await settle();
    assert.match(f.panels[0] ?? "", /a: https:\/\/a\/v1 - key stored, 1 model/);
    assert.match(f.panels[0] ?? "", /b: https:\/\/b\/v1 - key from \$B_KEY, 0 models/);
    assert.equal(leaks(f), false);
  });

  it("remove asks first, then removes and reloads", async () => {
    addProvider(dir, { id: "home", baseUrl: "https://h/v1", api: "openai-completions", models: [] }, NOW);
    const f = fakeHost(undefined);
    new SessionCommands(f.host).run("/provider remove home");
    await settle();
    assert.equal(f.choices.length, 1);
    assert.ok("home" in readJson().providers, "nothing is removed before the answer");
    f.choices[0]?.pick("Cancel");
    assert.ok("home" in readJson().providers);
    f.choices[0]?.pick("Remove");
    await settle();
    assert.deepEqual(readJson().providers, {});
    assert.ok(f.requests.some((r) => r.type === "reload"));
  });

  it("/login asks for the key, stores it, reloads, and never repeats it", async () => {
    fs.writeFileSync(file, JSON.stringify({ providers: { litellm: { baseUrl: "https://l/v1", models: [{ id: "a" }] } } }));
    const f = fakeHost(SECRET);
    new SessionCommands(f.host).run("/login litellm");
    await settle();
    assert.deepEqual(f.asked, ["API key for litellm"]);
    assert.equal(readJson().providers.litellm?.apiKey, SECRET);
    assert.ok(f.requests.some((r) => r.type === "reload"));
    assert.equal(leaks(f), false);
  });

  it("/login for a provider that is not there creates it with just the key, and says so", async () => {
    const f = fakeHost(SECRET);
    new SessionCommands(f.host).run("/login openrouter");
    await settle();
    assert.deepEqual(readJson().providers.openrouter, { apiKey: SECRET });
    assert.ok(f.notices.some((n) => /was not in models.json/.test(n)));
  });

  it("/login --key-env, a cancelled prompt, and no argument", async () => {
    const f = fakeHost(undefined);
    new SessionCommands(f.host).run("/login openai --key-env OPENAI_API_KEY");
    await settle();
    assert.equal(readJson().providers.openai?.apiKey, dollar("OPENAI_API_KEY"));
    const before = fs.readFileSync(file, "utf8");
    new SessionCommands(f.host).run("/login zai");
    await settle();
    assert.equal(fs.readFileSync(file, "utf8"), before);
    new SessionCommands(f.host).run("/login");
    await settle();
    assert.match(f.panels.at(-1) ?? "", /Providers/);
  });
});
