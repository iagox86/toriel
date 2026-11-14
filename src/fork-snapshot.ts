// What /fork copies from a session that is still running. pi writes a message to the session file when it
// is complete, so a busy session's file ends at the last finished message - but that can be an assistant
// message whose tool calls have no result yet (the tools are still executing), or a line pi is writing
// right now. A copy that starts there would either send a tool call with no answer to the model, which the
// providers reject, or choke on half a line. The snapshot is the file up to the last point where every tool
// call has its result.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseLines, type SessionEntryLike } from "./session-file.ts";

type Entry = SessionEntryLike & {
  message?: { role?: string; content?: unknown; toolCallId?: string };
  /** A `context_edit` entry: the entry it edits, and what that entry's content becomes (null = removed from the model's context). */
  targetId?: string;
  replacement?: { content?: unknown } | null;
};

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
 * The tool calls of `targetId`'s entry that a `context_edit` leaves in the model's context. pi's projection
 * (session-manager.js projectContextEntry): `replacement: null` removes the entry, a replacement swaps its
 * content (a string becomes one text block), so a call survives only as a toolCall block of the new content.
 */
function survivingCalls(replacement: Entry["replacement"]): Set<string> {
  const content = replacement?.content;
  if (!Array.isArray(content)) {
    return new Set();
  }
  return new Set(content.flatMap((b: { type?: string; id?: string }) => (b?.type === "toolCall" && typeof b.id === "string" ? [b.id] : [])));
}

/**
 * The part of a session file's text that is safe to copy: whole lines, ending where no tool call is
 * waiting for its result. `dropped` counts the lines left out.
 */
export function settledPrefix(text: string): { text: string; dropped: number } {
  // the copy is made from the file's own lines, so no migration here
  const parsedLines = parseLines<Entry>(text).filter((l) => l.raw.length > 0);
  const lines = parsedLines.map((l) => l.raw);
  const pending = new Set<string>();
  // which tool calls each entry made, so a context_edit that removes the entry also retires its calls: the
  // model never sees them, so no result is owed (without this one stuck call truncated every later line)
  const callsOf = new Map<string, string[]>();
  let safe = 0;
  let parsed = 0;
  for (const { entry } of parsedLines) {
    if (!entry) {
      break; // a line pi is still writing: nothing after it counts either
    }
    parsed++;
    const calls = callIds(entry);
    for (const id of calls) {
      pending.add(id);
    }
    // an entry without an id cannot be the target of an edit; every entry pi writes has one
    if (calls.length > 0 && typeof entry.id === "string") {
      callsOf.set(entry.id, calls);
    }
    if (entry.type === "context_edit" && typeof entry.targetId === "string") {
      const keep = survivingCalls(entry.replacement);
      for (const id of callsOf.get(entry.targetId) ?? []) {
        if (!keep.has(id)) {
          pending.delete(id);
        }
      }
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
