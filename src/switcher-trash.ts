// /restore: bring a deleted session back from the toriel trash.
import * as path from "node:path";
import { matching } from "./completion.ts";
import { TRASH_DIR } from "./config.ts";
import { firstMessageLabel, fmtAge } from "./format.ts";
import { loadGroups } from "./groups.ts";
import type { Host } from "./host.ts";
import { listTrashedSessions, type TrashedSession } from "./trash.ts";
import { errText } from "./util.ts";

/** Deleted sessions to pick from; a single match (or a lone entry) is restored directly. */
export async function restoreFromTrash(h: Host, query: string, refresh: () => void): Promise<void> {
  const saved = loadGroups().summaries ?? {};
  const label = (t: TrashedSession): string => {
    const title = t.name ?? (t.sessionId ? saved[t.sessionId]?.text : undefined) ?? firstMessageLabel(t.firstMessage ?? "", 50);
    const age = t.trashedAt ? `${fmtAge(Date.now() - Date.parse(t.trashedAt))} ago` : "earlier";
    const where = path.basename(t.cwd ?? path.dirname(t.originalPath));
    return `${title || "<unnamed>"}  [deleted ${age}, ${t.messages} msgs, ${where}] ${(t.sessionId ?? "").slice(0, 8)}`;
  };
  const entries = listTrashedSessions(TRASH_DIR).map((t) => ({ t, text: label(t) }));
  const shown = matching(entries.map((e) => e.text), query);
  const choices = entries.filter((e) => shown.includes(e.text));
  if (entries.length === 0) {
    h.switcher.hint = "the trash has no deleted sessions";
  } else if (choices.length === 0) {
    h.switcher.hint = `restore: nothing in the trash matches "${query}"`;
  } else if (choices.length === 1 && query) {
    await restoreOne(h, refresh, choices[0]!.t, choices[0]!.text);
  } else {
    h.choicePanel.open(
      "Restore which deleted session?",
      choices.map((e) => e.text),
      undefined,
      (picked) => {
        const chosen = choices.find((e) => e.text === picked);
        if (chosen) {
          void restoreOne(h, refresh, chosen.t, chosen.text);
        }
      },
    );
  }
  h.tui.requestRender();
}

async function restoreOne(h: Host, refresh: () => void, t: TrashedSession, text: string): Promise<void> {
  try {
    await h.request({ type: "restore", trashedTo: t.trashedTo });
    await h.loadLocal();
    refresh();
    h.switcher.hint = `restored ${text.split("  [")[0]}`;
  } catch (err) {
    h.switcher.hint = `restore failed: ${errText(err)}`;
  }
  h.tui.requestRender();
}
