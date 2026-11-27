// Whether an MCP server's skill (written by /mcp explore, ticket 306) has gone stale (tickets 308, 330).
// The toriel-mcp extension stamps an explore record per server at the end of each run that saw its tools:
// the skill's write time and the tool-set hash of that moment, plus the last sighting of the tools (their
// hash, with the time the sighting session's view was set up). A skill is stale when the server's tools
// changed since it was explored, or when the explore record is old. A sighting only counts when it was
// recorded at or after the skill was written, so a session whose view of the server predates the explore
// cannot make it look fresh. Pure logic, no fs: the caller reads the records and the skill presence and
// hands them in.

/** How long a skill stays trusted before it is re-explored even though nothing has changed. */
export const MCP_SKILL_STALE_DAYS = 30;
const ONE_DAY_MS = 86_400_000;

/** One server's explore record and last tool sighting, as the records file keeps them, plus what the caller knows locally. */
export interface StalenessInput {
  hasSkill: boolean;
  record?: { at: string; hash: string };
  latest?: { hash: string; at: string };
  now: Date;
}

export type StalenessVerdict = { kind: "changed" } | { kind: "old" } | { kind: "no-record" } | { kind: "no-skill" } | { kind: "fresh" };

/**
 * Why a skill needs re-exploring: no skill, no record of an explore run, tools changed after the explore
 * that wrote the skill, or the record at least MCP_SKILL_STALE_DAYS old (an unreadable record counts as old).
 * A sighting counts only when it was seen at or after the record was written (equal counts as seen); a
 * sighting that is missing, unreadable or older than the record is not evidence, so the record's age decides.
 */
export function stalenessVerdict(input: StalenessInput): StalenessVerdict {
  if (!input.hasSkill) {
    return { kind: "no-skill" };
  }
  if (input.record === undefined) {
    return { kind: "no-record" };
  }
  const written = Date.parse(input.record.at);
  if (input.latest !== undefined) {
    const seen = Date.parse(input.latest.at);
    if (Number.isFinite(seen) && (!Number.isFinite(written) || seen >= written) && input.latest.hash !== input.record.hash) {
      return { kind: "changed" };
    }
  }
  if (!Number.isFinite(written) || input.now.getTime() - written >= MCP_SKILL_STALE_DAYS * ONE_DAY_MS) {
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
    case "no-record":
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
