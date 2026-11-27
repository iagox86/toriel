// toriel MCP (tickets 209 and 216): toriel owns the MCP config. The servers live in toriel's mcp.yaml (the daemon passes its path in
// TORIEL_MCP_FILE) and this extension registers them into pi with pi.registerMcpServer at session start; pi's own mcp.json is not
// used. pi then connects, declares and reports them like any other server (/mcp, exposure, sign-in all work).
//
// An entry with no `exposure` is registered `deferred` (ticket 298): its tools are declared only once tool_search loads them, so a
// server costs nothing per call until it is used. The servers an agent profile names are registered `direct` in that session
// (TORIEL_MCP_DIRECT, set by the daemon), since the profile's prompt expects their tools at once.
//
// A server marked `whenUp: true` (an app's bridge that exists only while the app runs) is registered only when something listens at
// its URL at that moment, so a server that is down on purpose costs a few milliseconds and no warning. `/mcp-up` looks again, for
// the app that was started after the session was.
//
// A server whose tools are not declared is registered with the summary an earlier session saw (ticket 303; the file in
// TORIEL_MCP_SUMMARIES), so the system prompt's server list does not change when the server connects. The end of each run records
// the connected servers' summaries for the next session.
//
// When a run settles (pi's agent_settled, once per run, whatever ended it) the extension also stamps /mcp
// explore records (ticket 308; the file in TORIEL_MCP_RECORDS): the hash of every connected server's tools as
// it is now - seeing the tools is unconditional - stamped with the session start as the sighting time; and,
// when the run was opened by an /mcp explore prompt and completed (the last agent_before_settle boundary said
// "completed" - one can fire more than once per run when an extension continues it, so the last one counts),
// the servers it names stamped with that hash and the settle time, as the skill's write time -- so a later
// reader can tell when a server's skill was last written and whether its tools changed since.
import * as fs from "node:fs";
import * as path from "node:path";
import { canonicalize, computeToolHashes, explorePromptServerNames, learnSummaries, loadExploreRecords, MCP_DIRECT_ENV, MCP_FILE_ENV, MCP_RECORDS_ENV, MCP_SUMMARIES_ENV, type McpServerConfig, mergeExploreRecords, parseDirectServers, parseMcpYaml, piConfig, probeUrl, redactUrl, saveExploreRecords, summaryLine, type ToolNamespaceInfo, toolServerName } from "./lib/mcp-config.ts";

// Only the slice of pi's extension API this file uses (see toriel-usage.ts).
interface Ctx {
  ui?: { notify?(message: string, type?: "info" | "warning" | "error"): void };
}
/** How a settled run ended (pi's AgentActivityOutcome). */
type RunOutcome = "completed" | "aborted" | "error";
interface Pi {
  on(event: "session_start" | "agent_end" | "before_agent_start" | "agent_before_settle" | "agent_settled", handler: (event: unknown, ctx: Ctx) => unknown): unknown;
  getAllTools?(): ToolNamespaceInfo[];
  getActiveTools?(): string[];
  registerMcpServer?(name: string, config: Record<string, unknown>): void;
  getMcpServers?(): Array<{ name: string }>;
  registerCommand?(name: string, options: { description: string; handler: (args: string, ctx: Ctx) => Promise<void> | void }): void;
}

/**
 * How to load MCP tools cheaply (ticket 305). Every tool_search load changes the declared tools, which sit at the top of the prompt,
 * so the next call re-sends the whole conversation uncached; sessions were seen loading four to six times, eight tools at a time.
 */
export const TOOL_SEARCH_GUIDELINE =
  "tool_search: every load changes your declared tools, which makes the next request re-send the whole conversation without the prompt cache. So load all the MCP tools a task needs in one tool_search call, as early as you can, rather than one at a time as you go; name the tools in the query when you know them (a skill may list them) and set limit to how many you want.";

/** Add the guideline to a run's prompt options when tool_search is among the session's tools. Never throws. */
export function addToolSearchGuideline(event: unknown, active: readonly string[]): void {
  try {
    const options = (event as { systemPromptOptions?: { promptGuidelines?: string[] } } | undefined)?.systemPromptOptions;
    if (active.includes("tool_search") && Array.isArray(options?.promptGuidelines) && !options.promptGuidelines.includes(TOOL_SEARCH_GUIDELINE)) {
      options.promptGuidelines.push(TOOL_SEARCH_GUIDELINE);
    }
  } catch {
    // a missing guideline costs only cache misses
  }
}

/** Name of the command that looks again. */
export const UP_COMMAND = "mcp-up";

/** What one pass did, per server: registered now, already registered, not reachable, or switched off. */
export type Outcome = "registered" | "already" | "down" | "failed";

/** The servers of the file, with the problems it had; a missing or unreadable file is no servers (the doctor reports it). */
export function loadServers(file: string | undefined): { servers: Record<string, McpServerConfig>; problems: string[] } {
  if (!file) {
    return { servers: {}, problems: [] };
  }
  try {
    return parseMcpYaml(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? { servers: {}, problems: [] } : { servers: {}, problems: [`${file} could not be read: ${(err as Error).message}`] };
  }
}

/**
 * Register each server that is not registered yet: plain servers always, `whenUp` ones only when they answer at their URL. `probe` is
 * injected for tests. Never throws: a failure to register counts as failed, so a broken entry cannot stop a session from starting.
 * `only` limits the pass to one server.
 */
export async function reconcile(
  pi: Pick<Pi, "registerMcpServer" | "getMcpServers">,
  servers: Record<string, McpServerConfig>,
  probe: (url: string) => Promise<boolean> = probeUrl,
  only?: string,
  direct: ReadonlySet<string> = parseDirectServers(process.env[MCP_DIRECT_ENV]),
  summaries: Readonly<Record<string, string>> = {},
): Promise<Record<string, Outcome>> {
  const have = new Set((pi.getMcpServers?.() ?? []).map((s) => s.name));
  const names = Object.keys(servers).filter((n) => only === undefined || n === only);
  const outcomes = await Promise.all(
    names.map(async (name): Promise<[string, Outcome]> => {
      const entry = servers[name] as McpServerConfig;
      if (have.has(name)) {
        return [name, "already"];
      }
      if (entry.whenUp === true && entry.enabled !== false && !(await probe(entry.url as string))) {
        return [name, "down"];
      }
      try {
        pi.registerMcpServer?.(name, piConfig(entry, { direct: direct.has(toolServerName(name)), summary: summaries[name] }));
        return [name, "registered"];
      } catch {
        return [name, "failed"];
      }
    }),
  );
  return Object.fromEntries(outcomes);
}

/** The remembered summaries (ticket 303). Every value is lined again on load (first line, trimmed, capped) and empty ones dropped, so a stale or hand-edited value cannot carry newlines or oversize text into the system prompt. A missing, unreadable or malformed file is none, so the worst case is the old behavior. */
export function loadSummaries(file: string | undefined): Record<string, string> {
  if (!file) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed)
        .filter((e): e is [string, string] => typeof e[1] === "string")
        .map(([name, text]) => [name, summaryLine(text)])
        .filter((e) => e[1].length > 0),
    );
  } catch {
    return {};
  }
}

/** Write the summaries atomically: several sessions may end a run at once, and a rename never leaves a half-written file. */
export function saveSummaries(file: string, summaries: Record<string, string>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(summaries, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** Record the summaries of the servers connected now, when they differ from the file's. Never throws: a lost summary only means the next session's server list changes once. A load that reported problems saw only part of mcp.yaml (or none of it), so the summaries its pruning would drop are kept: a broken edit must not wipe the file. */
export function recordSummaries(file: string, mcpFile: string, tools: readonly ToolNamespaceInfo[]): void {
  try {
    const { servers, problems } = loadServers(mcpFile);
    const next = learnSummaries(loadSummaries(file), tools, servers, { skipPrune: problems.length > 0 });
    if (next) {
      saveSummaries(file, next);
    }
  } catch {
    // see above
  }
}

/** The server names the run's opening prompt asks to explore (ticket 308), or undefined when the run was not opened by an /mcp explore prompt. Never throws. */
export function explorePromptServers(event: unknown): string[] | undefined {
  try {
    if ((event as { messageType?: string } | undefined)?.messageType !== "user") {
      return undefined;
    }
    const names = explorePromptServerNames((event as { prompt?: string } | undefined)?.prompt);
    return names.length > 0 ? names : undefined;
  } catch {
    return undefined;
  }
}

/** Stamp the explore records at a run's settle (ticket 308): every connected server's fresh tool hash as `latest`, with `sightedAt` (when this session's view of its servers was set up) as its sighting time, so a sighting from before the skill's write is not evidence in the staleness check; and the servers an explore prompt named, stamped with the hash their tools hash to now and the time now, as `explored`. One read and one write; no write when nothing changed (a session that settles often must not widen the read-merge-write race). Never throws: a lost record only means the server looks stale again later. */
export function recordExploreRecords(file: string, tools: readonly ToolNamespaceInfo[], names: readonly string[], sightedAt: string): void {
  try {
    const current = loadExploreRecords(file);
    const hashes = computeToolHashes(tools);
    const merged = mergeExploreRecords(current, {
      latest: Object.fromEntries(Object.keys(hashes).map((n) => [n, { hash: hashes[n], at: sightedAt }])),
      explored: Object.fromEntries(names.filter((n) => n in hashes).map((n) => [n, { at: new Date().toISOString(), hash: hashes[n] }])),
    });
    if (JSON.stringify(canonicalize(merged)) !== JSON.stringify(canonicalize(current))) {
      saveExploreRecords(file, merged);
    }
  } catch {
    // see above
  }
}

/** The words `/mcp-up` answers with, for the servers marked whenUp. */
export function describeOutcomes(outcomes: Record<string, Outcome>, servers: Record<string, McpServerConfig>): string {
  const lines = Object.entries(outcomes).map(([name, outcome]) => {
    switch (outcome) {
      case "registered":
        return `${name}: up, connecting (${redactUrl(servers[name]?.url)})`;
      case "already":
        return `${name}: already registered`;
      case "failed":
        return `${name}: pi refused the entry (check it with /doctor)`;
      default:
        return `${name}: nothing is listening at ${redactUrl(servers[name]?.url)} (start it, then /${UP_COMMAND})`;
    }
  });
  return lines.length > 0 ? lines.join("\n") : "no server is marked whenUp in mcp.yaml";
}

export default function (pi: Pi): void {
  const file = process.env[MCP_FILE_ENV];
  if (!file) {
    return;
  }
  const summariesFile = process.env[MCP_SUMMARIES_ENV];
  const recordsFile = process.env[MCP_RECORDS_ENV];
  // The servers the run's opening prompt asked to explore: set when a run starts, consumed and cleared at its settle.
  let pendingExplore: string[] | undefined;
  // When this session's view of its servers was set up: the sighting time `latest` stamps carry, so the staleness
  // check can tell a session whose view predates an explore (not evidence) from one that connected after it.
  let sightedAt = new Date().toISOString();
  pi.on("session_start", async (_event, ctx) => {
    try {
      sightedAt = new Date().toISOString();
      const { servers, problems } = loadServers(file);
      if (problems.length > 0) {
        ctx.ui?.notify?.(`mcp.yaml (${file}):\n${problems.map((p) => `  ${p}`).join("\n")}`, "warning");
      }
      await reconcile(pi, servers, probeUrl, undefined, undefined, loadSummaries(summariesFile));
    } catch {
      // startup must never fail because of this
    }
  });
  pi.on("before_agent_start", (event) => {
    addToolSearchGuideline(event, pi.getActiveTools?.() ?? []);
    if (recordsFile) {
      pendingExplore = explorePromptServers(event);
    }
    return undefined;
  });
  if (summariesFile) {
    pi.on("agent_end", () => recordSummaries(summariesFile, file, pi.getAllTools?.() ?? []));
  }
  if (recordsFile) {
    const stamp = (names: readonly string[]): void => {
      recordExploreRecords(recordsFile, pi.getAllTools?.() ?? [], names, sightedAt);
      pendingExplore = undefined;
    };
    // agent_settled is the only event a run certainly ends with: before_settle can fire more than once per run
    // (an extension may continue the run there - toriel-tasks does), so the outcome that counts is the last one.
    let lastOutcome: RunOutcome | undefined;
    pi.on("agent_before_settle", (event) => {
      lastOutcome = (event as { outcome?: RunOutcome }).outcome;
      return undefined;
    });
    pi.on("agent_settled", (event) => {
      // an explore skill is stamped only for a run whose last settle boundary said completed: an aborted run
      // skips before_settle (it goes agent_end -> agent_settled) and a run continued past its first boundary
      // counts only by its last boundary - either way what the tools looked like is recorded, whatever ended the run
      const ok = (event as { aborted?: boolean }).aborted !== true && lastOutcome === "completed";
      stamp(ok ? (pendingExplore ?? []) : []);
      lastOutcome = undefined;
    });
  }
  pi.registerCommand?.(UP_COMMAND, {
    description: "toriel: connect the mcp.yaml servers marked whenUp that are running now (name one to check only it)",
    handler: async (args, ctx) => {
      const all = loadServers(file).servers;
      const waiting = Object.fromEntries(Object.entries(all).filter(([, s]) => s.whenUp === true));
      const only = args.trim() || undefined;
      if (only !== undefined && !(only in waiting)) {
        ctx.ui?.notify?.(`${only} is not a whenUp server in mcp.yaml (those are: ${Object.keys(waiting).join(", ") || "none"})`, "warning");
        return;
      }
      const outcomes = await reconcile(pi, waiting, probeUrl, only, undefined, loadSummaries(summariesFile));
      ctx.ui?.notify?.(describeOutcomes(outcomes, waiting), Object.values(outcomes).some((o) => o !== "registered" && o !== "already") ? "warning" : "info");
    },
  });
}
