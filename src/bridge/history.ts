// A session's past as chat posts (ticket 279): what the bridge shows in a channel for the turns that happened before the channel existed,
// or while it was closed. Pure: the bridge fetches the digest (`read_history`) and posts what this returns.
import type { HistoryTurn } from "../shared.ts";
import { parseLocalCommand } from "../local-command.ts";

/** How many turns a new channel is given at most, and the most text (characters) the whole past may come to. */
export const HISTORY_TURNS = 40;
export const HISTORY_CHARS = 30_000;
/** A typed prompt is quoted, not copied: a long one is cut here. */
const QUOTE_CHARS = 500;

/**
 * A user turn as a post. toriel injects a `!command`'s result as a user message in a wrapper meant for the model
 * (`local-command.ts`); like the desktop's transcript, this shows the command and its output instead of the wrapper. `who` is
 * `typed in toriel` live, `you` for the past (which does not know where it was typed).
 */
export function quoteUser(text: string, who: string): string {
  const local = parseLocalCommand(text);
  if (local) {
    const status = local.cancelled ? "stopped" : local.exitCode === undefined ? "" : `exit ${local.exitCode}`;
    const out = local.output.trim().replaceAll("```", "ˋˋˋ");
    const body = out.length > QUOTE_CHARS ? `${out.slice(0, QUOTE_CHARS)}…` : out;
    return blockquote(`**ran in toriel:** \`${oneLineCmd(local.command)}\`${status ? ` (${status})` : ""}${body ? `\n\`\`\`\n${body}\n\`\`\`` : ""}`);
  }
  return blockquote(`**${who}:** ${text.length > QUOTE_CHARS ? `${text.slice(0, QUOTE_CHARS)}…` : text}`);
}

/** Every line quoted: a `> ` on the first line alone leaves the rest of a multi-line message outside the quote. */
export function blockquote(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => (l === "" ? ">" : `> ${l}`))
    .join("\n");
}

const oneLineCmd = (c: string): string => c.replace(/\s+/g, " ").trim().replaceAll("`", "ˋ");

const tools = (n: number): string => `_${n} tool${n === 1 ? "" : "s"} ran_`;

/**
 * The posts for these turns, oldest first, in the form the live channel uses: a user turn is quoted (`typed in toriel` is what a live
 * one says; the past does not know where it was typed, so it says `you`), an assistant turn is its text followed by the number of tools
 * run since the last text, a compaction is a line of its own, and an aborted turn says so. Turns are dropped from the start until the
 * whole fits `HISTORY_CHARS`; `dropped` counts them. `shown` is the turns that made it.
 */
export function renderHistory(turns: readonly HistoryTurn[], maxChars = HISTORY_CHARS): { posts: string[]; shown: number; dropped: number } {
  const posts: Array<{ text: string; turns: number }> = [];
  let pendingTools = 0;
  let pendingTurns = 0;
  for (const t of turns) {
    if (t.role === "compaction") {
      posts.push({ text: "ℹ context compacted here", turns: 1 });
    } else if (t.role === "user") {
      const text = t.text.trim();
      if (text) {
        posts.push({ text: quoteUser(text, "you"), turns: 1 });
      }
    } else {
      const text = t.text.trim();
      const parts = [text, t.errorMessage ? `⚠ ${t.errorMessage}` : "", t.stopReason === "aborted" ? "⏹ interrupted" : ""].filter(Boolean);
      if (parts.length > 0) {
        if (pendingTools > 0) {
          parts.push(tools(pendingTools));
          pendingTools = 0;
        }
        posts.push({ text: parts.join("\n\n"), turns: 1 + pendingTurns });
        pendingTurns = 0;
      } else {
        pendingTurns++; // a turn of nothing but tool calls: counted in the next post
      }
      pendingTools += t.tools ?? 0;
    }
  }
  if (pendingTools > 0) {
    posts.push({ text: tools(pendingTools), turns: pendingTurns });
  }
  let total = posts.reduce((n, p) => n + p.text.length, 0);
  let dropped = 0;
  while (posts.length > 1 && total > maxChars) {
    const first = posts.shift() as { text: string; turns: number };
    total -= first.text.length;
    dropped += first.turns;
  }
  return { posts: posts.map((p) => p.text), shown: posts.reduce((n, p) => n + p.turns, 0), dropped };
}
