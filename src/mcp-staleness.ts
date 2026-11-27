// Whether an MCP server's skill (written by /mcp explore, ticket 306) has gone stale (tickets 308, 330).
// The toriel-mcp extension stamps an explore record per server at the end of each run: the write time and
// the tool-set hash of that moment, plus the last-seen tool hash. A skill is stale when the server's tools
// changed since it was explored, or when the explore record is old and nothing has confirmed the tools
// since. Pure logic, no fs: the caller reads the records and the skill presence and hands them in.

/** How long a skill stays trusted without a run confirming the server's tools. */
export const MCP_SKILL_STALE_DAYS = 30;
const ONE_DAY_MS = 86_400_000;

/** One server's explore record and last-seen tool hash, as the extension keeps it, plus what the caller knows locally. */
export interface StalenessInput {
  server: string;
  hasSkill: boolean;
  record?: { at: string; hash: string };
  latestHash?: string;
  now: Date;
}

export type StalenessVerdict = { kind: "changed" } | { kind: "old" } | { kind: "unknown-time" } | { kind: "no-skill" } | { kind: "fresh" };

/**
 * Why a skill needs re-exploring: no skill, no record of an explore run, tools changed after the explore
 * that wrote the skill, or the record at least MCP_SKILL_STALE_DAYS old (an unreadable record counts as old).
 */
export function stalenessVerdict(input: StalenessInput): StalenessVerdict {
  if (!input.hasSkill) {
    return { kind: "no-skill" };
  }
  if (input.record === undefined) {
    return { kind: "unknown-time" };
  }
  if (input.latestHash !== undefined && input.latestHash !== input.record.hash) {
    return { kind: "changed" };
  }
  const at = Date.parse(input.record.at);
  if (!Number.isFinite(at) || input.now.getTime() - at >= MCP_SKILL_STALE_DAYS * ONE_DAY_MS) {
    return { kind: "old" };
  }
  return { kind: "fresh" };
}

/** A date as YYYY-MM-DD, local time, like the other date rendering in the repo. */
function dateOnly(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The human one-liner behind a verdict, for the bare /mcp explore plan ("<name>: <reason>") and the doctor's finding alike. */
export function stalenessReason(verdict: StalenessVerdict, input: StalenessInput): string {
  const at = input.record === undefined ? NaN : Date.parse(input.record.at);
  switch (verdict.kind) {
    case "no-skill":
      return "no skill yet";
    case "unknown-time":
      return "no record of a previous explore";
    case "changed":
      if (!Number.isFinite(at)) {
        return "the server's tools changed since the skill was written (the explore date could not be read)";
      }
      return `the server's tools changed after the explore on ${dateOnly(new Date(at))}`;
    case "old":
      if (!Number.isFinite(at)) {
        return `explored more than ${MCP_SKILL_STALE_DAYS} days ago (the explore date could not be read)`;
      }
      return `explored ${Math.floor((input.now.getTime() - at) / ONE_DAY_MS)} days ago`;
    case "fresh":
      return "up to date";
  }
}
