// Pure: resolve what the user typed after /model to one of pi's available models.

export interface ModelRef {
  provider: string;
  id: string;
}

export type ModelMatch =
  | { kind: "one"; model: ModelRef }
  | { kind: "many"; matches: ModelRef[] }
  | { kind: "none" };

export const modelName = (m: ModelRef): string => `${m.provider}/${m.id}`;

/**
 * An exact "provider/id" (or bare id, if unambiguous) wins; otherwise every
 * whitespace-separated word must appear in "provider/id", case-insensitively.
 */
export function matchModel(models: readonly ModelRef[], query: string): ModelMatch {
  const q = query.trim().toLowerCase();
  if (q === "") {
    return { kind: "none" };
  }
  const exact = models.filter((m) => modelName(m).toLowerCase() === q);
  const byId = models.filter((m) => m.id.toLowerCase() === q);
  const pick = exact.length > 0 ? exact : byId;
  if (pick.length === 1) {
    return { kind: "one", model: pick[0] };
  }
  const words = q.split(/\s+/);
  const matches = models.filter((m) => words.every((w) => modelName(m).toLowerCase().includes(w)));
  if (matches.length === 1) {
    return { kind: "one", model: matches[0] };
  }
  return matches.length === 0 ? { kind: "none" } : { kind: "many", matches };
}

/**
 * Why `wanted` ("provider/id") is not one of `models`, with the closest ones named so the caller can fix
 * it; undefined when it is. A fork keeps its parent's model, so this is only for fresh sessions.
 */
export function modelProblem(models: readonly ModelRef[], wanted: string): string | undefined {
  if (models.some((m) => modelName(m) === wanted)) {
    return undefined;
  }
  const idPart = wanted.includes("/") ? wanted.slice(wanted.indexOf("/") + 1) : wanted;
  const typos = models
    .map((m) => ({ m, d: Math.min(editDistance(modelName(m), wanted), editDistance(m.id, idPart)) }))
    .filter((x) => x.d <= 3)
    .sort((a, b) => a.d - b.d)
    .map((x) => x.m);
  const near = [...matchesOf(models, wanted), ...matchesOf(models, idPart), ...typos].filter((m, i, all) => all.findIndex((x) => modelName(x) === modelName(m)) === i);
  const hint =
    near.length > 0
      ? `did you mean ${near.slice(0, 6).map(modelName).join(", ")}${near.length > 6 ? `, ... (${near.length - 6} more)` : ""}?`
      : `pi has ${models.length} model${models.length === 1 ? "" : "s"}, from ${[...new Set(models.map((m) => m.provider))].join(", ") || "no provider"}`;
  return `no model "${wanted}" (${hint})`;
}

function matchesOf(models: readonly ModelRef[], query: string): ModelRef[] {
  const m = matchModel(models, query);
  return m.kind === "one" ? [m.model] : m.kind === "many" ? m.matches : [];
}

/** Levenshtein distance, for "did you mean" on a mistyped model name. */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min((prev[j] as number) + 1, (row[j - 1] as number) + 1, (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length] as number;
}
