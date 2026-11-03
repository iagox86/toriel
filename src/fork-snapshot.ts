// What /fork copies from a session that is still running. pi writes a message to the session file when it
// is complete, so a busy session's file ends at the last finished message - but that can be an assistant
// message whose tool calls have no result yet (the tools are still executing), or a line pi is writing
// right now. A copy that starts there would either send a tool call with no answer to the model, which the
// providers reject, or choke on half a line. The snapshot is the file up to the last point where every tool
// call has its result.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface Entry {
  type?: string;
  message?: { role?: string; content?: unknown; toolCallId?: string };
}

export interface Snapshot {
  /** The file the copy is made from: the session file itself, or a trimmed copy of it. */
  path: string;
  /** Lines (entries) left out because they were unfinished; 0 for a settled session. */
  dropped: number;
  /** Removes the trimmed copy, if there is one. */
  cleanup(): void;
}

/** The ids of the tool calls an entry makes. */
function callIds(entry: Entry): string[] {
  const content = entry.message?.role === "assistant" ? entry.message.content : undefined;
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((b: { type?: string; id?: string }) => (b?.type === "toolCall" && typeof b.id === "string" ? [b.id] : []));
}

/**
 * The part of a session file's text that is safe to copy: whole lines, ending where no tool call is
 * waiting for its result. `dropped` counts the lines left out.
 */
export function settledPrefix(text: string): { text: string; dropped: number } {
  const lines = text.split("\n").filter((l) => l.length > 0);
  const pending = new Set<string>();
  let safe = 0;
  let parsed = 0;
  for (const line of lines) {
    let entry: Entry;
    try {
      entry = JSON.parse(line) as Entry;
    } catch {
      break; // a line pi is still writing: nothing after it counts either
    }
    parsed++;
    for (const id of callIds(entry)) {
      pending.add(id);
    }
    if (entry.message?.role === "toolResult" && entry.message.toolCallId !== undefined) {
      pending.delete(entry.message.toolCallId);
    }
    if (pending.size === 0) {
      safe = parsed;
    }
  }
  return { text: safe === 0 ? "" : `${lines.slice(0, safe).join("\n")}\n`, dropped: lines.length - safe };
}

/** The file to fork from: `file` itself when it is whole, else a trimmed copy in `tmpDir`. */
export function forkSnapshot(file: string, tmpDir = os.tmpdir()): Snapshot {
  const text = fs.readFileSync(file, "utf8");
  const settled = settledPrefix(text);
  if (settled.dropped === 0 || settled.text === "") {
    return { path: file, dropped: 0, cleanup() {} };
  }
  const dir = fs.mkdtempSync(path.join(tmpDir, "toriel-fork-"));
  const copy = path.join(dir, path.basename(file));
  fs.writeFileSync(copy, settled.text, { mode: 0o600 });
  return { path: copy, dropped: settled.dropped, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
