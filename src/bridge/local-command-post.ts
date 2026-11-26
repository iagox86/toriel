// How a `!command` result looks in chat: the command and what it printed, from the custom message's `details` (never the
// <local-command> text the model reads).
import { LOCAL_COMMAND_TYPE } from "../daemon-bridge.ts";
import { blockquote } from "./history.ts";

/** Longest output quoted in a channel; the desktop and the agent have all of it. */
const OUTPUT_CHARS = 500;

export interface LocalCommandDetails {
  command: string;
  output: string;
  exitCode?: number;
  cancelled: boolean;
}

/** The `details` of a `toriel-local-command` custom message (a pi message or an appended entry), or undefined for any other. */
export function localCommandOf(m: { customType?: string; details?: unknown } | undefined): LocalCommandDetails | undefined {
  if (m?.customType !== LOCAL_COMMAND_TYPE) {
    return undefined;
  }
  const d = m.details as { command?: unknown; output?: unknown; exitCode?: unknown; cancelled?: unknown } | undefined;
  if (typeof d?.command !== "string") {
    return undefined;
  }
  return {
    command: d.command,
    output: typeof d.output === "string" ? d.output : "",
    ...(typeof d.exitCode === "number" ? { exitCode: d.exitCode } : {}),
    cancelled: d.cancelled === true,
  };
}

/** The post for a `!command` result typed in toriel. */
export function localCommandPost(d: LocalCommandDetails): string {
  const status = d.cancelled ? "stopped" : d.exitCode === undefined ? "" : `exit ${d.exitCode}`;
  const out = d.output.trim().replaceAll("```", "ˋˋˋ");
  const body = out.length > OUTPUT_CHARS ? `${out.slice(0, OUTPUT_CHARS)}…` : out;
  const command = d.command.replace(/\s+/g, " ").trim().replaceAll("`", "ˋ");
  return blockquote(`**ran in toriel:** \`${command}\`${status ? ` (${status})` : ""}${body ? `\n\`\`\`\n${body}\n\`\`\`` : ""}`);
}
