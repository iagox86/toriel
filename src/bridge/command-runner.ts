// Doing a chat command (see `chat-commands.ts`): each one is a request the desktop controller sends the daemon too, so chat and the
// desktop cannot disagree about what `model` or `auto` mean. The bridge supplies what is chat-specific (saying something in the
// channel, asking a numbered question).
import { listing as taskListing } from "../../pi/extensions/lib/tasks.ts";
import { continuePrompt } from "../continue-prompt.ts";
import { INIT_PROMPT } from "../init-prompt.ts";
import { grantListing } from "../permission-format.ts";
import type { SessionMeta } from "../shared.ts";
import { errText } from "../util.ts";
import { fmtClock, fmtDuration } from "../when.ts";
import { CHAT_COMMANDS, type ChatCommand, chatCommandNamed, chatHelp, torielCommandNames } from "./chat-commands.ts";
import type { DaemonPort } from "./daemon-client.ts";

export interface CommandEnv {
  daemon: DaemonPort;
  /** The session of the channel the command was written in; undefined in the inbox. */
  meta: SessionMeta | undefined;
  /** Every session the daemon lists. */
  metas: SessionMeta[];
  say(text: string): Promise<void>;
  /** A numbered question with the first rows as number reactions; `onPick` gets the chosen row. */
  pick(title: string, rows: string[], onPick: (row: string) => Promise<void>): Promise<void>;
  /** Send the session a prompt as if the user had written it. */
  prompt(text: string): Promise<void>;
  /** The sessions (daemon numbers) with a `!!` shell command running, kept by the bridge. */
  shells: Set<number>;
}

/** The longest a `!!` command may run (the desktop's limit for `!`). */
const SHELL_TIMEOUT_MS = 11 * 60_000;

/** The longest reply posted in one piece. */
const MAX_REPLY = 7500;

const clip = (text: string): string => (text.length > MAX_REPLY ? `${text.slice(0, MAX_REPLY)}\n… (${text.length - MAX_REPLY} more characters; the desktop shows all)` : text);

function state(m: SessionMeta): string {
  if (m.pendingDialog) {
    return "waiting for you";
  }
  return m.streaming ? "working" : m.active && !m.dead ? "idle" : "stopped";
}

/** Run a command typed in chat. A command the registry does not have is answered, never passed on. */
export async function runChatCommand(cmd: ChatCommand, env: CommandEnv): Promise<void> {
  if (cmd.kind === "shell") {
    await runShell(cmd, env);
    return;
  }
  const def = chatCommandNamed(cmd.name);
  if (!def) {
    await env.say(
      torielCommandNames().has(cmd.name)
        ? `\`${cmd.name}\` needs the desktop: type \`/${cmd.name}\` in toriel. \`!help\` lists what chat can do.`
        : `\`${cmd.name}\` is not a command I know, and I never pass it to the agent.\n${chatHelp(Boolean(env.meta))}`,
    );
    return;
  }
  if (def.scope === "session" && !env.meta) {
    await env.say(`\`!${def.name}\` is for a session's channel: write it in the session you mean.`);
    return;
  }
  try {
    await RUN[def.name]?.(cmd.args, env);
  } catch (err) {
    await env.say(`⚠ \`${def.name}\` failed: ${errText(err)}`);
  }
}

/** The session's id in the daemon with a pi child running, starting a sleeping session first (as the desktop does). */
async function live(env: CommandEnv): Promise<number> {
  const meta = env.meta as SessionMeta;
  if (meta.active && !meta.dead) {
    return meta.id;
  }
  if (!meta.sessionFile) {
    throw new Error("the session has no file to start from");
  }
  const r = (await env.daemon.request({ type: "spawn", sessionFile: meta.sessionFile, cwd: meta.cwd, ready: true })) as { sessionId?: number };
  if (typeof r?.sessionId !== "number") {
    throw new Error("the session did not start");
  }
  await env.daemon.request({ type: "detach", session: r.sessionId }).catch(() => undefined); // the bridge only watches and prompts
  return r.sessionId;
}

/**
 * `!!command`: a shell command in the session's directory, the desktop's `!command` (the daemon runs it and tells the agent what it
 * printed). It runs without holding up the bridge's queue (a long command must not freeze every other chat), says what it printed
 * when it ends, and `!abort` stops it. There is no permission prompt, by Ron's decision: the token file is what protects it.
 */
async function runShell(cmd: ChatCommand, env: CommandEnv): Promise<void> {
  const m = env.meta;
  if (!m) {
    await env.say("`!!command` is for a session's channel: write it in the session you mean.");
    return;
  }
  const command = cmd.args;
  if (env.shells.has(m.id)) {
    await env.say("A `!!` command is already running here: `!abort` stops it.");
    return;
  }
  const session = await live(env);
  env.shells.add(session);
  env.shells.add(m.id);
  await env.say(`Running \`${command}\` (\`!abort\` stops it)…`);
  void env.daemon
    .request({ type: "bash", session, command }, SHELL_TIMEOUT_MS)
    .then(async (r) => {
      const res = r as { output?: string; exitCode?: number; cancelled?: boolean; truncated?: boolean } | undefined;
      const out = (res?.output ?? "").trimEnd();
      const status = res?.cancelled ? "stopped" : res?.exitCode === undefined ? "done" : res.exitCode === 0 ? "exit 0" : `exit ${res.exitCode}`;
      await env.say(`${status}${res?.truncated ? " (output cut)" : ""}${out ? `\n\`\`\`\n${clip(out.replaceAll("```", "ˋˋˋ"))}\n\`\`\`` : ""}`);
    })
    .catch((err: unknown) => env.say(`⚠ \`${command}\` failed: ${errText(err)}`))
    .catch(() => undefined)
    .finally(() => {
      env.shells.delete(session);
      env.shells.delete(m.id);
    });
}

const busy = (env: CommandEnv): boolean => Boolean(env.meta?.streaming);

type Run = (args: string, env: CommandEnv) => Promise<void>;

const RUN: Record<string, Run> = {
  help: async (_a, env) => env.say(chatHelp(Boolean(env.meta))),

  list: async (_a, env) => {
    const rows = env.metas.slice(0, 40).map((m) => `- **${m.sessionName ?? `(unnamed, ${m.cwd.split("/").pop()})`}** — ${state(m)}${m.published ? " · in chat" : ""}`);
    await env.say(rows.length === 0 ? "toriel has no sessions." : clip(`${env.metas.length} session${env.metas.length === 1 ? "" : "s"}:\n${rows.join("\n")}${env.metas.length > 40 ? `\n… and ${env.metas.length - 40} more` : ""}`));
  },

  status: async (_a, env) => {
    const m = env.meta as SessionMeta;
    const mode = m.plan ? "plan mode" : m.auto ? `auto mode${m.autoUntil !== undefined ? ` until ${fmtClock(m.autoUntil, new Date())}` : ""}` : "normal mode";
    await env.say([`**${m.sessionName ?? "(unnamed)"}** — ${state(m)}`, `- model: ${m.model}`, `- directory: ${m.cwd}`, `- ${mode}`, ...(m.tasks?.length ? [`- ${m.tasks.length} task${m.tasks.length === 1 ? "" : "s"} (!tasks)`] : [])].join("\n"));
  },

  abort: async (_a, env) => {
    const m = env.meta as SessionMeta;
    if (env.shells.has(m.id)) {
      await env.daemon.request({ type: "abort_bash", session: m.id });
      await env.say("Stopping the `!!` command.");
      return;
    }
    if (!m.active || m.dead || (!m.streaming && !m.pendingDialog)) {
      await env.say("Nothing is running in this session.");
      return;
    }
    await env.daemon.request({ type: "abort", session: m.id });
    await env.say("Interrupted.");
  },

  continue: async (args, env) => env.prompt(continuePrompt(args)),

  background: async (_a, env) => {
    const m = env.meta as SessionMeta;
    if (!m.active || m.dead || !m.streaming) {
      await env.say("Nothing is running here to move to the background.");
      return;
    }
    await env.daemon.request({ type: "background", session: m.id }); // pi says what moved, in the channel
  },

  name: async (args, env) => {
    const m = env.meta as SessionMeta;
    if (!args) {
      await env.say(m.sessionName ? `Name: ${m.sessionName}` : "This session has no name yet: `!name <new name>` gives it one.");
      return;
    }
    const taken = new Set(env.metas.filter((x) => x.id !== m.id).map((x) => (x.sessionName ?? "").toLowerCase()));
    let name = args;
    for (let n = 2; taken.has(name.toLowerCase()); n++) {
      name = `${args} ${n}`;
    }
    const r = (await env.daemon.request({ type: "rename", session: m.id, name })) as { name?: string } | undefined;
    await env.say(`Renamed to **${r?.name ?? name}**${name !== args ? " (the name was taken)" : ""}. The channel follows.`);
  },

  stop: async (_a, env) => {
    const m = env.meta as SessionMeta;
    if (!m.active || m.dead) {
      await env.say("The session is not running.");
    } else if (m.streaming || m.pendingDialog) {
      await env.say("It is working or waiting for you: `!abort` first.");
    } else {
      await env.daemon.request({ type: "deactivate", session: m.id });
      await env.say("Stopped. The next message starts it again.");
    }
  },

  reload: async (_a, env) => {
    if (busy(env)) {
      await env.say("It is working: `!abort` first.");
      return;
    }
    await env.daemon.request({ type: "reload", session: await live(env) });
    await env.say("Reloaded: extensions, skills and settings re-read.");
  },

  model: async (args, env) => {
    const id = await live(env);
    const r = (await env.daemon.request({ type: "model", session: id, ...(args && args !== "list" ? { query: args } : {}) })) as { current?: string; models?: string[]; model?: string };
    if (args && args !== "list") {
      await env.say(`Model: **${r.model}**`);
      return;
    }
    const models = r.models ?? [];
    if (args !== "list" && models.length > 0 && models.length <= 9) {
      await env.pick(`Model (now: ${r.current})`, models, async (row) => RUN.model(row, env));
    } else {
      await env.say(clip(`Model: **${r.current}**\n\`!model <words>\` switches to the one that matches.\n\n${models.map((x) => `${x === r.current ? "**" : ""}${x}${x === r.current ? "**" : ""}`).join("\n")}`));
    }
  },

  think: async (args, env) => {
    const id = await live(env);
    if (args) {
      const r = (await env.daemon.request({ type: "think", session: id, level: args })) as { level: string };
      await env.say(`Thinking level: **${r.level}**`);
      return;
    }
    const r = (await env.daemon.request({ type: "think", session: id })) as { current: string; levels: string[] };
    await env.pick(`Thinking level (now: ${r.current})`, r.levels.slice(0, 9), async (row) => RUN.think(row, env));
  },

  auto: async (args, env) => {
    const m = env.meta as SessionMeta;
    const words = args.split(/\s+/).filter(Boolean);
    const head = words[0]?.toLowerCase();
    if (head === "status") {
      await env.say(m.auto ? `Auto mode is **on**${m.autoUntil !== undefined ? ` until ${fmtClock(m.autoUntil, new Date())}` : ""}. \`!auto off\` ends it.` : "Auto mode is off. `!auto` turns it on.");
      return;
    }
    const on = head === "off" ? false : head ? true : undefined;
    const duration = head === "on" ? words.slice(1).join(" ") || undefined : head && head !== "off" ? words.join(" ") : undefined;
    await env.daemon.request({ type: "auto_mode", session: m.id, on, for: duration }); // the daemon says what happened in the transcript
  },

  plan: async (args, env) => {
    const m = env.meta as SessionMeta;
    const word = args.toLowerCase();
    if (word === "status") {
      await env.say(m.plan ? "Plan mode is **on**: the agent can only look until you approve its plan. `!plan off` ends it." : "Plan mode is off. `!plan` turns it on.");
    } else if (word !== "" && word !== "on" && word !== "off") {
      await env.say("`!plan` takes `on`, `off` or `status`.");
    } else {
      await env.daemon.request({ type: "plan_mode", session: m.id, on: word === "" ? undefined : word === "on" });
    }
  },

  "deny-after": async (args, env) => {
    const m = env.meta as SessionMeta;
    const r = (await env.daemon.request({ type: "deny_after", session: m.id, after: args || "status" })) as { ms?: number } | undefined;
    if (!args || args.toLowerCase() === "status") {
      await env.say(r?.ms === undefined ? "Deny-after is off: a permission prompt waits until you answer." : `Deny-after is **${fmtDuration(r.ms)}**: an unanswered permission prompt is denied after that.`);
    } else {
      await env.say(r?.ms === undefined ? "Deny-after is off." : `Deny-after is **${fmtDuration(r.ms)}**.`);
    }
  },

  tasks: async (_a, env) => {
    const m = env.meta as SessionMeta;
    await env.say(clip(`\`\`\`\n${taskListing(m.tasks ?? [], m.tasksStaleSince ? Date.now() - m.tasksStaleSince : 0).join("\n")}\n\`\`\``));
  },

  permissions: async (args, env) => {
    const m = env.meta as SessionMeta;
    const revoke = /^revoke(?:\s+(.*))?$/i.exec(args);
    type Grants = Parameters<typeof grantListing>[0];
    if (revoke) {
      const ref = (revoke[1] ?? "").trim();
      if (!ref) {
        await env.say("`!permissions revoke <#id>` (the id in `!permissions`) or `!permissions revoke all`.");
        return;
      }
      const all = ref.toLowerCase() === "all";
      const r = (await env.daemon.request({ type: "permission_revoke", session: m.id, ...(all ? { all: true } : { ref }) })) as { count: number };
      await env.say(r.count === 0 ? "No grants to revoke." : r.count === 1 ? "Revoked 1 grant." : `Revoked ${r.count} grants.`);
      return;
    }
    const r = (await env.daemon.request({ type: "permission_list", session: m.id })) as { grants: Grants };
    await env.say(r.grants.length === 0 ? "This session has no permission grants." : clip(`\`\`\`\n${grantListing(r.grants, new Date(), false)}\n\`\`\``));
  },

  mcp: async (_a, env) => {
    const r = (await env.daemon.request({ type: "mcp_status", session: await live(env) })) as { text: string };
    await env.say(clip(`\`\`\`\n${r.text}\n\`\`\``));
  },

  init: async (_a, env) => env.prompt(INIT_PROMPT),

  compact: async (args, env) => {
    if (busy(env)) {
      await env.say("It is working: `!abort` first.");
      return;
    }
    const id = await live(env);
    await env.say("Compacting…");
    const r = (await env.daemon.request({ type: "compact", session: id, instructions: args })) as { tokensBefore?: number; tokensAfter?: number } | undefined;
    await env.say(r?.tokensBefore !== undefined ? `Compacted: ${r.tokensBefore} → ${r.tokensAfter ?? "?"} tokens.` : "Compacted.");
  },

  clear: async (_a, env) => {
    if (busy(env)) {
      await env.say("It is working: `!abort` first.");
      return;
    }
    await env.daemon.request({ type: "clear", session: await live(env) });
    await env.say("Cleared: same session, empty conversation (the old contents are in the trash; `/restore` on the desktop brings them back).");
  },

  cd: async (args, env) => {
    const m = env.meta as SessionMeta;
    if (!args) {
      await env.say(`This session runs in \`${m.cwd}\`.`);
      return;
    }
    const r = (await env.daemon.request({ type: "cd", session: await live(env), dir: args })) as { cwd: string; changed: boolean };
    await env.say(r.changed ? `Moved to \`${r.cwd}\`: pi restarted there, the conversation is unchanged.` : `Already in \`${r.cwd}\`.`);
  },
};

// the registry and the table must agree (a test also checks it, but a missing handler would be a silent no-op)
for (const c of CHAT_COMMANDS) {
  if (!RUN[c.name]) {
    throw new Error(`chat command ${c.name} has no handler`);
  }
}
