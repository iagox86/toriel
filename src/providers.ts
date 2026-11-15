// Setting up model providers without editing JSON (ticket 12): `/provider add|list|remove` and `/login <provider>`. The providers are
// pi's: `providers` in ~/.pi/agent/models.json, where a provider's `apiKey` is a literal, "$NAME" (an environment variable) or "!command".
// This is the file half: reading what is there, the edits, and asking an OpenAI-compatible endpoint what models it serves. Every edit
// keeps the original as models.json.bak-<time> and keeps the file owner-only. A key is never returned, logged or put in an error.
import * as fs from "node:fs";
import * as path from "node:path";
import { backupPath } from "./doctor.ts";
import { errText, writeJsonAtomic } from "./util.ts";

/** The APIs pi's models.json accepts for a custom provider that matter for an endpoint someone adds by hand. */
export const PROVIDER_APIS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as const;
export const DEFAULT_API = "openai-completions";

const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** More than this many served models are not written: a gateway that serves hundreds is better trimmed by hand. */
export const MAX_MODELS = 200;

/** What /provider add was given besides the name and URL. */
export interface ProviderOptions {
  /** --key-env VAR */
  keyEnv?: string;
  /** --no-key */
  noKey: boolean;
  /** --no-models */
  noModels: boolean;
  /** --api */
  api?: string;
}

export type KeyKind ="literal" | "env" | "command" | "none";

/** How an `apiKey` is spelled, without looking at the key itself beyond its first character. */
export function keyKind(apiKey: unknown): KeyKind {
  if (typeof apiKey !== "string" || apiKey === "") {
    return "none";
  }
  return apiKey.startsWith("!") ? "command" : apiKey.startsWith("$") ? "env" : "literal";
}

export interface ProviderRow {
  id: string;
  baseUrl?: string;
  api?: string;
  key: KeyKind;
  /** For an environment variable key, its name (not a secret). */
  keyEnv?: string;
  models: number;
}

type ModelsFile = { providers?: Record<string, Record<string, unknown>> } & Record<string, unknown>;

export function modelsFile(agentDir: string): string {
  return path.join(agentDir, "models.json");
}

function readModels(file: string): ModelsFile {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw new Error(`${file} could not be read (${errText(err)})`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${errText(err)}); fix it by hand first`);
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new Error(`${file} must hold a JSON object; fix it by hand first`);
  }
  const providers = (json as ModelsFile).providers;
  if (providers !== undefined && (typeof providers !== "object" || providers === null || Array.isArray(providers))) {
    throw new Error(`${file}: "providers" must be an object; fix it by hand first`);
  }
  return json as ModelsFile;
}

/** Write `data` as models.json, the original (if any) kept as models.json.bak-<time>. Returns the backup's path. */
function save(file: string, data: ModelsFile, now: Date): string | undefined {
  let backup: string | undefined;
  let mode = 0o600;
  if (fs.existsSync(file)) {
    backup = backupPath(file, now);
    fs.copyFileSync(file, backup);
    mode = fs.statSync(file).mode & 0o777;
  }
  writeJsonAtomic(file, data, mode);
  return backup;
}

/** Every provider of models.json, for the list; a missing file is none. Throws (with a message that names the file) when it cannot be used. */
export function listProviders(agentDir: string): ProviderRow[] {
  const providers = readModels(modelsFile(agentDir)).providers ?? {};
  return Object.entries(providers).map(([id, p]) => {
    const kind = keyKind(p.apiKey);
    return {
      id,
      baseUrl: typeof p.baseUrl === "string" ? p.baseUrl : undefined,
      api: typeof p.api === "string" ? p.api : undefined,
      key: kind,
      keyEnv: kind === "env" ? (p.apiKey as string).replace(/^\$\{?|\}$/g, "") : undefined,
      models: Array.isArray(p.models) ? p.models.length : 0,
    };
  });
}

/** What `apiKey` holds for a key the user gave: "$NAME" for an environment variable, the text itself otherwise. */
export function apiKeyValue(key: { env: string } | { literal: string }): string {
  if ("env" in key) {
    if (!ENV_NAME.test(key.env)) {
      throw new Error(`"${key.env}" is not an environment variable name (letters, digits and _)`);
    }
    return `$${key.env}`;
  }
  const literal = key.literal.trim();
  if (literal === "" || /\s/.test(literal)) {
    throw new Error("an API key is one word with no spaces or line breaks");
  }
  return literal;
}

export function checkProviderId(id: string): void {
  if (!PROVIDER_ID.test(id)) {
    throw new Error(`provider name "${id}" must be letters, digits, "_", "." or "-"`);
  }
}

/** One model of a new provider, as models.json spells it. */
export interface NewModel {
  id: string;
  contextWindow?: number;
  maxTokens?: number;
  /** Dollars per million tokens, as a litellm proxy states them; pi wants all four, so the ones it does not state are 0. */
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

export interface NewProvider {
  id: string;
  baseUrl: string;
  api: string;
  /** The `apiKey` value as models.json holds it (see {@link apiKeyValue}); undefined for an endpoint that takes none. */
  apiKey?: string;
  models: NewModel[];
}

/** Add a provider. Refuses an id that is already there (/login changes a key; remove first to replace a provider). Returns the backup's path. */
export function addProvider(agentDir: string, p: NewProvider, now: Date = new Date()): string | undefined {
  checkProviderId(p.id);
  if (!/^https?:\/\/[^\s/]+/i.test(p.baseUrl)) {
    throw new Error("the base URL must be an http(s) URL");
  }
  if (!(PROVIDER_APIS as readonly string[]).includes(p.api)) {
    throw new Error(`the api must be one of ${PROVIDER_APIS.join(", ")}`);
  }
  const file = modelsFile(agentDir);
  const data = readModels(file);
  data.providers ??= {};
  const providers = data.providers;
  if (p.id in providers) {
    throw new Error(`provider "${p.id}" is already in ${file} (/login ${p.id} changes its key; /provider remove ${p.id} first to replace it)`);
  }
  providers[p.id] = {
    baseUrl: p.baseUrl.replace(/\/+$/, ""),
    api: p.api,
    ...(p.apiKey !== undefined ? { apiKey: p.apiKey } : {}),
    models: p.models.slice(0, MAX_MODELS).map((m) => ({
      id: m.id,
      ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
      ...(m.maxTokens !== undefined ? { maxTokens: m.maxTokens } : {}),
      ...(m.cost !== undefined ? { cost: { input: m.cost.input ?? 0, output: m.cost.output ?? 0, cacheRead: m.cost.cacheRead ?? 0, cacheWrite: m.cost.cacheWrite ?? 0 } } : {}),
    })),
  };
  return save(file, data, now);
}

/** Set a provider's `apiKey` (`/login`). A provider that is not in the file is created as just that key, which is how a built-in provider (anthropic, openai, ...) is given one. Returns the backup's path. */
export function setProviderKey(agentDir: string, id: string, apiKey: string, now: Date = new Date()): { backup: string | undefined; created: boolean } {
  checkProviderId(id);
  const file = modelsFile(agentDir);
  const data = readModels(file);
  data.providers ??= {};
  const providers = data.providers;
  const created = !(id in providers);
  providers[id] = { ...(providers[id] ?? {}), apiKey };
  return { backup: save(file, data, now), created };
}

/** Remove a provider from models.json (its stored login in auth.json is not touched). Returns the backup's path. */
export function removeProvider(agentDir: string, id: string, now: Date = new Date()): string | undefined {
  const file = modelsFile(agentDir);
  const data = readModels(file);
  if (data.providers === undefined || !(id in data.providers)) {
    throw new Error(`"${id}" is not in the providers of ${file}`);
  }
  delete data.providers[id];
  return save(file, data, now);
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined);

/** The models of an OpenAI-style `GET <base>/models` reply, with the sizes a gateway states (context_length / max_input_tokens, max_output_tokens). Ids with odd characters are skipped. */
export function parseModelList(body: unknown): NewModel[] {
  const data = (body as { data?: unknown } | undefined)?.data;
  if (!Array.isArray(data)) {
    return [];
  }
  const out: NewModel[] = [];
  const seen = new Set<string>();
  for (const row of data as Array<Record<string, unknown>>) {
    const id = row?.id;
    if (typeof id !== "string" || id === "" || id.length > 200 || /[\s\u0000-\u001f]/.test(id) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const contextWindow = num(row.context_length) ?? num(row.max_input_tokens) ?? num(row.context_window);
    const maxTokens = num(row.max_output_tokens) ?? num(row.max_completion_tokens);
    out.push({ id, ...(contextWindow !== undefined ? { contextWindow } : {}), ...(maxTokens !== undefined ? { maxTokens } : {}) });
  }
  return out;
}

/**
 * Ask an OpenAI-compatible endpoint what it serves: `GET <baseUrl>/models`, the key (when there is one) as a Bearer token. Resolves to the
 * models, or a string saying why not (unreachable, refused, not a model list). Never throws, and never includes the key in the text.
 */
export async function fetchModels(baseUrl: string, apiKey: string | undefined, fetchImpl: typeof fetch = fetch, timeoutMs = 10_000): Promise<NewModel[] | string> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  try {
    const res = await fetchImpl(url, { headers: apiKey === undefined ? {} : { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 401 || res.status === 403) {
      return `${new URL(url).host} refused the key (${res.status})`;
    }
    if (!res.ok) {
      return `${new URL(url).host} answered ${res.status} for /models`;
    }
    const models = parseModelList(await res.json());
    return models.length > 0 ? models : `${new URL(url).host} answered, but its /models reply lists no models`;
  } catch (err) {
    return `could not ask ${new URL(url).host}: ${errText(err).replace(/Bearer\s+\S+/gi, "Bearer ***")}`;
  }
}

/** The key as the wizard needs it to ask the endpoint: a literal as is, "$NAME" from the environment; undefined for "!command" or an unset variable (then the endpoint is asked without one). */
export function resolveForProbe(apiKey: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  switch (keyKind(apiKey)) {
    case "literal":
      return apiKey;
    case "env":
      return env[(apiKey as string).replace(/^\$\{?|\}$/g, "")];
    default:
      return undefined;
  }
}
