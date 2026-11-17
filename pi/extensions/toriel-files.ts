// toriel files (ticket 13, tool-efficiency study of ticket 63): three small improvements to pi's read/write/edit tools, none of which
// changes how they read or write.
//  1. Freshness: edit and write refuse a file this session has not read, or that changed since it did (lib/freshness.ts). Claude Code
//     does the same. Set the fileFreshness setting to false to turn it off.
//  2. Help for a failed edit: "could not find the exact text" gets the nearest lines of the file (and whether only whitespace
//     differs), "found N occurrences" gets the line numbers (lib/edit-help.ts), so the model does not re-read the whole file to learn why.
//  3. replaceAll: pi's edit tool is registered again under the same name (so every permission rule, the scope veto, plan mode and file
//     history keep applying) with an optional `replaceAll` on each edit, which changes every exact occurrence of its oldText.
// Runs only in children the toriel daemon starts (TORIEL_CHILD). Observes and blocks; a failure inside it never fails a tool call.
import * as fs from "node:fs";
import { createEditToolDefinition, generateDiffString, generateUnifiedPatch, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { type EditArg, editHint, editsOf, occurrences } from "./lib/edit-help.ts";
import { FRESHNESS_ENV, FreshnessStore, fileTool, targetPath } from "./lib/freshness.ts";
import { replaceEvery } from "./lib/replace-all.ts";

interface Ctx {
  cwd?: string;
}
interface ToolEvent {
  toolName?: unknown;
  input?: unknown;
  isError?: unknown;
  content?: unknown;
}
interface Result {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
}
type Execute = (id: string, input: unknown, signal: unknown, onUpdate: unknown, ctx: Ctx) => Promise<Result>;
interface Pi {
  on(event: "tool_call", handler: (event: ToolEvent, ctx?: Ctx) => { block: true; reason: string } | undefined): void;
  on(event: "tool_result", handler: (event: ToolEvent, ctx?: Ctx) => { content: Array<{ type: "text"; text: string }> } | undefined): void;
  registerTool(definition: Record<string, unknown>): void;
}

/** Files bigger than this get no edit hint (the hint reads the whole file). */
const HINT_MAX_BYTES = 4 * 1024 * 1024;

const EDIT_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string", description: "Path to the file to edit (relative or absolute)" },
    edits: {
      type: "array",
      description:
        "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
      items: {
        type: "object",
        properties: {
          oldText: {
            type: "string",
            description: "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call, unless replaceAll is set.",
          },
          newText: { type: "string", description: "Replacement text for this targeted edit." },
          replaceAll: {
            type: "boolean",
            description: "Replace every exact occurrence of oldText in the file instead of requiring it to be unique (to rename a symbol, say). Applied after the call's other edits.",
          },
        },
        required: ["oldText", "newText"],
      },
    },
  },
  required: ["path", "edits"],
};

const text = (t: string): Result["content"] => [{ type: "text", text: t }];

/** The edit call with replaceAll edits: the other edits go through pi's tool, then each replaceAll edit is applied to what is on disk. */
export async function editWithReplaceAll(base: Execute, id: string, input: unknown, signal: unknown, onUpdate: unknown, ctx: Ctx): Promise<Result> {
  const file = targetPath(input, ctx.cwd ?? process.cwd());
  const shown = String((input as { path?: unknown })?.path ?? "");
  if (file === undefined) {
    throw new Error("Edit tool input is invalid. path must be a file path.");
  }
  const list: EditArg[] = editsOf(input);
  const wholeFile = (e: NodeJS.ErrnoException): Error => new Error(`Could not edit file: ${shown}. Error code: ${e.code ?? String(e)}.`);
  let before: string;
  try {
    before = fs.readFileSync(file, "utf8");
  } catch (e) {
    throw wholeFile(e as NodeJS.ErrnoException);
  }
  const many = list.map((e, i) => ({ e, i })).filter((x) => x.e.replaceAll);
  // check the replaceAll edits against the file before anything is written, so a bad one fails the whole call
  for (const { e, i } of many) {
    if (e.oldText === "") {
      throw new Error(`edits[${i}].oldText must not be empty in ${shown}.`);
    }
    if (occurrences(before, e.oldText, 0).total === 0) {
      throw new Error(`Could not find edits[${i}] in ${shown}. The oldText must match exactly including all whitespace and newlines.`);
    }
  }
  const rest = list.filter((e) => !e.replaceAll).map(({ oldText, newText }) => ({ oldText, newText }));
  if (rest.length > 0) {
    await base(id, { path: (input as { path: string }).path, edits: rest }, signal, onUpdate, ctx);
  }
  return withFileMutationQueue(file, async () => {
    const now = fs.readFileSync(file, "utf8");
    let after = now;
    let replaced = 0;
    for (const { e, i } of many) {
      const r = replaceEvery(after, e.oldText, e.newText);
      if (r.count === 0) {
        throw new Error(`Could not find edits[${i}] in ${shown} after the call's other edits were applied (they are kept). The oldText must match exactly including all whitespace and newlines.`);
      }
      after = r.content;
      replaced += r.count;
    }
    if (after === now) {
      throw new Error(`No changes made to ${shown}. The replacements produced identical content.`);
    }
    fs.writeFileSync(file, after, "utf8");
    const lf = (s: string): string => s.replace(/\r\n/g, "\n");
    const shownDiff = generateDiffString(lf(before), lf(after));
    return {
      content: text(`Successfully replaced ${list.length} block(s) in ${shown} (${replaced} occurrence${replaced === 1 ? "" : "s"} changed by replaceAll).`),
      details: { diff: shownDiff.diff, patch: generateUnifiedPatch(shown, lf(before), lf(after)), firstChangedLine: shownDiff.firstChangedLine },
    };
  });
}

export default function (pi: Pi): void {
  if (!process.env.TORIEL_CHILD) {
    return;
  }
  const store = process.env[FRESHNESS_ENV] === "off" ? undefined : new FreshnessStore();

  pi.on("tool_call", (event, ctx) => {
    try {
      const tool = fileTool(event?.toolName);
      if (store === undefined || (tool !== "write" && tool !== "edit")) {
        return undefined;
      }
      const file = targetPath(event.input, ctx?.cwd ?? process.cwd());
      if (file === undefined) {
        return undefined;
      }
      const reason = store.verdict(tool, file, String((event.input as { path?: unknown }).path));
      return reason === undefined ? undefined : { block: true, reason };
    } catch {
      return undefined;
    }
  });

  pi.on("tool_result", (event, ctx) => {
    try {
      const tool = fileTool(event?.toolName);
      if (tool === undefined) {
        return undefined;
      }
      const file = targetPath(event.input, ctx?.cwd ?? process.cwd());
      if (file === undefined) {
        return undefined;
      }
      if (event.isError !== true) {
        store?.record(file);
        return undefined;
      }
      if (tool !== "edit" || !Array.isArray(event.content)) {
        return undefined;
      }
      const first = (event.content as Array<{ type?: string; text?: string }>).find((c) => c?.type === "text" && typeof c.text === "string");
      if (first?.text === undefined || fs.statSync(file).size > HINT_MAX_BYTES) {
        return undefined;
      }
      const hint = editHint(first.text, editsOf(event.input), fs.readFileSync(file, "utf8"), String((event.input as { path?: unknown }).path));
      return hint === undefined ? undefined : { content: text(`${first.text}\n\n${hint}`) };
    } catch {
      return undefined;
    }
  });

  const base = createEditToolDefinition(process.cwd());
  const execute = base.execute as unknown as Execute;
  pi.registerTool({
    ...base,
    parameters: EDIT_SCHEMA,
    description: `${base.description} Set replaceAll on an edit to change every exact occurrence of its oldText.`,
    promptGuidelines: [...(base.promptGuidelines ?? []), "To rename or change something used in many places, give one edit with replaceAll: true instead of many edits."],
    execute: (id: string, input: unknown, signal: unknown, onUpdate: unknown, ctx: Ctx) =>
      editsOf(input).some((e) => e.replaceAll) ? editWithReplaceAll(execute, id, input, signal, onUpdate, ctx ?? {}) : execute(id, input, signal, onUpdate, ctx),
  });
}
