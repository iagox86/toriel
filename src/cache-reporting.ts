// Models whose calls never report a cache read (ticket 311). The cost, toriel_usage and the subagent budgets count fresh tokens
// (input + output), so a route that drops the provider's cached-token count makes every call look like it re-read the whole
// context: a budget then runs out tens of times too early. A litellm `ollama_chat/` route to Ollama did exactly that (it drops
// `prompt_eval_cached_count`); the server cached, the numbers said it did not. The doctor flags such a model from pi's own session
// files: enough long sessions on it, and not one call with `cacheRead > 0`.
import { MAX_FILES, readHead, sessionFiles, USAGE_WINDOW_DAYS } from "./mcp-usage.ts";

/** A session counts as long for a model with more calls than this on it... */
export const LONG_SESSION_CALLS = 10;
/** ...and at least one call whose context (input plus cache reads) passed this many tokens: a prompt cache matters there. */
export const LONG_SESSION_CONTEXT = 20_000;
/** Fewer long sessions than this say too little to flag a model. */
export const MIN_LONG_SESSIONS = 3;

/** One model's calls in one session file. */
export interface ModelCalls {
  calls: number;
  /** The largest context of one call: input plus cache reads. */
  maxContext: number;
  /** Calls that reported a cache read. */
  cached: number;
}

/** Per `provider/model`, what one session file's assistant messages reported. */
export function sessionCacheUse(text: string): Map<string, ModelCalls> {
  const out = new Map<string, ModelCalls>();
  for (const line of text.split("\n")) {
    // only assistant messages carry usage; the cheap test skips the rest without parsing them
    if (!line.includes('"assistant"') || !line.includes('"usage"')) {
      continue;
    }
    let entry: { type?: string; message?: { role?: string; provider?: unknown; model?: unknown; usage?: { input?: unknown; cacheRead?: unknown } } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const m = entry.message;
    if (entry.type !== "message" || m?.role !== "assistant" || typeof m.usage !== "object" || m.usage === null) {
      continue;
    }
    if (typeof m.provider !== "string" || typeof m.model !== "string") {
      continue;
    }
    const input = typeof m.usage.input === "number" ? m.usage.input : 0;
    const cacheRead = typeof m.usage.cacheRead === "number" ? m.usage.cacheRead : 0;
    const key = `${m.provider}/${m.model}`;
    const one = out.get(key) ?? { calls: 0, maxContext: 0, cached: 0 };
    one.calls++;
    one.maxContext = Math.max(one.maxContext, input + cacheRead);
    if (cacheRead > 0) {
      one.cached++;
    }
    out.set(key, one);
  }
  return out;
}

/** Per `provider/model`, over the window: the long sessions on it, and the calls of any session that reported a cache read. */
export interface CacheReport {
  byModel: Record<string, { longSessions: number; cachedCalls: number }>;
}

/** Add one session file's numbers to the report. */
export function addSession(report: CacheReport, use: Map<string, ModelCalls>): void {
  for (const [model, one] of use) {
    const r = report.byModel[model] ?? { longSessions: 0, cachedCalls: 0 };
    if (one.calls > LONG_SESSION_CALLS && one.maxContext > LONG_SESSION_CONTEXT) {
      r.longSessions++;
    }
    r.cachedCalls += one.cached;
    report.byModel[model] = r;
  }
}

/** Scan pi's session directory (the last USAGE_WINDOW_DAYS days, newest MAX_FILES files, each read up to its capped head). Never throws: an unreadable file is skipped. */
export function scanCacheReporting(sessionsDir: string, now = Date.now()): CacheReport {
  const report: CacheReport = { byModel: {} };
  for (const file of sessionFiles(sessionsDir, now - USAGE_WINDOW_DAYS * 86_400_000).slice(0, MAX_FILES)) {
    const text = readHead(file);
    if (text !== undefined) {
      addSession(report, sessionCacheUse(text));
    }
  }
  return report;
}

/** The models with at least MIN_LONG_SESSIONS long sessions and not one call that reported a cache read, with their long-session count. */
export function uncachedModels(report: CacheReport): Array<{ model: string; longSessions: number }> {
  return Object.entries(report.byModel)
    .filter(([, r]) => r.longSessions >= MIN_LONG_SESSIONS && r.cachedCalls === 0)
    .map(([model, r]) => ({ model, longSessions: r.longSessions }))
    .sort((a, b) => a.model.localeCompare(b.model));
}
