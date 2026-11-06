// Programmatic tool-call profiler for /performance: one pass over the full
// transcript text, producing compact mechanical stats the analysis model
// interprets instead of eyeballing the raw transcript. Pure: no fs, no I/O.
import { Buffer } from "node:buffer";

/** Per-model usage summed over the assistant messages of that provider/model. */
export interface ProfilerModelStats {
  model: string;
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

/** Per-tool figures summed over the toolResult messages named after the tool. */
export interface ProfilerToolStats {
  tool: string;
  calls: number;
  errors: number;
  /** Sum of the results' durationMs; undefined when no result carried one. */
  durationMs?: number;
  /** UTF-8 size of the results' text content. */
  outputBytes: number;
}

export interface ProfilerStats {
  entryCount: number;
  firstTimestamp?: string;
  lastTimestamp?: string;
  spanMs?: number;
  models: ProfilerModelStats[];
  /** `type: "usage"` entries (e.g. cache warming), counted separately from message usage. */
  usageEntries: number;
  tools: ProfilerToolStats[];
  biggestOutputs: { tool: string; bytes: number }[];
  repeatedPaths: { path: string; count: number }[];
  repeatedCommands: { command: string; count: number }[];
  /** Uncapped number of distinct exact command groups with repeats; the rendered list above is capped. */
  exactRepeatGroups: number;
  /** Set only when normalizing (digit runs, quoted substrings) finds more repeat groups than exact matching did. */
  normalizedCommandRepeats?: number;
  longestDurations: { tool: string; ms: number }[];
  /** Biggest gaps between consecutive assistant messages; `atEntry` is the later message's line index. */
  gaps: { ms: number; atEntry: number }[];
  compactionCount: number;
  lastCompactionTokensBefore?: number;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const bytesOf = (v: unknown): number => (typeof v === "string" ? Buffer.byteLength(v) : 0);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** One pass over the transcript text; malformed lines are skipped, as pi's own session loader does. */
export function profileTranscript(text: string): ProfilerStats {
  const lines = text.split(/\r?\n/);
  const stats: ProfilerStats = {
    entryCount: 0,
    models: [],
    usageEntries: 0,
    tools: [],
    biggestOutputs: [],
    repeatedPaths: [],
    repeatedCommands: [],
    exactRepeatGroups: 0,
    longestDurations: [],
    gaps: [],
    compactionCount: 0,
  };
  const modelTotals = new Map<string, ProfilerModelStats>();
  const toolTotals = new Map<string, ProfilerToolStats>();
  const pathCounts = new Map<string, number>();
  const commandCounts = new Map<string, number>();
  const normalizedCommandCounts = new Map<string, number>();
  // toolCall.id -> tool name; toolResult messages carry no arguments, so the
  // call's arguments (path, command) are joined in from the assistant message.
  const callNames = new Map<string, string>();
  const assistantMarks: { ts: number; entryIndex: number }[] = [];
  let firstTimestamp: string | undefined;
  let lastTimestamp: string | undefined;
  let lastCompactionTokensBefore: number | undefined;

  lines.forEach((line, entryIndex) => {
    if (line.trim() === "") {
      return;
    }
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      return; // malformed lines may exist; pi skips them too
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return;
    }
    const e = entry as Record<string, unknown>;
    stats.entryCount++;
    const timestamp = str(e.timestamp);
    if (timestamp !== undefined) {
      if (firstTimestamp === undefined) {
        firstTimestamp = timestamp;
      }
      lastTimestamp = timestamp;
    }
    if (e.type === "message") {
      const msg = e.message;
      if (typeof msg === "object" && msg !== null) {
        handleMessage(msg as Record<string, unknown>, entryIndex, modelTotals, toolTotals, pathCounts, commandCounts, normalizedCommandCounts, callNames, assistantMarks, stats);
      }
    } else if (e.type === "usage") {
      stats.usageEntries++;
    } else if (e.type === "compaction") {
      stats.compactionCount++;
      if (typeof e.tokensBefore === "number") {
        lastCompactionTokensBefore = e.tokensBefore;
      }
    }
  });

  stats.firstTimestamp = firstTimestamp;
  stats.lastTimestamp = lastTimestamp;
  if (firstTimestamp !== undefined && lastTimestamp !== undefined) {
    const from = Date.parse(firstTimestamp);
    const to = Date.parse(lastTimestamp);
    if (Number.isFinite(from) && Number.isFinite(to) && to >= from) {
      stats.spanMs = to - from;
    }
  }
  stats.models = [...modelTotals.values()];
  stats.tools = [...toolTotals.values()];
  stats.biggestOutputs = stats.biggestOutputs.sort((a, b) => b.bytes - a.bytes).slice(0, 5);
  stats.repeatedPaths = [...pathCounts.entries()]
    .map(([path, count]) => ({ path, count }))
    .filter((p) => p.count > 1)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  const exactAll = [...commandCounts.entries()]
    .map(([command, count]) => ({ command, count }))
    .filter((c) => c.count > 1)
    .sort((a, b) => b.count - a.count);
  stats.repeatedCommands = exactAll.slice(0, 5);
  stats.exactRepeatGroups = exactAll.length;
  const normalized = [...normalizedCommandCounts.entries()]
    .map(([command, count]) => ({ command, count }))
    .filter((c) => c.count > 1);
  // report the normalized view only when it finds more repeat groups than exact matching did
  if (normalized.length > exactAll.length) {
    stats.normalizedCommandRepeats = normalized.length;
  }
  stats.longestDurations = stats.longestDurations.sort((a, b) => b.ms - a.ms).slice(0, 3);
  const gaps = assistantMarks
    .map((mark, i) => (i === 0 ? undefined : { ms: mark.ts - assistantMarks[i - 1].ts, atEntry: mark.entryIndex }))
    .filter((g): g is { ms: number; atEntry: number } => g !== undefined && g.ms > 0)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 3);
  stats.gaps = gaps;
  stats.lastCompactionTokensBefore = lastCompactionTokensBefore;
  return stats;
}

function handleMessage(
  m: Record<string, unknown>,
  entryIndex: number,
  modelTotals: Map<string, ProfilerModelStats>,
  toolTotals: Map<string, ProfilerToolStats>,
  pathCounts: Map<string, number>,
  commandCounts: Map<string, number>,
  normalizedCommandCounts: Map<string, number>,
  callNames: Map<string, string>,
  assistantMarks: { ts: number; entryIndex: number }[],
  stats: ProfilerStats,
): void {
  if (m.role === "assistant") {
    const provider = str(m.provider) ?? "unknown";
    const model = str(m.model) ?? "unknown";
    const key = `${provider}/${model}`;
    let ms = modelTotals.get(key);
    if (ms === undefined) {
      ms = { model: key, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
      modelTotals.set(key, ms);
    }
    ms.requests++;
    const usage = m.usage;
    if (typeof usage === "object" && usage !== null) {
      const u = usage as Record<string, unknown>;
      ms.input += num(u.input);
      ms.output += num(u.output);
      ms.cacheRead += num(u.cacheRead);
      ms.cacheWrite += num(u.cacheWrite);
      ms.totalTokens += num(u.totalTokens);
      const cost = u.cost;
      ms.cost += typeof cost === "object" && cost !== null ? num((cost as Record<string, unknown>).total) : 0;
    }
    if (typeof m.timestamp === "number" && Number.isFinite(m.timestamp)) {
      assistantMarks.push({ ts: m.timestamp, entryIndex });
    }
    const content = m.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part !== "object" || part === null || (part as Record<string, unknown>).type !== "toolCall") {
          continue;
        }
        const call = part as Record<string, unknown>;
        const name = str(call.name) ?? "unknown";
        const id = str(call.id);
        if (id !== undefined) {
          callNames.set(id, name);
        }
        const args = call.arguments;
        if (typeof args === "object" && args !== null) {
          const a = args as Record<string, unknown>;
          // only reads count as repeated reads: an edit or write touching one file repeatedly is normal work
          const p = name === "read" ? str(a.path) : undefined;
          if (p !== undefined) {
            pathCounts.set(p, (pathCounts.get(p) ?? 0) + 1);
          }
          const command = name === "bash" ? str(a.command) : undefined;
          if (command !== undefined) {
            commandCounts.set(command, (commandCounts.get(command) ?? 0) + 1);
            const normalized = normalizeCommand(command);
            normalizedCommandCounts.set(normalized, (normalizedCommandCounts.get(normalized) ?? 0) + 1);
          }
        }
      }
    }
    return;
  }
  if (m.role !== "toolResult") {
    return;
  }
  const toolCallId = str(m.toolCallId);
  const name = str(m.toolName) ?? (toolCallId !== undefined ? callNames.get(toolCallId) : undefined) ?? "unknown";
  const t = toolTotals.get(name) ?? { tool: name, calls: 0, errors: 0, outputBytes: 0 };
  t.calls++;
  if (m.isError === true) {
    t.errors++;
  }
  let outputBytes = 0;
  const content = m.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === "object" && part !== null && (part as Record<string, unknown>).type === "text") {
        outputBytes += bytesOf((part as Record<string, unknown>).text);
      }
    }
  }
  t.outputBytes += outputBytes;
  if (outputBytes > 0) {
    stats.biggestOutputs.push({ tool: name, bytes: outputBytes });
  }
  const durationMs = typeof m.durationMs === "number" && Number.isFinite(m.durationMs) ? m.durationMs : undefined;
  if (durationMs !== undefined) {
    t.durationMs = (t.durationMs ?? 0) + durationMs;
    stats.longestDurations.push({ tool: name, ms: durationMs });
  }
  toolTotals.set(name, t);
}

/** Collapse digit runs and quoted substrings, so "build 12" and "build 99" count as the same command. */
function normalizeCommand(command: string): string {
  return command.replace(/'[^']*'|"[^"]*"|\d+/g, (match) => (/^\d/.test(match) ? "N" : "S"));
}

/** One line, at most ~160 chars: long paths and shell commands must not break the block's small size. */
function short(value: string): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > 160 ? `${oneLine.slice(0, 157)}...` : oneLine;
}

/**
 * Compact markdown for the stats; the model, not a human, reads it. Every list
 * is capped so the block stays small even for a big session; a section header
 * says how many groups existed when the cap cut some away.
 */
export function renderProfilerStats(stats: ProfilerStats): string {
  const out: string[] = ["## Transcript stats"];
  out.push(
    `- span: ${stats.firstTimestamp ?? "n/a"} .. ${stats.lastTimestamp ?? "n/a"}${stats.spanMs !== undefined ? ` (${stats.spanMs} ms)` : ""} across ${stats.entryCount} entries`,
  );
  const models = [...stats.models].sort((a, b) => b.cost - a.cost);
  out.push(stats.models.length > 5 ? `- models (${stats.models.length} total, top 5 by cost):` : "- models:");
  for (const m of models.slice(0, 5)) {
    out.push(`  - ${m.model}: ${m.requests} requests, input ${m.input}, output ${m.output}, cacheRead ${m.cacheRead}, cacheWrite ${m.cacheWrite}, ${m.totalTokens} total tokens, cost ${m.cost.toFixed(4)}`);
  }
  const cacheRead = stats.models.reduce((sum, m) => sum + m.cacheRead, 0);
  const fresh = stats.models.reduce((sum, m) => sum + m.input + m.cacheWrite, 0);
  out.push(`- cache: cacheRead ${cacheRead} vs input+cacheWrite ${fresh} (${fresh > 0 ? `${(cacheRead / fresh).toFixed(1)}:1` : "n/a"})`);
  if (stats.usageEntries > 0) {
    out.push(`- usage entries (e.g. cache warming): ${stats.usageEntries}`);
  }
  const tools = [...stats.tools].sort((a, b) => b.outputBytes - a.outputBytes || b.calls - a.calls);
  out.push(stats.tools.length > 5 ? `- tools (${stats.tools.length} total, top 5 by output):` : "- tools:");
  for (const t of tools.slice(0, 5)) {
    out.push(`  - ${t.tool}: ${t.calls} calls, ${t.errors} errors, ${t.durationMs !== undefined ? `${t.durationMs} ms` : "n/a"}, ${t.outputBytes} bytes output`);
  }
  out.push("- biggest tool outputs:");
  for (const b of stats.biggestOutputs.slice(0, 5)) {
    out.push(`  - ${b.tool}: ${b.bytes} bytes`);
  }
  out.push("- repeated file reads:");
  for (const p of stats.repeatedPaths.slice(0, 5)) {
    out.push(`  - ${short(p.path)} x${p.count}`);
  }
  out.push("- repeated shell commands:");
  for (const c of stats.repeatedCommands.slice(0, 5)) {
    out.push(`  - \`${short(c.command)}\` x${c.count}`);
  }
  if (stats.normalizedCommandRepeats !== undefined) {
    out.push(`  - normalized commands: ${stats.normalizedCommandRepeats} repeat groups once digits and quotes are collapsed (${stats.exactRepeatGroups} exact)`);
  }
  out.push("- longest tool durations:");
  for (const d of stats.longestDurations.slice(0, 3)) {
    out.push(`  - ${d.tool}: ${d.ms} ms`);
  }
  out.push("- biggest gaps between assistant messages:");
  for (const g of stats.gaps.slice(0, 3)) {
    out.push(`  - ${g.ms} ms before entry ${g.atEntry}`);
  }
  out.push(stats.compactionCount > 0 ? `- compactions: ${stats.compactionCount} (last had ${stats.lastCompactionTokensBefore ?? "n/a"} tokens before)` : "- compactions: none");
  return out.join("\n");
}
