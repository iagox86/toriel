// /performance: a throwaway analysis pass over this session's transcript.
// Reuses the /btw side run (a temp copy of the jsonl, `pi --print --no-tools`
// over it, SIGKILL on timeout): the session never sees the run, a sleeping
// session stays asleep, and the model has no tools, so it cannot read anything
// else (pi's auth and models files included).
import * as fs from "node:fs";
import * as path from "node:path";
import { saveBtw, sideRun } from "./btw.ts";

/** Transcripts longer than this (in bytes) are cut to the session header plus the most recent whole entries before the run. */
export const TRANSCRIPT_CAP_BYTES = 2 * 1024 * 1024;

/** A JSONL line bigger than this (one huge tool output, say) is clipped before fitting. */
export const TRANSCRIPT_CLIP_LINE_BYTES = 64 * 1024;

/** Strings inside a clipped entry keep this many characters, then a marker says what was cut. */
export const TRANSCRIPT_CLIP_CHARS = 8_000;

/** The analysis reads a whole transcript; longer than a /btw answer. */
export const PERFORMANCE_TIMEOUT_MS = 5 * 60_000;

/**
 * Keeps the transcript within the byte budget as the session header (first
 * line, which pi needs) plus the most recent whole entries that fit. A line
 * over TRANSCRIPT_CLIP_LINE_BYTES has its long string values clipped first, so
 * one huge tool output survives with a marker instead of being lost. When
 * entries were dropped, an omission note follows the header; pi skips that
 * line, so the prompt carries the omission too, and `truncated` says whether
 * entries were dropped.
 */
export function capTranscript(text: string, capBytes = TRANSCRIPT_CAP_BYTES): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= capBytes) {
    return { text, truncated: false };
  }
  const lines = text.split("\n").map((line) => (Buffer.byteLength(line) > TRANSCRIPT_CLIP_LINE_BYTES ? clipEntryLine(line) : line));
  const header = lines[0] ?? "";
  const kept: string[] = [];
  let used = header ? Buffer.byteLength(header) + 1 : 0;
  for (let i = lines.length - 1; i >= 1; i--) {
    const size = Buffer.byteLength(lines[i]) + 1; // the line plus its newline
    if (used + size > capBytes) {
      break;
    }
    used += size;
    kept.unshift(lines[i]);
  }
  const dropped = lines.length - 1 - kept.length;
  const mib = capBytes / (1024 * 1024);
  const note = dropped > 0 ? `[toriel: ${dropped} earlier entries omitted to fit the ${Number.isInteger(mib) ? mib : mib.toFixed(1)} MiB transcript cap]` : "";
  return { text: [header, note, ...kept].filter(Boolean).join("\n"), truncated: dropped > 0 };
}

/**
 * Clip an oversized JSONL line so it stays valid JSON: every string value over
 * `maxChars` characters is cut with a marker saying how much followed. A line
 * that is not JSON is returned as-is (pi skips malformed lines anyway).
 */
export function clipEntryLine(line: string, maxChars = TRANSCRIPT_CLIP_CHARS): string {
  try {
    return JSON.stringify(clipStrings(JSON.parse(line) as unknown, maxChars));
  } catch {
    return line;
  }
}

function clipStrings(value: unknown, maxChars: number): unknown {
  if (typeof value === "string") {
    return value.length > maxChars ? `${value.slice(0, maxChars)}...[${value.length - maxChars} characters cut]` : value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => clipStrings(v, maxChars));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, clipStrings(v, maxChars)]));
  }
  return value;
}

/** The fixed review prompt; tells the model it is one-shot and toolless, and what to cover. */
export function performancePrompt(truncated: boolean): string {
  const lines = [
    "[performance review of this session - report from the conversation you have]",
    "You are reviewing the transcript of a coding-agent session to find what is slowing it down or costing more than it should. You have no tools here and cannot run, read or",
    "change anything, and the user cannot reply to this answer, so report in one go: no questions, no offers to do more.",
  ];
  if (truncated) {
    lines.push("The transcript's earliest entries were dropped to fit the transcript cap; judge only what is there, and do not guess at what came before.");
  }
  lines.push(
    "",
    "Cover, in concrete terms (quote the repeated command, the file, or the skill, agent profile or MCP server in question; say roughly where in the session):",
    "- context bloat: large tool outputs, the same file read repeatedly, long stretches that were never compacted - what is heavy now and where it grew",
    "- compaction timing: where a compaction would have saved context or cost",
    "- missed opportunities: work that would have been better as a skill, an agent profile or an MCP server (name what to add)",
    "- repetitive shell commands: commands run over and over that would be a skill or a script (quote them and how often)",
    "- user corrections: where the user had to correct the agent and it would help to remember (memory candidates)",
    "- model fit: a big model doing small work, or a model too weak for a step",
    "- permission friction: prompts that kept repeating and a standing grant would have removed (the surface and pattern to grant)",
    "",
    "Answer as a short list, most valuable first, one line per finding; skip a section with nothing worth saying. Do not comment on this review itself.",
  );
  return lines.join("\n");
}

export interface PerformanceOptions {
  piCli: string;
  /** The session's jsonl file; only read. */
  file: string;
  model?: string;
  cwd?: string;
  timeoutMs?: number;
  capBytes?: number;
}

export async function runPerformance(opts: PerformanceOptions): Promise<{ answer: string; truncated: boolean }> {
  const cap = opts.capBytes ?? TRANSCRIPT_CAP_BYTES;
  // one capping pass decides both what pi receives and whether entries were dropped
  const capped = capTranscript(fs.readFileSync(opts.file, "utf8"), cap);
  const answer = await sideRun({
    piCli: opts.piCli,
    file: opts.file,
    prompt: performancePrompt(capped.truncated),
    model: opts.model,
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs ?? PERFORMANCE_TIMEOUT_MS,
    prepare: () => capped.text,
  });
  return { answer, truncated: capped.truncated };
}

/** Where /performance reports are saved: one markdown file per report, like /btw's answers. */
export function performanceDir(env: NodeJS.ProcessEnv = process.env): string {
  const data = env.XDG_DATA_HOME ?? path.join(env.HOME ?? "", ".local", "share");
  return path.join(data, "toriel", "performance");
}

/** /performance reports save exactly like /btw answers, in their own dir with their own filename prefix. */
export function savePerformance(answer: string, dir = performanceDir(), now = new Date()): string {
  return saveBtw("performance review", answer, dir, now, "performance");
}
