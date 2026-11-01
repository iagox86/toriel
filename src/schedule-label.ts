// A fired schedule's prompt arrives in the session as an ordinary user message
// that begins with a fixed label, so the transcript can show it as scheduled
// (and nobody mistakes it for something typed). Same idea as received.ts.
const LABEL = /^\[scheduled #(\d+)(?: "([^"\n]*)")?, run (\d+)(?:\/(\d+))?(?:, late ([0-9a-z]+))?\]: ([\s\S]*)$/;

export interface ScheduledLabel {
  id: number;
  name?: string;
  run: number;
  max?: number;
  /** How late it fired, as a duration like "2h"; only set when it was noticeably late. */
  late?: string;
}

export function formatScheduled(label: ScheduledLabel, prompt: string): string {
  const name = label.name ? ` "${label.name.replace(/"/g, "'").replace(/[\r\n]+/g, " ")}"` : "";
  const of = label.max === undefined ? "" : `/${label.max}`;
  const late = label.late ? `, late ${label.late}` : "";
  return `[scheduled #${label.id}${name}, run ${label.run}${of}${late}]: ${prompt}`;
}

/** The label and prompt of a message written by `formatScheduled`, or undefined for anything else. */
export function parseScheduled(text: string): { label: ScheduledLabel; prompt: string } | undefined {
  const m = LABEL.exec(text);
  if (!m) {
    return undefined;
  }
  const label: ScheduledLabel = { id: Number(m[1]), run: Number(m[3]) };
  if (m[2]) {
    label.name = m[2];
  }
  if (m[4]) {
    label.max = Number(m[4]);
  }
  if (m[5]) {
    label.late = m[5];
  }
  return { label, prompt: m[6] as string };
}

/** How the transcript shows a scheduled prompt: a one-line header over the prompt. */
export function displayScheduled(text: string): string {
  const s = parseScheduled(text);
  if (!s) {
    return text;
  }
  const { label } = s;
  const head = `⏱ scheduled #${label.id}${label.name ? ` ${label.name}` : ""} (run ${label.run}${label.max === undefined ? "" : `/${label.max}`}${label.late ? `, late ${label.late}` : ""})`;
  return `${head}\n${s.prompt}`;
}
