// ask_user_question double numbering (ticket 245): the bundled ask-user-question dialog numbers its
// option rows itself, but its prompt guidelines never say so, so a model that writes "1. Solarized"
// labels shows the numbering doubled. This adds one guideline saying not to number labels, and as
// defence in depth strips a leading marker ("1. ", "1)", "- ") from every option label at the call.
// Runs only in children the toriel daemon starts (TORIEL_CHILD). A failure inside it never fails a
// tool call.
interface Question {
  options?: Array<{ label?: unknown }>;
}
interface Input {
  questions?: Question[];
}
interface ToolEvent {
  toolName?: unknown;
  input?: unknown;
}
interface Pi {
  on(event: "before_agent_start", handler: (event: { systemPromptOptions?: { promptGuidelines?: string[] } }) => undefined): void;
  on(event: "tool_call", handler: (event: ToolEvent) => undefined): void;
}

const GUIDELINE =
  'When using ask_user_question, never include numbering ("1. ", "1)", bullets) in option labels - the dialog numbers the rows itself; numbering in labels shows doubled.';

/** A leading numbering or bullet marker followed by whitespace: "1. ", "1)", "10)", "- ", "* ", "+ ". A label like "1.5 release" (no space after the marker) survives. */
const NUMBERING = /^\s*(\d+[.)]|[-*+])\s+/;

export function stripLabelNumbering(label: string): string {
  return label.replace(NUMBERING, "");
}

/** Strip a leading numbering marker from every option label, in place, and never throw. A label that is only a marker ("1. ") keeps its original text: pi rejects an empty label. */
export function stripInputNumbering(input: unknown): void {
  if (!input || typeof input !== "object") {
    return;
  }
  const questions = (input as Input).questions;
  if (!Array.isArray(questions)) {
    return;
  }
  for (const q of questions) {
    if (!q || !Array.isArray(q.options)) {
      continue;
    }
    for (const o of q.options) {
      if (o && typeof o.label === "string") {
        const stripped = stripLabelNumbering(o.label);
        if (stripped !== "") {
          o.label = stripped;
        }
      }
    }
  }
}

export default function main(pi: Pi): void {
  if (!process.env.TORIEL_CHILD) {
    return;
  }
  pi.on("before_agent_start", (event) => {
    try {
      const options = event.systemPromptOptions;
      if (options && Array.isArray(options.promptGuidelines) && !options.promptGuidelines.includes(GUIDELINE)) {
        options.promptGuidelines.push(GUIDELINE);
      }
    } catch {
      return undefined;
    }
    return undefined;
  });
  pi.on("tool_call", (event) => {
    try {
      if (event.toolName === "ask_user_question") {
        stripInputNumbering(event.input);
      }
    } catch {
      return undefined;
    }
    return undefined;
  });
}
