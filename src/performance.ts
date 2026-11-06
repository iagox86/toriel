// /performance: a throwaway analysis pass over this session's transcript.
// Reuses the /btw side run (a temp copy of the jsonl, `pi --print --no-tools`
// over it, SIGKILL on timeout): the session never sees the run, a sleeping
// session stays asleep, and the model has no tools, so it cannot read anything
// else (pi's auth and models files included).
import * as fs from "node:fs";
import * as path from "node:path";
import { saveBtw, sideRun } from "./btw.ts";

/** Transcripts longer than this (in bytes) are cut to their first whole lines before the run. */
export const TRANSCRIPT_CAP_BYTES = 1_048_576;

/** The analysis reads a whole transcript; longer than a /btw answer. */
export const PERFORMANCE_TIMEOUT_MS = 5 * 60_000;

/** Keeps the first whole lines within the byte budget; the result is always a valid prefix of the transcript. */
export function capTranscript(text: string, capBytes = TRANSCRIPT_CAP_BYTES): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= capBytes) {
    return { text, truncated: false };
  }
  let kept = "";
  let used = 0;
  for (const line of text.split("\n")) {
    const size = Buffer.byteLength(line) + 1; // the line plus its newline
    if (used + size > capBytes) {
      break;
    }
    kept += `${line}\n`;
    used += size;
  }
  return { text: kept, truncated: true };
}

/** The fixed review prompt; tells the model it is one-shot and toolless, and what to cover. */
export function performancePrompt(truncated: boolean, capBytes = TRANSCRIPT_CAP_BYTES): string {
  const lines = [
    "[performance review of this session - report from the conversation you have]",
    "You are reviewing the transcript of a coding-agent session to find what is slowing it down or costing more than it should. You have no tools here and cannot run, read or",
    "change anything, and the user cannot reply to this answer, so report in one go: no questions, no offers to do more.",
  ];
  if (truncated) {
    lines.push(`The transcript was truncated to its first ${capBytes} bytes; say where that matters and do not guess at what came after.`);
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
  // the utf8 byte size of the text is the file's byte size, so the stat decides
  const truncated = fs.statSync(opts.file).size > cap;
  const answer = await sideRun({
    piCli: opts.piCli,
    file: opts.file,
    prompt: performancePrompt(truncated, cap),
    model: opts.model,
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs ?? PERFORMANCE_TIMEOUT_MS,
    // below the cap this is the identity
    prepare: (text) => capTranscript(text, cap).text,
  });
  return { answer, truncated };
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
