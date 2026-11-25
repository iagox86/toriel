// Text typed in chat that is a command, not a prompt: `/name ...` and `!command`. The agent never sees these (pi would try to
// run a `/skill` or a `!` itself, and a model asked to answer `/unknowncommand` starts guessing); the bridge answers them.

export type ChatCommand = { kind: "slash" | "bang"; name: string; args: string };

/**
 * `/word` or `!word` as the first word is a command. A path (`/etc/hosts is wrong`) is not: its first word has a second
 * slash. A `!` followed by a space or nothing (`! really?`, `!!!`) is ordinary text.
 */
export function parseChatCommand(text: string): ChatCommand | undefined {
  const m = /^([/!])([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m || (m[1] === "!" && !/^[\w.-]/.test(m[2]))) {
    return undefined;
  }
  return { kind: m[1] === "/" ? "slash" : "bang", name: m[2], args: (m[3] ?? "").trim() };
}

/** What chat can do, said by /help and by the reply to an unknown command. */
export const CHAT_HELP = [
  "Commands I handle here (nothing starting with `/` or `!` is ever sent to the agent):",
  "- `/abort` interrupt the running agent (in a session's channel)",
  "- `/help` this list",
  "Everything else is a toriel command: type it in toriel. To send the agent a line that starts with a slash, put a word before it.",
].join("\n");
