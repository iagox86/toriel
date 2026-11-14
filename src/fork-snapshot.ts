// What /fork copies from a session that is still running. pi writes a message to the session file when it
// is complete, so a busy session's file ends at the last finished message - but that can be an assistant
// message whose tool calls have no result yet (the tools are still executing), or a line pi is writing
// right now. A copy that starts there would either send a tool call with no answer to the model, which the
// providers reject, or choke on half a line. The snapshot is the file up to the last point where every tool
// call has its result and no toolResult has lost the call it answers.
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
  /** Lines (entries) left out because they were unfinished or orphaned; 0 for a whole file. */
  dropped: number;
  /** Removes the trimmed copy, if there is one. */
  cleanup(): void;
}

/** The ids of the toolCall blocks a content array carries. */
function callIdsOf(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((b: { type?: string; id?: string }) => (b?.type === "toolCall" && typeof b.id === "string" ? [b.id] : []));
}

/**
 * The tool calls an entry projects to (pi's session-manager.js projectContextEntry): its own calls,
 * none at all when a `context_edit` removes it (`replacement: null`), or the new content's toolCall
 * blocks when a replacement swaps its content - including calls the original never made. A replacement
 * with no content also empties the content, so {} retires calls the same way null does.
 */
function effectiveCalls(original: readonly string[], edit: Entry | undefined): string[] {
  if (edit === undefined) {
    return [...original];
  }
  if (edit.replacement === null || edit.replacement === undefined) {
    return [];
  }
  return callIdsOf(edit.replacement.content);
}

/**
 * How many leading lines of the file form a projection with no unanswered tool call. pi's projection
 * (session-manager.js buildSessionProjection) applies the last `context_edit` per target entry, and
 * pi files always put an edit after the entry it edits, so the scan applies each edit incrementally:
 * `sources` counts how many kept entries' effective content carries a call id, `answers` how many kept
 * result entries answer it. A call is pending while it has a source and no answer - in either direction,
 * since a removed answer re-arms its call (pi keeps the roles of an entry a replacement swaps, so only
 * a null replacement changes what a result entry answers).
 * The scan is file-order while pi projects only the path from the newest compaction to the leaf, so a
 * call that only survives on an abandoned branch over-trims: the copy loses lines it need not, never
 * hands out an unanswered call.
 */
function safeLineCount(parsedLines: Array<{ entry?: Entry }>): number {
  const edits = new Map<string, Entry>();
  const callsOf = new Map<string, string[]>();
  const resultOf = new Map<string, string>();
  const sources = new Map<string, number>();
  const answers = new Map<string, number>();
  const pending = new Set<string>();
  const source = (id: string, delta: number) => {
    const was = sources.get(id) ?? 0;
    const now = was + delta;
    if (now > 0) {
      sources.set(id, now);
    } else {
      sources.delete(id);
    }
    if (was === 0 && now > 0 && !answers.has(id)) {
      pending.add(id);
    } else if (was > 0 && now === 0) {
      pending.delete(id);
    }
  };
  const answer = (id: string, delta: number) => {
    const was = answers.get(id) ?? 0;
    const now = was + delta;
    if (now > 0) {
      answers.set(id, now);
    } else {
      answers.delete(id);
    }
    if (was === 0 && now > 0 && sources.has(id)) {
      pending.delete(id);
    } else if (was > 0 && now === 0 && sources.has(id)) {
      pending.add(id);
    }
  };
  let safe = 0;
  for (let i = 0; i < parsedLines.length; i++) {
    const entry = parsedLines[i].entry;
    if (entry === undefined) {
      break; // a line pi is still writing: nothing after it counts either
    }
    if (entry.type === "context_edit" && typeof entry.targetId === "string") {
      const target = entry.targetId;
      const callId = resultOf.get(target);
      if (callId !== undefined) {
        // the target is a result entry: pi swaps only its content, so it still answers unless removed;
        // a repeated null edit must not double-decrement, and a non-null edit after null restores it
        const wasGone = edits.get(target) !== undefined && edits.get(target)?.replacement === null;
        const isGone = entry.replacement === null;
        if (!wasGone && isGone) {
          answer(callId, -1);
        } else if (wasGone && !isGone) {
          answer(callId, 1);
        }
      } else {
        const original = callsOf.get(target) ?? [];
        const prev = effectiveCalls(original, edits.get(target));
        const next = effectiveCalls(original, entry);
        for (const id of next) {
          if (!prev.includes(id)) {
            source(id, 1);
          }
        }
        for (const id of prev) {
          if (!next.includes(id)) {
            source(id, -1);
          }
        }
      }
      edits.set(target, entry);
    }
    // an entry without an id cannot be the target of an edit; every entry pi writes has one
    const role = entry.message?.role;
    if (role === "assistant") {
      const calls = callIdsOf(entry.message?.content);
      if (calls.length > 0 && typeof entry.id === "string") {
        callsOf.set(entry.id, calls);
      }
      for (const id of effectiveCalls(calls, typeof entry.id === "string" ? edits.get(entry.id) : undefined)) {
        source(id, 1);
      }
    } else if (role === "toolResult" && typeof entry.message?.toolCallId === "string") {
      if (typeof entry.id === "string") {
        resultOf.set(entry.id, entry.message.toolCallId);
      }
      answer(entry.message.toolCallId, 1);
    }
    if (pending.size === 0) {
      safe = i + 1;
    }
  }
  return safe;
}

/**
 * The last `context_edit` per target entry among `kept`, in file order: pi's projection applies the
 * last edit per target (buildSessionProjection collects them with a Map set).
 */
function editsByTarget(kept: readonly Entry[]): Map<string, Entry> {
  const latest = new Map<string, Entry>();
  for (const e of kept) {
    if (e.type === "context_edit" && typeof e.targetId === "string") {
      latest.set(e.targetId, e);
    }
  }
  return latest;
}

/**
 * The part of a session file's text that is safe to copy: whole lines, ending where no tool call is
 * waiting for its result. `dropped` counts the lines left out.
 */
export function settledPrefix(text: string): { text: string; dropped: number } {
  // the copy is made from the file's own lines, so no migration here
  const parsedLines = parseLines<Entry>(text).filter((l) => l.raw.length > 0);
  const safe = safeLineCount(parsedLines);
  const kept = parsedLines.slice(0, safe);
  return {
    text: kept.length === 0 ? "" : `${kept.map((l) => l.raw).join("\n")}\n`,
    dropped: parsedLines.length - safe,
  };
}

/** The file to fork from: `file` itself when it is whole, else a copy in `tmpDir`. */
export function forkSnapshot(file: string, tmpDir = os.tmpdir()): Snapshot {
  const text = fs.readFileSync(file, "utf8");
  // the copy is made from the file's own lines, so no migration here
  const parsedLines = parseLines<Entry>(text).filter((l) => l.raw.length > 0);
  const safe = safeLineCount(parsedLines);
  const kept = parsedLines.slice(0, safe);
  const entries = kept.map((l) => l.entry as Entry);
  // a result whose call an edit removed would be an orphan in the copy's projection, and the providers
  // reject an orphan result exactly like an unanswered call. pi builds the context by walking parentId
  // from the leaf, so REMOVING such a line would cut the chain and lose the history before it; instead
  // the copy appends a `context_edit` (replacement null) for each orphan, which takes it out of the
  // projection. Even a file that needs no trim may need this copy.
  const latest = editsByTarget(entries);
  const surviving = new Set<string>();
  for (const e of entries) {
    if (e.type === "message" && e.message?.role === "assistant" && typeof e.id === "string") {
      for (const id of effectiveCalls(callIdsOf(e.message.content), latest.get(e.id))) {
        surviving.add(id);
      }
    }
  }
  const orphans: string[] = [];
  let lastId: string | undefined;
  for (const e of entries) {
    if (typeof e.id === "string") {
      lastId = e.id as string;
    }
  }
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.type !== "message" || e.message?.role !== "toolResult" || typeof e.id !== "string" || typeof e.message.toolCallId !== "string") {
      continue;
    }
    const edit = latest.get(e.id);
    if (edit !== undefined && edit.replacement === null) {
      continue; // already out of the projection
    }
    if (!surviving.has(e.message.toolCallId)) {
      const id = `toriel-edit-${orphans.length + 1}`;
      orphans.push(`${JSON.stringify({ type: "context_edit", id, parentId: lastId, targetId: e.id, replacement: null })}\n`);
      lastId = id; // chain a second orphan edit to the first, so the leaf path keeps them all
    }
  }
  if (safe === parsedLines.length && orphans.length === 0) {
    return { path: file, dropped: 0, cleanup() {} };
  }
  const dir = fs.mkdtempSync(path.join(tmpDir, "toriel-fork-"));
  const copy = path.join(dir, path.basename(file));
  fs.writeFileSync(copy, `${kept.map((l) => l.raw).join("\n")}\n${orphans.join("")}`, { mode: 0o600 });
  return { path: copy, dropped: parsedLines.length - safe, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
