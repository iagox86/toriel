// How permission grants read in a listing (the /permissions panel) and in a pick list.
import { oneLineFlat } from "./format.ts";
import type { GrantView } from "./shared.ts";
import { fmtNext } from "./when.ts";

/** `#3 bash "git status"`. */
export function grantLabel(g: GrantView): string {
  return `#${g.id} ${g.surface} ${JSON.stringify(g.pattern)}`;
}

function lifetime(g: GrantView, now: Date): string {
  return g.expiresAt === null ? "until revoked" : `expires ${fmtNext(g.expiresAt, now)}`;
}

/** One line for a pick list: `#3 bash "git status" - expires 15:42 (in 52m) [session]`. */
export function grantChoice(g: GrantView, now: Date, showSession: boolean): string {
  const session = showSession ? ` [${g.sessionName ?? g.session.slice(0, 8)}]` : "";
  return `${grantLabel(g)} - ${g.dormant ? "saved, not active" : lifetime(g, now)}${session}`;
}

/** The /permissions panel: a few lines per grant, and notes on what the list leaves out. */
export function grantListing(grants: GrantView[], now: Date, showSession: boolean): string {
  const lines: string[] = [];
  for (const g of grants) {
    const bits = [grantLabel(g), g.dormant ? "SAVED, NOT ACTIVE (/permissions restore)" : lifetime(g, now), g.source === "dialog" ? "from a permission prompt" : "added by command"];
    lines.push(bits.join(" | "));
    if (showSession) {
      lines.push(`    session: ${g.sessionName ?? g.session.slice(0, 8)}`);
    }
    if (g.note) {
      lines.push(`    ${oneLineFlat(g.note, 100)}`);
    }
  }
  const saved = grants.filter((g) => g.dormant).length;
  if (saved > 0) {
    lines.push("", `${saved} saved grant${saved === 1 ? " is" : "s are"} inactive since the daemon restarted: /permissions restore turns them on, /permissions revoke --all drops them.`);
  }
  lines.push("", `Not listed: answers given to pi's own "Yes, allow ... for this session" option (pi keeps those in memory and loses them on a restart).`);
  return lines.join("\n");
}

/** Durations the permission prompt offers as "allow for ..." rows: "1h" reads "1 hour". */
export function durationWords(d: string): string {
  const m = /^(\d+)\s*([smhd])$/i.exec(d.trim());
  if (!m) {
    return d.trim();
  }
  const unit = { s: "second", m: "minute", h: "hour", d: "day" }[(m[2] as string).toLowerCase() as "s" | "m" | "h" | "d"];
  return `${m[1]} ${unit}${m[1] === "1" ? "" : "s"}`;
}
