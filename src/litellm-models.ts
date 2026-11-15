// Ticket 215: pi's models.json hardcodes the metadata of the litellm routes (context window, max output, cost). When the model
// behind a route changes, that goes stale and pi's truncation and compaction run on wrong numbers. litellm itself publishes what it
// believes about each route (`/model/info`), so doctor compares the two and can rewrite the stale fields.
//
// Caveat, said in the finding too: litellm reports its OWN configured metadata for a route, not the backend's ground truth. If the
// route points at a server whose real context differs from litellm's config, this copies litellm's belief - still one source of
// truth instead of two.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The provider this check looks at: pi's models.json `providers` key for the litellm proxy. */
export const LITELLM_PROVIDER = "litellm";

/** What litellm says about one route, in pi's units (cost in dollars per million tokens); a field it does not state is absent. */
export interface RouteInfo {
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

/** How doctor asks litellm; tests inject, the CLI uses {@link probeLitellm}. A string is why it could not (unreachable, 401, odd reply). */
export type LitellmProbe = (target: { baseUrl: string; apiKey: string | undefined }) => { routes: Record<string, RouteInfo> } | string;

export interface LitellmEntries {
  baseUrl: string;
  /** The `apiKey` as models.json spells it (a literal, an environment variable's name, or `!command`); never printed. */
  apiKey: string | undefined;
  /** The models.json `models` array as written. */
  models: Array<Record<string, unknown>>;
}

/** The litellm provider from models.json, or undefined when there is none (or no models, or the file cannot be read). */
export function readLitellmEntries(agentDir: string): LitellmEntries | undefined {
  try {
    const json = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8")) as { providers?: Record<string, unknown> };
    const p = json.providers?.[LITELLM_PROVIDER] as { baseUrl?: unknown; apiKey?: unknown; models?: unknown } | undefined;
    if (typeof p?.baseUrl !== "string" || !Array.isArray(p.models) || p.models.length === 0) {
      return undefined;
    }
    return { baseUrl: p.baseUrl, apiKey: typeof p.apiKey === "string" ? p.apiKey : undefined, models: p.models.filter((m): m is Record<string, unknown> => typeof m === "object" && m !== null && typeof (m as { id?: unknown }).id === "string") };
  } catch {
    return undefined;
  }
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
const headers = process.env.TORIEL_LITELLM_KEY ? { authorization: "Bearer " + process.env.TORIEL_LITELLM_KEY } : {};
try {
  const r = await fetch(root + "/model/info", { headers, signal: AbortSignal.timeout(4000) });
  if (!r.ok) { process.stdout.write(JSON.stringify({ error: "HTTP " + r.status })); }
  else { process.stdout.write(JSON.stringify(await r.json())); }
} catch (e) { process.stdout.write(JSON.stringify({ error: String(e && e.message || e) })); }
`;

/** Ask the litellm proxy (once, a few seconds at most) what it believes about its routes. Never throws. */
export const probeLitellm: LitellmProbe = ({ baseUrl, apiKey }) => {
  try {
    const root = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
    const key = resolveApiKey(apiKey, process.env);
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", FETCH_SCRIPT], { encoding: "utf8", timeout: 8000, env: { ...process.env, TORIEL_LITELLM_ROOT: root, ...(key !== undefined ? { TORIEL_LITELLM_KEY: key } : {}) } });
    if (r.status !== 0) {
      return "the request did not finish";
    }
    const body = JSON.parse(r.stdout) as { error?: string; data?: Array<{ model_name?: unknown; model_info?: Record<string, unknown> }> };
    if (typeof body.error === "string") {
      return body.error;
    }
    if (!Array.isArray(body.data)) {
      return "unexpected reply (no data list)";
    }
    const routes: Record<string, RouteInfo> = {};
    for (const row of body.data) {
      if (typeof row.model_name === "string") {
        routes[row.model_name] = routeInfo(row.model_info);
      }
    }
    return { routes };
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
};
