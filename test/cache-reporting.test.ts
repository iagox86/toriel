// Models whose calls never report a cache read (ticket 311): the doctor reads pi's session files and flags a route that drops
// the provider's cached-token count, since the budgets and costs would count the whole context on every call.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { LONG_SESSION_CALLS, MIN_LONG_SESSIONS, scanCacheReporting, sessionCacheUse, uncachedModels } from "../src/cache-reporting.ts";

const call = (provider: string, model: string, input: number, cacheRead: number): string =>
  JSON.stringify({ type: "message", message: { role: "assistant", provider, model, content: [{ type: "text", text: "x" }], usage: { input, output: 50, cacheRead, cacheWrite: 0 } } });
// a long session: more than LONG_SESSION_CALLS calls with a growing context; `cached` says whether the route reports cache reads
const longSession = (provider: string, model: string, cached: boolean): string =>
  Array.from({ length: LONG_SESSION_CALLS + 2 }, (_, i) => (cached ? call(provider, model, 800, 5_000 * i) : call(provider, model, 5_000 * (i + 1), 0))).join("\n");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});
const sessionsDir = (files: Record<string, string>): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cache-reporting-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), `${text}\n`);
  }
  return dir;
};

describe("cache reporting (ticket 311)", () => {
  it("counts each model's calls, largest context and cache-read calls in one session file", () => {
    const text = [
      call("litellm", "local-model", 30_000, 0),
      call("litellm", "local-model", 40_000, 0),
      call("anthropic", "claude-sonnet", 500, 39_000),
      JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }),
      "not json",
      JSON.stringify({ type: "message", message: { role: "assistant", content: [], usage: { input: 1 } } }), // no provider: skipped
    ].join("\n");
    assert.deepEqual(Object.fromEntries(sessionCacheUse(text)), {
      "litellm/local-model": { calls: 2, maxContext: 40_000, cached: 0 },
      "anthropic/claude-sonnet": { calls: 1, maxContext: 39_500, cached: 1 },
    });
  });

  it("flags a model whose long sessions never report a cache read, and passes one whose sessions do", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < MIN_LONG_SESSIONS; i++) {
      files[`--work--/2026-11-2${i}_bad-${i}.jsonl`] = longSession("litellm", "local-model", false);
      files[`--work--/2026-11-2${i}_good-${i}.jsonl`] = longSession("ollama", "glm-flash", true);
    }
    const flagged = uncachedModels(scanCacheReporting(sessionsDir(files)));
    assert.deepEqual(flagged, [{ model: "litellm/local-model", longSessions: MIN_LONG_SESSIONS }]);
  });

  it("says nothing with too few long sessions, about short ones, or when any call of the model reported a cache read", () => {
    const short = Array.from({ length: LONG_SESSION_CALLS }, () => call("p", "short", 50_000, 0)).join("\n");
    const small = Array.from({ length: LONG_SESSION_CALLS + 5 }, () => call("p", "small", 2_000, 0)).join("\n");
    const files: Record<string, string> = {};
    for (let i = 0; i < MIN_LONG_SESSIONS; i++) {
      files[`a/short-${i}.jsonl`] = short;
      files[`a/small-${i}.jsonl`] = small;
      files[`a/mixed-${i}.jsonl`] = longSession("p", "mixed", false);
    }
    for (let i = 0; i < MIN_LONG_SESSIONS - 1; i++) {
      files[`a/few-${i}.jsonl`] = longSession("p", "few", false);
    }
    // one cached call anywhere means the route reports the count
    files["a/mixed-cached.jsonl"] = call("p", "mixed", 100, 1_000);
    assert.deepEqual(uncachedModels(scanCacheReporting(sessionsDir(files))), []);
    assert.deepEqual(uncachedModels(scanCacheReporting(path.join(os.tmpdir(), "no-such-sessions-dir-311"))), [], "a missing directory is no sessions");
  });

  it("looks only at the sessions of the window", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < MIN_LONG_SESSIONS; i++) {
      files[`old-${i}.jsonl`] = longSession("litellm", "local-model", false);
    }
    const dir = sessionsDir(files);
    const later = Date.now() + 60 * 86_400_000;
    assert.deepEqual(uncachedModels(scanCacheReporting(dir, later)), []);
    assert.equal(uncachedModels(scanCacheReporting(dir)).length, 1);
  });
});
