// Text typed in chat that is a command, not a prompt: `/name ...` and `!name ...` (the same commands, either prefix). The agent never
// sees these (pi would run a `/skill` or a `!` itself, and a model asked to answer `/unknowncommand` starts guessing): the bridge
// answers them. This file is the parsing and the registry of what chat can do; `command-runner.ts` does it.
import { SESSION_COMMANDS, SWITCHER_COMMANDS } from "../commands.ts";

export type ChatCommand = { kind: "command" | "shell"; name: string; args: string };

/**
 * `/word`, `!word` (or `!!word`, a shell command) as the first word is a command. A path (`/etc/hosts is wrong`) is not: its first
 * word has a second slash. A `!` followed by a space or nothing (`! really?`, `!!!`) is ordinary text.
 */
export function parseChatCommand(text: string): ChatCommand | undefined {
  const m = /^(!!|[/!])([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m || (m[1] !== "/" && !/^[\w.-]/.test(m[2]))) {
    return undefined;
  }
  return { kind: m[1] === "!!" ? "shell" : "command", name: m[2].toLowerCase(), args: (m[3] ?? "").trim() };
}

/** Where a chat command works: in any channel, or only in a session's channel. */
export type Scope = "any" | "session";

/** What chat does for a command: the one-line help, the arguments it takes, and where it works. */
export interface ChatCommandDef {
  name: string;
  /** Other names for it (`rename` for `name`). */
  aliases?: string[];
  scope: Scope;
  usage?: string;
  help: string;
}

/**
 * The commands chat has. Each name is a toriel command of the same name (`commands.ts`), except the ones in CHAT_ONLY, which exist
 * only here; a test keeps the two lists honest. Everything else in toriel's lists is answered with "needs the desktop".
 */
export const CHAT_COMMANDS: ChatCommandDef[] = [
  { name: "help", scope: "any", help: "this list" },
  { name: "list", scope: "any", help: "the sessions toriel has, and what each is doing" },
  { name: "status", scope: "session", help: "this session: model, directory, mode, what it is doing" },
  { name: "abort", scope: "session", help: "interrupt the running agent" },
  { name: "continue", scope: "session", usage: "[text]", help: "tell the agent the interruption was a mistake, and go on" },
  { name: "background", scope: "session", help: "move the command the agent is waiting for to the background" },
  { name: "name", aliases: ["rename"], scope: "session", usage: "[new name]", help: "show or change this session's name" },
  { name: "stop", scope: "session", help: "stop the session's process (the file stays; the next message starts it again)" },
  { name: "reload", scope: "session", help: "restart pi on the same session: extensions, skills and settings re-read" },
  { name: "model", scope: "session", usage: "[words | list]", help: "show the model, or switch to the one the words match" },
  { name: "think", scope: "session", usage: "[level]", help: "show the thinking level, or set it" },
  { name: "auto", scope: "session", usage: "[on | off | status | <duration>]", help: "auto mode: the agent decides most permission prompts itself" },
  { name: "plan", scope: "session", usage: "[on | off | status]", help: "plan mode: the agent can only look until you approve its plan" },
  { name: "deny-after", scope: "session", usage: "[<duration> | off | status]", help: "deny a permission prompt nobody answered within this long" },
  { name: "tasks", scope: "session", help: "the agent's task list" },
  { name: "permissions", scope: "session", usage: "[revoke <#id> | revoke all]", help: "the permission grants this session has, and taking them back" },
  { name: "mcp", scope: "session", help: "the session's MCP servers and their state" },
  { name: "init", scope: "session", help: "ask the agent to write or update the project's AGENTS.md" },
  { name: "compact", scope: "session", usage: "[what to keep]", help: "summarise the conversation to free the context window" },
  { name: "clear", scope: "session", help: "empty the conversation (same session; the old contents go to the trash)" },
  { name: "cd", scope: "session", usage: "[directory]", help: "show the directory, or move the session to another one" },
];

/** In `CHAT_COMMANDS` but not a toriel command of that name. */
export const CHAT_ONLY = new Set(["list", "status"]);

const BY_NAME = new Map(CHAT_COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])].map((n) => [n, c] as const)));

export function chatCommandNamed(name: string): ChatCommandDef | undefined {
  return BY_NAME.get(name);
}

/** Every toriel command name (session and switcher lists): what `/name` could mean to someone used to the desktop. */
export function torielCommandNames(): Set<string> {
  return new Set([...SESSION_COMMANDS, ...SWITCHER_COMMANDS].map((c) => c.name));
}

/** `!help`: what chat can do here (a session's channel has more than the inbox), generated from the registry. */
export function chatHelp(inSession: boolean): string {
  const rows = CHAT_COMMANDS.filter((c) => inSession || c.scope === "any").map((c) => `- \`!${c.name}${c.usage ? ` ${c.usage}` : ""}\` ${c.help}`);
  return [
    "Commands I handle here (`/name` works as well as `!name`; nothing starting with `/` or `!` is ever sent to the agent):",
    ...rows,
    inSession ? "" : "A session's channel has more (`!model`, `!auto`, `!abort`, ...); `!help` there lists them.",
    "The rest of toriel's commands need the desktop. To send the agent a line that starts with a slash, put a word before it.",
  ]
    .filter(Boolean)
    .join("\n");
}
