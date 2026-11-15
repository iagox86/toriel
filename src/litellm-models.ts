// Ticket 215: pi's models.json hardcodes the metadata of the litellm routes (context window, max output, cost). When the model
// behind a route changes, that goes stale and pi's truncation and compaction run on wrong numbers. litellm itself publishes what it
// believes about each route (`/model/info`), so doctor compares the two and can rewrite the stale fields.
//
// Caveat, said in the finding too: litellm reports its OWN configured metadata for a route, not the backend's ground truth. If the
// route points at a server whose real context differs from litellm's config, this copies litellm's belief - still one source of
// truth instead of two.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./util.ts";

// Ticket 221 (follow-up): the same check for a Bifrost gateway (`GET /v1/models`, fields context_length / max_input_tokens /
// max_output_tokens, per its API reference). A provider in models.json is a gateway when its key says so ("litellm", "bifrost",
// "work-bifrost", ...); only those are ever asked, so a credential never goes to a provider toriel was not told is a gateway.

/** Which proxy a models.json provider is, and so how it is asked. */
export type GatewayKind = "litellm" | "bifrost";

/** The kind of gateway a provider key names, or undefined (an ordinary provider: never asked). */
export function gatewayKind(providerKey: string): GatewayKind | undefined {
  const k = providerKey.toLowerCase();
  return k.includes("litellm") ? "litellm" : k.includes("bifrost") ? "bifrost" : undefined;
}

/** What a gateway says about one route, in pi's units (cost in dollars per million tokens); a field it does not state is absent. */
export interface RouteInfo {
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

/** How doctor asks a gateway; tests inject, the CLI uses {@link probeLitellm}. A string is why it could not (unreachable, 401, odd reply). `kind` is litellm when absent. */
export type LitellmProbe = (target: { baseUrl: string; apiKey: string | undefined; kind?: GatewayKind }) => { routes: Record<string, RouteInfo> } | string;

export interface LitellmEntries {
  baseUrl: string;
  /** The `apiKey` as models.json spells it (a literal, an environment variable's name, or `!command`); never printed. */
  apiKey: string | undefined;
  /** The models.json `models` array as written. */
  models: Array<Record<string, unknown>>;
}

/** One gateway provider of models.json: its key, what it is, and what it holds. */
export interface GatewayEntries extends LitellmEntries {
  provider: string;
  kind: GatewayKind;
}

/** Every gateway provider of models.json that has a baseUrl and models (none when the file is missing or unreadable). */
export function readGateways(agentDir: string): GatewayEntries[] {
  try {
    const json = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8")) as { providers?: Record<string, unknown> };
    const out: GatewayEntries[] = [];
    for (const [provider, value] of Object.entries(json.providers ?? {})) {
      const kind = gatewayKind(provider);
      const p = value as { baseUrl?: unknown; apiKey?: unknown; models?: unknown } | undefined;
      if (kind === undefined || typeof p?.baseUrl !== "string" || !Array.isArray(p.models) || p.models.length === 0) {
        continue;
      }
      out.push({ provider, kind, baseUrl: p.baseUrl, apiKey: typeof p.apiKey === "string" ? p.apiKey : undefined, models: p.models.filter((m): m is Record<string, unknown> => typeof m === "object" && m !== null && typeof (m as { id?: unknown }).id === "string") });
    }
    return out;
  } catch {
    return [];
  }
}

/** The first litellm provider from models.json, or undefined when there is none (or no models, or the file cannot be read). */
export function readLitellmEntries(agentDir: string): LitellmEntries | undefined {
  const g = readGateways(agentDir).find((x) => x.kind === "litellm");
  return g === undefined ? undefined : { baseUrl: g.baseUrl, apiKey: g.apiKey, models: g.models };
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
/** Dollars per token -> dollars per million tokens, without float noise (0.0000025 -> 2.5). */
const perMillion = (v: unknown): number | undefined => {
  const n = num(v);
  return n === undefined ? undefined : Number((n * 1e6).toPrecision(10));
};

/** One `/model/info` row's `model_info` in pi's terms. */
export function routeInfo(modelInfo: Record<string, unknown> | undefined): RouteInfo {
  const m = modelInfo ?? {};
  const info: RouteInfo = {};
  const ctx = num(m.max_input_tokens) ?? num(m.max_tokens);
  const out = num(m.max_output_tokens) ?? num(m.max_tokens);
  if (ctx !== undefined && ctx > 0) {
    info.contextWindow = ctx;
  }
  if (out !== undefined && out > 0) {
    info.maxTokens = out;
  }
  const cost = { input: perMillion(m.input_cost_per_token), output: perMillion(m.output_cost_per_token), cacheRead: perMillion(m.cache_read_input_token_cost), cacheWrite: perMillion(m.cache_creation_input_token_cost) };
  if (Object.values(cost).some((v) => v !== undefined)) {
    info.cost = Object.fromEntries(Object.entries(cost).filter(([, v]) => v !== undefined));
  }
  return info;
}

/** A route's entry in models.json against what litellm says: the fields that differ (only ones litellm states), as [field, was, now]. */
export interface Drift {
  id: string;
  changes: Array<[field: string, was: unknown, now: unknown]>;
}

/** Entries whose stated metadata differs from litellm's, entries litellm does not serve, and routes litellm serves that models.json lacks. */
export function diffRoutes(models: ReadonlyArray<Record<string, unknown>>, routes: Record<string, RouteInfo>): { drift: Drift[]; gone: string[]; extra: string[] } {
  const drift: Drift[] = [];
  const gone: string[] = [];
  for (const m of models) {
    const id = m.id as string;
    const info = routes[id];
    if (info === undefined) {
      gone.push(id);
      continue;
    }
    const changes: Drift["changes"] = [];
    for (const field of ["contextWindow", "maxTokens"] as const) {
      if (info[field] !== undefined && m[field] !== info[field]) {
        changes.push([field, m[field], info[field]]);
      }
    }
    const was = (typeof m.cost === "object" && m.cost !== null ? m.cost : {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(info.cost ?? {})) {
      // an entry with no cost at all is free-by-omission; a stated 0 for a route litellm prices is still drift
      if (v !== undefined && (was[k] ?? 0) !== v) {
        changes.push([`cost.${k}`, was[k], v]);
      }
    }
    if (changes.length > 0) {
      drift.push({ id, changes });
    }
  }
  const have = new Set(models.map((m) => m.id as string));
  return { drift, gone, extra: Object.keys(routes).filter((id) => !have.has(id)) };
}

/** `models` with each drifted field set to litellm's value; everything else about an entry stays as written. */
export function applyDrift(models: ReadonlyArray<Record<string, unknown>>, drift: readonly Drift[]): Array<Record<string, unknown>> {
  const by = new Map(drift.map((d) => [d.id, d]));
  return models.map((m) => {
    const d = by.get(m.id as string);
    if (d === undefined) {
      return m;
    }
    const next: Record<string, unknown> = { ...m };
    for (const [field, , now] of d.changes) {
      if (field.startsWith("cost.")) {
        next.cost = { ...(typeof next.cost === "object" && next.cost !== null ? (next.cost as object) : {}), [field.slice(5)]: now };
      } else {
        next[field] = now;
      }
    }
    return next;
  });
}

/** The credential as pi reads it: `!command` is run, the name of a set environment variable is that variable, anything else is literal. Undefined when none. */
export function resolveApiKey(apiKey: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (apiKey === undefined || apiKey === "") {
    return undefined;
  }
  if (apiKey.startsWith("!")) {
    const r = spawnSync("sh", ["-c", apiKey.slice(1)], { encoding: "utf8", timeout: 5000, env });
    return r.status === 0 && r.stdout.trim() !== "" ? r.stdout.trim() : undefined;
  }
  return env[apiKey] ?? apiKey;
}

/** Runs in a child node so the doctor stays synchronous and the credential never appears on a command line (it travels in the environment). */
const FETCH_SCRIPT = `
const root = process.env.TORIEL_LITELLM_ROOT;
const path = process.env.TORIEL_LITELLM_PATH || "/model/info";
const headers = process.env.TORIEL_LITELLM_KEY ? { authorization: "Bearer " + process.env.TORIEL_LITELLM_KEY } : {};
const say = (v) => process.stdout.write(JSON.stringify(v));
try {
  const rows = [];
  let url = root + path;
  // bifrost pages its list (next_page_token); litellm answers in one go, so this loop runs once for it
  for (let page = 0; page < 20; page++) {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(4000) });
    if (!r.ok) { say({ error: "HTTP " + r.status }); process.exit(0); }
    const body = await r.json();
    if (!Array.isArray(body.data)) { say(body); process.exit(0); }
    rows.push(...body.data);
    if (!body.next_page_token) { break; }
    url = root + path + "?page_token=" + encodeURIComponent(body.next_page_token);
  }
  say({ data: rows });
} catch (e) { say({ error: String(e && e.message || e) }); }
`;

/** One row of bifrost's `/v1/models` in pi's terms. Cost is left out: its per-token strings have no stated unit, so it is not compared until checked against a live gateway. */
export function bifrostRouteInfo(row: Record<string, unknown>): RouteInfo {
  const info: RouteInfo = {};
  const ctx = num(row.context_length) ?? num(row.max_input_tokens);
  const out = num(row.max_output_tokens);
  if (ctx !== undefined && ctx > 0) {
    info.contextWindow = ctx;
  }
  if (out !== undefined && out > 0) {
    info.maxTokens = out;
  }
  return info;
}

/** The probe child's output as routes, or why not. */
function parseReply(stdout: string, kind: GatewayKind = "litellm"): { routes: Record<string, RouteInfo> } | string {
  const body = JSON.parse(stdout) as { error?: string; data?: Array<Record<string, unknown>> };
  if (typeof body.error === "string") {
    return body.error;
  }
  if (!Array.isArray(body.data)) {
    return "unexpected reply (no data list)";
  }
  const routes: Record<string, RouteInfo> = {};
  for (const row of body.data) {
    if (kind === "bifrost") {
      if (typeof row.id === "string") {
        routes[row.id] = bifrostRouteInfo(row);
      }
    } else if (typeof row.model_name === "string") {
      routes[row.model_name] = routeInfo(row.model_info as Record<string, unknown> | undefined);
    }
  }
  return { routes };
}

/** The gateway's address without the path pi's baseUrl carries: `/v1` for litellm; `/v1`, `/openai` or `/openai/v1` for bifrost. */
const rootOf = (baseUrl: string, kind: GatewayKind = "litellm"): string => baseUrl.replace(/\/+$/, "").replace(kind === "bifrost" ? /(\/openai)?(\/v1)?$/ : /\/v1$/, "");
const pathOf = (kind: GatewayKind = "litellm"): string => (kind === "bifrost" ? "/v1/models" : "/model/info");
const probeEnv = (root: string, key: string | undefined, kind: GatewayKind = "litellm"): NodeJS.ProcessEnv => ({ ...process.env, TORIEL_LITELLM_ROOT: root, TORIEL_LITELLM_PATH: pathOf(kind), ...(key !== undefined ? { TORIEL_LITELLM_KEY: key } : {}) });

/** Ask the gateway (once, a few seconds at most) what it believes about its routes. Never throws. */
export const probeLitellm: LitellmProbe = ({ baseUrl, apiKey, kind }) => {
  try {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", FETCH_SCRIPT], { encoding: "utf8", timeout: 8000, env: probeEnv(rootOf(baseUrl, kind), resolveApiKey(apiKey, process.env), kind) });
    return r.status !== 0 ? "the request did not finish" : parseReply(r.stdout, kind);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
};

/** Runs `command` and resolves its trimmed output, or undefined; never blocks the event loop. */
function runAsync(file: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      const child = spawn(file, args, { env, stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (d: string) => (out += d));
      const timer = setTimeout(() => child.kill(), timeoutMs);
      timer.unref();
      child.on("error", () => {
        clearTimeout(timer);
        resolve(undefined);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code === 0 ? out : undefined);
      });
    } catch {
      resolve(undefined);
    }
  });
}

/** The same question as {@link probeLitellm} without blocking the caller (the daemon asks at start, ticket 221), `!command` credentials included. Never rejects. */
export async function probeLitellmAsync({ baseUrl, apiKey, kind }: { baseUrl: string; apiKey: string | undefined; kind?: GatewayKind }): Promise<{ routes: Record<string, RouteInfo> } | string> {
  try {
    const key = apiKey?.startsWith("!") ? (await runAsync("sh", ["-c", apiKey.slice(1)], process.env, 5000))?.trim() || undefined : resolveApiKey(apiKey, process.env);
    const out = await runAsync(process.execPath, ["--input-type=module", "-e", FETCH_SCRIPT], probeEnv(rootOf(baseUrl, kind), key, kind), 8000);
    return out === undefined ? "the request did not finish" : parseReply(out, kind);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** What the daemon learned at start: per gateway provider, the routes it reported for the baseUrl asked. Never a credential. */
export interface RoutesCache {
  providers: Record<string, { checkedAt: number; baseUrl: string; routes: Record<string, RouteInfo> }>;
}

/** The cache (empty when there is none or it cannot be read). */
export function readRoutesCache(file: string | undefined): RoutesCache {
  const none: RoutesCache = { providers: {} };
  if (file === undefined) {
    return none;
  }
  try {
    const c = JSON.parse(readFileSync(file, "utf8")) as Partial<RoutesCache>;
    return typeof c.providers === "object" && c.providers !== null ? { providers: c.providers } : none;
  } catch {
    return none;
  }
}

/** What the daemon cached for this provider, when it asked the baseUrl models.json names now; undefined otherwise. */
export function cachedFor(cache: RoutesCache, provider: string, baseUrl: string): { checkedAt: number; routes: Record<string, RouteInfo> } | undefined {
  const c = cache.providers[provider];
  return c !== undefined && c.baseUrl === baseUrl && typeof c.checkedAt === "number" && typeof c.routes === "object" && c.routes !== null ? c : undefined;
}

type AsyncProbe = (t: { baseUrl: string; apiKey: string | undefined; kind?: GatewayKind }) => Promise<{ routes: Record<string, RouteInfo> } | string>;

/**
 * Ticket 221: ask each gateway (litellm, bifrost) once, off the event loop, and keep the answers in `cacheFile`, so the controller's
 * notice line and /doctor can compare them with models.json without a network call of their own (the comparison is redone against
 * the file as it is then, so a fix makes the finding go away). No gateway provider, an unreachable or unauthorised proxy, or an odd
 * reply leaves that provider's entry as it was (silent, like the CLI). True when the cache was written.
 */
export async function checkGatewaysAtStart(agentDir: string, cacheFile: string, probe: AsyncProbe = probeLitellmAsync, now = Date.now()): Promise<boolean> {
  const cache = readRoutesCache(cacheFile);
  let wrote = false;
  for (const g of readGateways(agentDir)) {
    const answer = await probe({ baseUrl: g.baseUrl, apiKey: g.apiKey, kind: g.kind });
    if (typeof answer !== "string") {
      cache.providers[g.provider] = { checkedAt: now, baseUrl: g.baseUrl, routes: answer.routes };
      wrote = true;
    }
  }
  if (!wrote) {
    return false;
  }
  try {
    writeFileAtomic(cacheFile, JSON.stringify(cache));
    return true;
  } catch {
    return false;
  }
}
