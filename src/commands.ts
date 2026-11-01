// Command registries: the one place a /command is declared. A command is a
// name, a description and (optionally) a `build` that declares its options and
// arguments on a commander Command (see cli.ts); parsing, -h/--help and
// autocomplete hints all derive from that. A handler table keyed by name
// (`Record<SwitcherCommandName, ...>` in switcher-actions.ts, likewise in
// session-commands.ts) makes the compiler insist that every command here has
// a handler, so adding one is: an entry here, plus a function there.
// A session command that talks to a running pi child must also wake a sleeping
// session first (`liveMeta()` in session-commands.ts; see AGENTS.md).
import type { Command } from "commander";
import type { CommandSpec } from "./cli.ts";
import { agentCompletions } from "./agents-completion.ts";
import { matching } from "./completion.ts";
import { mcpCompletions } from "./mcp.ts";
import { permissionCompletions } from "./permission-commands.ts";

export type { CommandSpec };

const nameArgument = (verb: string) => (cmd: Command) => {
  cmd.argument("[name...]", `new name (leave out to ${verb})`);
};

/** The flags every schedule-creating command shares. `max` is left off for one-shots. */
const scheduleFlags = (opts: { max: boolean }) => (cmd: Command) => {
  cmd.option("-n, --name <name>", "a name to cancel it by (unique in the session)");
  if (opts.max) {
    cmd.option("--max <n>", "stop after this many runs");
  }
  if (opts.max) {
    cmd
      .option("--until <command>", "before each run, run this shell command (no model); it succeeding (exit 0) sends the prompt one last time and ends the schedule")
      .option("--while <command>", "before each run, run this shell command (no model); it failing ends the schedule quietly");
  }
  cmd
    .option("--expires <after>", 'end after this long, e.g. 3d or 12h, or "never" (default for repeating schedules: 7d)')
    .option("--catchup <mode>", '"once" (default) runs one late fire after the daemon was down, "skip" just carries on')
    .option("--dry-run", "show when it would run, create nothing");
};

const SCHEDULE_NOTE = "\nA scheduled prompt waits until the session is idle (it never interrupts a turn or a permission prompt), wakes a stopped session, and shows in the transcript as scheduled. Recurring schedules end after 7 days unless --expires says otherwise. Options go anywhere; put -- before text that itself starts with a dash. /schedules lists them, /cancel removes one.";

/** The /schedules and /cancel family act on a schedule named like this. */
const refArgument = (verb: string) => (cmd: Command) => {
  cmd.argument("[schedule]", `id (3 or #3) or name of the schedule to ${verb} (leave out to pick from a list)`).option("-a, --all", `${verb} every schedule (in this session; in the switcher, all of them)`);
};

/** /permissions is the same command in a session and in the switcher; only its scope differs (this session, or all of them). */
const permissionsSpec = (scope: "session" | "all") =>
  ({
    name: "permissions",
    description: scope === "session" ? "list, add and revoke this session's permission grants" : "list and revoke every session's permission grants",
    help: `Permission grants let something run without a prompt: the toriel daemon keeps them (they survive /reload and daemon restarts) and pi-permission-system consults them before it asks. They belong to one session and optionally expire. Pick "allow for 1 hour" in a permission prompt to make one, or add one here.\n\nActions:\n  list                      show the grants (the default)\n  add <surface> <pattern>   grant something; surfaces: bash, mcp, tool, skill. The pattern is what pi's prompt offers, e.g. bash "git status"\n  revoke [id|pattern]       take a grant away; with no argument, pick from a list\n  restore                   turn on grants saved before the daemon restarted (they stay off until you do)\n\nGrants cannot cover file-path requests (pi does not allow it) and are never made by an agent.\n\nExamples:\n  /permissions\n  /permissions add bash "git status" --for 1h\n  /permissions add mcp "exa:*" --session\n  /permissions revoke 3\n  /permissions revoke --all\n\nTo make agents' attempts to edit the grants file ask first, add a path rule for it (toriel's startup check prints the line).`,
    build: (cmd: Command) => {
      cmd.argument("[action]", "list (default), add, revoke or restore").argument("[words...]", "for add: the surface and pattern; for revoke: an id (3 or #3) or exact pattern");
      cmd.option("-a, --all", scope === "session" ? "list every session's grants; with revoke, remove every grant in this session" : "revoke: remove every grant in every session");
      if (scope === "session") {
        cmd.option("--for <time>", "add: how long it lasts, e.g. 30m, 1h, 8h (default: until revoked)").option("--session", "add: until revoked or the session is deleted (the default)").option("--note <text>", "add: a reminder of why");
      }
    },
    complete: (typed: string) => permissionCompletions(typed),
  }) satisfies CommandSpec;

/** /doctor is the same command in a session and in the switcher. */
const doctorSpec = {
  name: "doctor",
  description: "check the setup and say how to fix what is wrong (--fix applies the safe fixes)",
  help: "Lists what toriel needs, by how much it matters: required (toriel does not work without it), recommended (the permission package and its config), optional features (permission grants, the sleep lock) and hardening. Each problem says how to fix it by hand. --fix applies the ones that are safe to automate, which are edits to pi-permission-system's config.json: it shows the diff, asks, and keeps the original as config.json.bak-<time>. It never installs packages and never writes a policy of its own. The same report is `toriel doctor` in a shell (exit 1 when something required is wrong). Toriel also checks at start-up: required and recommended problems show in the notice line, with a count of the rest.\n\nExamples:\n  /doctor\n  /doctor --fix",
  build: (cmd: Command) => {
    cmd.option("--fix", "apply the safe fixes (shows a diff and asks first)");
  },
} satisfies CommandSpec;

/** Switcher command box. SwitcherActions must handle every name listed here. */
export const SWITCHER_COMMANDS = [
  {
    name: "new",
    description: "start a new session",
    help: "Starts an empty session and opens it. It runs in the directory toriel was started from unless -C says otherwise.\n\nExamples:\n  /new\n  /new -n \"Mealie import\" -C ~/projects/mealie\n  /new -a explore          (a read-only agent profile; see /agents)",
    build: (cmd) => {
      cmd
        .option("-n, --name <name>", "name for the new session")
        .option("-C, --cwd <dir>", "working directory for the new session (default: where toriel was started)")
        .option("-a, --agent <name>", "start it as an agent profile (see /agents; tab completes the name after -a)");
    },
    // flags are not completed in general; this one value is worth it
    complete: (typed, src) => agentCompletions(typed, src.agents()),
  },
  {
    name: "init",
    description: "start a new session that surveys the project and writes an AGENTS.md",
    help: "Starts a new session and opens it with the /init prompt already sent: the agent surveys the project and writes AGENTS.md (or updates the one that exists, folding in CLAUDE.md and other agent-instruction files). It runs in the directory toriel was started from unless -C says otherwise. Inside a session, /init sends the same prompt to that session instead.\n\nExamples:\n  /init\n  /init -C ~/projects/mealie",
    build: (cmd) => {
      cmd
        .option("-n, --name <name>", "name for the new session (default: init <directory>)")
        .option("-C, --cwd <dir>", "directory to initialize (default: where toriel was started)");
    },
  },
  { name: "agents", description: "list the agent profiles (/new --agent <name> starts one) and any problems loading them",
    help: "Agent profiles are markdown files (agents/ in the toriel repo, ~/.config/toriel/agents/, <project>/.toriel/agents/). A broken file is listed under Problems and the rest still load. Format: agents/README.md." },
  {
    name: "schedules",
    description: "list every scheduled prompt in every session, with its next run",
    help: "Shows all schedules (id, session, what it does, next real run, runs so far, expiry, prompt). Paused ones and delivery failures are marked. Inside a session the same command lists just that session's, and /in /at /every /loop /cron create them there.\nManage with /cancel, /pause and /resume (any id; a name works when it is unique).",
  },
  { name: "cancel", description: "remove a scheduled prompt by id or name, or all of them (--all)",
    help: "Removes a schedule by id (see /schedules). A name works when only one schedule has it. --all removes every schedule in every session.\n\nExamples:\n  /cancel 3\n  /cancel --all", build: refArgument("cancel") },
  { name: "pause", description: "pause a scheduled prompt without removing it",
    help: "A paused schedule keeps its settings but does not run; /resume picks up from the next slot.\n\nExample: /pause 3", build: refArgument("pause") },
  { name: "resume", description: "resume a paused scheduled prompt",
    help: "Resumes a paused schedule at its next slot. Also clears one that paused itself after failing to deliver.\n\nExample: /resume 3", build: refArgument("resume") },
  permissionsSpec("all"),
  doctorSpec,
  { name: "stop", needsSession: true, description: "stop the highlighted session's process (file kept; respawns on next prompt)",
    help: "Stops the highlighted session's pi process but keeps its file; the next message (or /reload, /model, !command) starts it again. Use it to free memory or MCP servers." },
  {
    name: "delete", needsSession: true,
    description: "move the highlighted session to trash (asks twice; stops it if running)",
    help: "Moves the session file to toriel's trash; /restore brings it back. Without -y you press ctrl-x (or enter the command) a second time to confirm. A running session is stopped first. Sessions nested under it stay.",
    build: (cmd) => {
      cmd.option("-y, --yes", "skip the confirmation");
    },
  },
  { name: "rename", needsSession: true, description: "rename the highlighted session",
    help: "Names the highlighted session. Names are kept unique: a taken name gets ' #2'. With no name the current one is put in the box to edit.", build: nameArgument("edit the current name") },
  {
    name: "group", needsSession: true,
    description: "move the highlighted session to a group",
    help: "Groups are the headers in the list. The group is created if it does not exist; with no name the current group is put in the box. Tab completes existing groups. shift+up/down also moves a session between groups.",
    complete: (typed, src) => matching(src.groups(), typed),
    build: (cmd) => {
      cmd.argument("[group...]", "group name, created if new (leave out to edit)");
    },
  },
  {
    name: "park", needsSession: true,
    description: "park the highlighted session: shown in the oldest colour until you use it again",
    help: "Parking is a marker, not a state: the session is drawn in the oldest colour until you use it again. A parked subagent is hidden under its parent (/filter shows it).\n\nExample: /park -u   (unpark)",
    build: (cmd) => {
      cmd.option("-u, --undo", "unpark it");
    },
  },
  { name: "detach", needsSession: true, description: "cut the highlighted subagent loose from the agent that started it (it becomes a top-level session)",
    help: "Removes the parent link of a session an agent started, in both directions, so it becomes an ordinary top-level session. Does nothing for sessions without such a link (copies made with /fork or /adopt are never nested)." },
  { name: "ungroup", needsSession: true, description: "take the highlighted session out of its group",
    help: "Takes the session out of its group (it goes to the ungrouped list at the top)." },
  {
    name: "summarize",
    description: "write a one-line summary of the highlighted session into the Summary column",
    help: "Asks a small model for a one-line summary of the transcript and stores it for the Summary column. The model defaults to summaryModel in the toriel settings, else litellm/gemma4:12b. toriel also refreshes summaries by itself while it is open.\n\nExamples:\n  /summarize\n  /summarize --all -c 1500 -m litellm/gemma4:12b",
    build: (cmd) => {
      cmd
        .option("-m, --model <model>", "model to summarize with, provider/id (default: summaryModel in settings, else litellm/gemma4:12b)")
        .option("-c, --chars <n>", "most transcript characters to send (default 2500; smaller suits small models)", Number)
        .option("--all", "summarize every session that has no summary or a stale one, one after another");
    },
  },
  {
    name: "comment", needsSession: true,
    description: "keep a note to yourself about the highlighted session (hidden, but found by the filter)",
    help: "Stores a longer note about why the session exists and where it stands. It is not drawn in the list; /filter and ctrl-f search it. With no text the current comment is put in the box to edit; /comment -c removes it.\n\nExamples:\n  /comment waiting on the vendor, retry the import after friday\n  /comment -c",
    build: (cmd) => {
      cmd.option("-c, --clear", "remove the comment").argument("[text...]", "the note (leave out to edit the current one)");
    },
  },
  {
    name: "filter",
    description: "show only matching sessions until cleared (no text clears; ctrl-f filters as you type)",
    help: "Narrows the list until cleared; folds are ignored while a filter is on, and parked subagents show again. Run /filter with no text, or press esc, to clear.\n\nExamples:\n  /filter mealie\n  /filter -r \"mealie|freecad\"",
    build: (cmd) => {
      cmd
        .option("-r, --regex", "treat the text as one case-insensitive regular expression")
        .argument("[text...]", "every word must appear in the name, summary, group, model or directory");
    },
  },
  {
    name: "feedback",
    description: "record a note about a harness or extension problem, with this session and turn attached, for later investigation",
    help: "Saves a note (with this session and the last turn attached) to toriel's feedback log so a harness or extension problem can be looked at later. -l lists recent notes.\n\nExample: /feedback -c tool-quirk the grep tool ignored my path",
    build: (cmd) => {
      cmd
        .option("-c, --category <name>", "short tag, e.g. tool-quirk, ui, extension")
        .option("-l, --list", "show the recent notes instead of adding one")
        .argument("[text...]", "what went wrong");
    },
  },
  { name: "adopt", needsSession: true, description: "fork an external session into toriel",
    help: "Forks a session that is open in a plain pi process into toriel (pi keeps its own copy). The fork is an ordinary session. Needs the session to have been saved by pi at least once." },
  {
    name: "restore",
    description: "bring back a deleted session from the trash (pick from a list)",
    help: "Lists sessions in the trash (name, age, size, directory). Type words to narrow the list; if one matches it is restored directly, with its group and summary.",
    build: (cmd) => {
      cmd.argument("[query...]", "words that narrow the list; a single match is restored straight away");
    },
  },
  { name: "kill-daemon", description: "stop the daemon and every session it owns",
    help: "Stops the daemon and every pi session it runs, ending any work in progress. Sessions can be resumed afterwards: their files are kept. Use /exit to leave toriel without stopping anything." },
  {
    name: "mouse",
    description: "show or set toriel's mouse handling: on, off or toggle (off: the terminal does select, copy and middle-click paste)",
    help: "With no argument says whether toriel has the mouse. Off hands the mouse back to the terminal: native select, copy and middle-click paste (also over ssh, where toriel cannot read your clipboard), at the cost of toriel's clicks (switcher rows, double-click on blocks), its own selection highlight and, in some terminals, wheel scrolling. On restores it. Not remembered across restarts. For one click only, hold shift instead.\n\nExamples:\n  /mouse\n  /mouse off\n  /mouse on\n  /mouse toggle",
    complete: (typed) => ["on", "off", "toggle"].filter((w) => w.startsWith(typed.trim().toLowerCase())),
    build: (cmd) => {
      cmd.argument("[state]", "on, off or toggle; leave out to show the current state");
    },
  },
  { name: "help", description: "list commands",
    help: "Lists toriel's own commands. <command> --help describes one. Anything else typed with a leading / goes to pi (skills, prompt templates, extension commands)." },
  { name: "exit", description: "leave toriel (sessions keep running)",
    help: "Closes toriel only. The daemon and every running session keep going; start toriel again to reattach." },
  { name: "quit", description: "leave toriel (sessions keep running)",
    help: "Same as /exit: closes toriel only; the daemon and every running session keep going." },
] as const satisfies readonly CommandSpec[];

export type SwitcherCommandName = (typeof SWITCHER_COMMANDS)[number]["name"];

/** Handled by toriel inside a session; everything else goes to pi. */
export const SESSION_COMMANDS = [
  {
    name: "btw",
    description: "ask a side question about this session; the answer pops up and the session never sees it",
    help: "Asks a copy of this session (it has read the whole conversation but has no tools) one question in the background, so you can keep working. The answer opens in a panel: c copies it, s saves it to a file, any other key closes. Nothing is added to the session and its own model is not interrupted. Uses the session's model unless -m is given.\n\nExamples:\n  /btw why did you choose sqlite over a json file?\n  /btw -m litellm/gemma4:12b what is left to do?",
    build: (cmd) => {
      cmd
        .option("-m, --model <model>", "model to ask, provider/id (default: this session's model)")
        .argument("<question...>", "the question");
    },
  },
  {
    name: "comment",
    description: "keep a note to yourself about this session (hidden, but found by the switcher filter)",
    help: "Stores a longer note about why the session exists and where it stands. It is not drawn in the list; the switcher's /filter and ctrl-f search it. With no text the current comment is shown; /comment -c removes it.\n\nExamples:\n  /comment waiting on the vendor, retry the import after friday\n  /comment -c",
    build: (cmd) => {
      cmd.option("-c, --clear", "remove the comment").argument("[text...]", "the note (leave out to show the current one)");
    },
  },
  {
    name: "mouse",
    description: "show or set toriel's mouse handling: on, off or toggle (off: the terminal does select, copy and middle-click paste)",
    help: "With no argument says whether toriel has the mouse. Off hands the mouse back to the terminal: native select, copy and middle-click paste (also over ssh, where toriel cannot read your clipboard), at the cost of toriel's clicks (switcher rows, double-click on blocks), its own selection highlight and, in some terminals, wheel scrolling. On restores it. Not remembered across restarts. For one click only, hold shift instead.\n\nExamples:\n  /mouse\n  /mouse off\n  /mouse on\n  /mouse toggle",
    complete: (typed) => ["on", "off", "toggle"].filter((w) => w.startsWith(typed.trim().toLowerCase())),
    build: (cmd) => {
      cmd.argument("[state]", "on, off or toggle; leave out to show the current state");
    },
  },
  { name: "exit", description: "leave toriel (sessions keep running)",
    help: "Closes toriel only. The daemon and every running session keep going; start toriel again to reattach." },
  { name: "quit", description: "back to the session list",
    help: "Goes back to the list without stopping this session (use /park to also stop it)." },
  {
    name: "park",
    description: "park this session (oldest colour in the switcher until used again), stop it if idle, and go back to the list",
    help: "Marks the session parked (oldest colour in the list; hidden if it is a subagent), stops it if it is idle, and goes back to the list. Using it again unparks it.",
  },
  {
    name: "help",
    description: "list toriel's commands for a session",
    help: "<command> --help describes one. Anything else typed with a leading / goes to pi (skills, prompt templates, extension commands).",
  },
  {
    name: "in",
    description: "send a prompt to this session once, after a delay (/in 90m check the build)",
    help: `Runs the prompt once, after the delay: 90m, 2h, 1h30m, "45 minutes".\n\nExamples:\n  /in 90m check whether the migration finished\n  /in 10m --name nudge remind me to push${SCHEDULE_NOTE}`,
    build: (cmd) => {
      scheduleFlags({ max: false })(cmd);
      cmd.argument("<delay>", "how long to wait, e.g. 90m").argument("<prompt...>", "what to send");
    },
  },
  {
    name: "at",
    description: "send a prompt to this session once, at a clock time (/at 14:30 ..., /at tomorrow 9am ...)",
    help: `Runs the prompt once at a local clock time: 14:30, 9am, noon, midnight, optionally with a day (today, tomorrow, mon..sun, or 2026-12-25). A time that already passed today means tomorrow, and it says so. A bare "5" is refused as ambiguous: write 5pm or 17:00.\n\nExamples:\n  /at 17:00 summarize what changed today\n  /at tomorrow 9am look at the failing CI run\n  /at fri 16:30 --name wrapup write the weekly notes${SCHEDULE_NOTE}`,
    build: (cmd) => {
      scheduleFlags({ max: false })(cmd);
      cmd.argument("<time>", "clock time, optionally after a day: 14:30, tomorrow 9am").argument("<prompt...>", "what to send");
    },
  },
  {
    name: "every",
    description: "send a prompt to this session repeatedly (/every 30m ..., /every weekday 9am ...)",
    help: `Repeats the prompt on a fixed cadence counted from now: every 30m, 2h, hour. Or at a time of day: day, weekday, weekend or a weekday name, then a time. The first run is one period away (use /fire to run it now). A run that cannot start because the session is busy is skipped, never stacked. For cron syntax use /cron.\n\nExamples:\n  /every 30m check whether the build is green\n  /every weekday 9am summarize overnight changes\n  /every 2h --max 6 --name poll see if the deploy finished\n  /every 5m --until "test -f dist/app.js" the build exists, run the smoke tests (checks cost no tokens)${SCHEDULE_NOTE}`,
    build: (cmd) => {
      scheduleFlags({ max: true })(cmd);
      cmd.argument("<interval>", "30m, 2h, hour, or a day and time: weekday 9am").argument("<prompt...>", "what to send");
    },
  },
  {
    name: "loop",
    description: "run a prompt now and again after each run finishes (/loop 5m ...)",
    help: `Runs the prompt right away, then again once the gap has passed after each run finishes, so runs never overlap. With no gap the agent paces itself: after each run it decides when to look again (it is told how to schedule the next one with toriel_schedule_create, and the loop ends when it does not). --until/--while need a gap.\n\nExamples:\n  /loop 5m check the deploy and report when it is done\n  /loop keep fixing the failing tests; tell me when they pass${SCHEDULE_NOTE}`,
    build: (cmd) => {
      scheduleFlags({ max: true })(cmd);
      cmd.argument("[gap-and-prompt...]", "an optional pause between runs (5m), then what to run; with no gap the agent chooses");
    },
  },
  {
    name: "cron",
    description: "send a prompt on a cron schedule (/cron \"0 9 * * 1-5\" ...)",
    help: `Five fields (minute hour day-of-month month day-of-week) in local time, quoted or not. The next run time it prints is the real one.\n\nExamples:\n  /cron "*/15 * * * *" check the queue\n  /cron 0 9 * * 1-5 morning summary${SCHEDULE_NOTE}`,
    build: (cmd) => {
      scheduleFlags({ max: true })(cmd);
      cmd.argument("<expression>", 'five cron fields, quoted: "0 9 * * 1-5"').argument("<prompt...>", "what to send");
    },
  },
  {
    name: "schedules",
    description: "list this session's scheduled prompts with their next run",
    help: "Shows each schedule: id, what it does, the next real run time, how many runs so far, when it expires, and the prompt. Paused ones and failures are marked. In the switcher it lists every session's schedules.\n\nExamples:\n  /schedules\n  /schedules --all       (every session's)\nManage them with /cancel, /pause, /resume and /fire.",
    build: (cmd) => {
      cmd.option("-a, --all", "every session's schedules, not just this one's");
    },
  },
  { name: "cancel", description: "remove a scheduled prompt (/cancel 3, /cancel nightly, /cancel --all)",
    help: "Removes a schedule by id or name. --all removes every schedule of this session. Deleting a session removes its schedules too.\n\nExamples:\n  /cancel 3\n  /cancel poll\n  /cancel --all", build: refArgument("cancel") },
  { name: "pause", description: "pause a scheduled prompt without removing it",
    help: "A paused schedule keeps its settings but does not run; /resume picks up from the next slot.\n\nExample: /pause 3", build: refArgument("pause") },
  { name: "resume", description: "resume a paused scheduled prompt",
    help: "Resumes a paused schedule at its next slot (a one-shot whose time passed while paused runs now). Also clears a schedule that paused itself after failing to deliver.\n\nExample: /resume 3", build: refArgument("resume") },
  {
    name: "fire",
    description: "run a scheduled prompt now, without changing its schedule",
    help: "Sends the schedule's prompt immediately and counts it as a run; the next scheduled run is unchanged. Refused while the session is busy.\n\nExample: /fire 3",
    build: (cmd) => {
      cmd.argument("<schedule>", "id (3 or #3) or name");
    },
  },
  permissionsSpec("session"),
  doctorSpec,
  { name: "abort", description: "interrupt the running agent",
    help: "Interrupts the agent's current turn, like esc. Messages still queued come back into the box." },
  { name: "detach", description: "cut this subagent loose from the agent that started it (no more banner or nesting)",
    help: "Removes the parent link of this session when an agent started it, so it stops being nested and the banner goes. Does nothing for copies made with /fork or /adopt, which are never nested." },
  { name: "parent", description: "jump to the agent that started this subagent",
    help: "Opens the agent that started this subagent. Says so when this session was not started by an agent." },
  { name: "name", description: "rename this session",
    help: "Shows the session's name and id when called with no name; with a name it renames the session (kept unique: a taken name gets ' #2').\n\nExample: /name Mealie import", build: nameArgument("show the current name") },
  { name: "rename", description: "rename this session (same as /name)",
    help: "Same as /name: renames this session (kept unique: a taken name gets ' #2'); with no name it shows the current name and id.", build: nameArgument("show the current name") },
  { name: "reload", description: "restart pi on this session to pick up new extensions and settings",
    help: "Restarts pi on this session's file so new extensions, skills, prompt templates and settings are read. Refused while the agent is working (abort it first). A sleeping session is simply started (which loads everything fresh)." },
  {
    name: "model",
    description: "pick a model from a list, or switch to the one matching the words given",
    help: "With no words opens a picker; with words switches to the one model whose provider/id contains all of them (an error lists the candidates if several do). The session's own model is kept across restarts.\n\nExamples:\n  /model\n  /model -l\n  /model glm flash",
    complete: async (typed, src) => matching(await src.models(), typed),
    build: (cmd) => {
      cmd.option("-l, --list", "just show every available model, without the picker").argument("[query...]", "words that must all appear in provider/model (leave out to pick from a list)");
    },
  },
  {
    name: "think",
    description: "pick the model's thinking level from a list, or set the one given (tab completes)",
    help: "With no level opens a picker of the levels this model supports; with a level switches to it - an unambiguous prefix works (an error lists the candidates if several match). Levels come from pi over RPC, so they follow the session's model.\n\nExamples:\n  /think\n  /think -l\n  /think high",
    complete: async (typed, src) => matching(await src.thinkingLevels(), typed),
    build: (cmd) => {
      cmd.option("-l, --list", "just show the current level and the available ones, without the picker").argument("[level]", "thinking level to set; leave out to pick from a list");
    },
  },
  {
    name: "mcp",
    description: "list the MCP servers and their states, troubleshoot, add or remove one, or reconnect / sign in to / sign out of one, or have the agent write a skill for one (tab completes names)",
    help: "Actions:\n  list                  every MCP server with its state and its skill on one line (the skill is a skills/ dir or SKILL.md naming the server in the pi agent dir; \"no matching skill (/mcp explore <server>)\" otherwise)\n  status [server]       troubleshoot: each server's state and error text, how it is configured (secrets hidden), whether its command is installed or its URL answers, and what to try. Checks every server that is not connected, or the one named\n  explore <server>      the agent introspects that server (every tool with its full parameter schema, resources) and writes a pi-format skill for it: SKILL.md in a subdirectory of the pi agent dir's skills/ (updates one if it already exists); says so instead when the server is not a configured mcp.json server, or is not connected (then it suggests /mcp reconnect)\n  add <name> <target>   write a server into pi's mcp.json and reload; <target> is a URL or a command with its arguments\n  remove <server>       take a server out of pi's mcp.json and reload (its saved sign-in is kept; other open sessions keep it until reloaded)\n  reconnect [server]    reconnect a server (tab completes names; leave out to pick)\n  login / logout [server]   OAuth sign in or out\nAll enabled servers connect when a session starts; a new server needs this session reloaded (add does that).\n\nExamples:\n  /mcp\n  /mcp add docs https://example.com/mcp\n  /mcp add mealie -- podman run -i --rm ghcr.io/example/mealie-mcp\n  /mcp status\n  /mcp status freecad\n  /mcp explore freecad\n  /mcp remove docs\n  /mcp reconnect freecad",
    complete: async (typed, src) => mcpCompletions(typed, await src.mcpServers()),
    build: (cmd) => {
      cmd
        .argument("[action]", "list (default), status, explore, add, remove, reconnect, login or logout")
        .argument("[server]", "which server (for add, the name to give it); leave out to be asked for reconnect / login / logout (status: all); remove and explore need it")
        .argument("[target...]", "for add: a URL, or a command and its arguments; put -- before arguments that start with -");
    },
  },
  {
    name: "fork",
    description: "continue in a copy of this session, listed right below it",
    help: "Makes a copy of this session's file and continues in the copy; the original is untouched. The copy knows it is a fork, but is an ordinary session in the list (not nested). With a prompt the copy starts working on it at once.\n\nExamples:\n  /fork\n  /fork -n \"Try the other approach\" --no-switch\n  /fork -- -v is the flag I meant",
    build: (cmd) => {
      cmd
        .option("-n, --name <name>", "name for the copy (default: a fork mark plus this session's name)")
        .option("--no-switch", "stay in this session instead of entering the copy")
        .argument("[prompt...]", "first message for the copy; put -- before one that starts with -");
    },
  },
  {
    name: "feedback",
    description: "record a note about a harness or extension problem, with this session and turn attached, for later investigation",
    help: "Saves a note (with this session and the last turn attached) to toriel's feedback log. -l lists recent notes.\n\nExample: /feedback -c ui the popup covers the input",
    build: (cmd) => {
      cmd
        .option("-c, --category <name>", "short tag, e.g. tool-quirk, ui, extension")
        .option("-l, --list", "show the recent notes instead of adding one")
        .argument("[text...]", "what went wrong");
    },
  },
  {
    name: "why",
    description: "explain the last thinking block in a sentence or two, using the cheap summary model (the session's model is not involved)",
    help: "Asks the cheap summary model (not this session's) to explain the last thinking block in a sentence or two; nothing is added to the conversation.",
    build: (cmd) => {
      cmd.option("-m, --model <model>", "model to explain with (default: the summary model)");
    },
  },
  {
    name: "init",
    description: "have the agent survey the project and write an AGENTS.md (what it is, layout, conventions); updates one that exists and folds in CLAUDE.md and other agent-instruction files",
    help: "Sends the agent a prompt to survey the project and write AGENTS.md, or update the one that exists, folding in CLAUDE.md and other agent-instruction files. The agent does the scanning with its normal tools.",
  },
  { name: "clear", description: "wipe this session's conversation and start over (same name and model; old contents go to trash)",
    help: "Empties the conversation but keeps the session, its name and model. The old contents go to trash; esc esc offers to undo it." },
  {
    name: "compact",
    description: "summarize older context to free up the window",
    help: "Summarizes older context to free up the window. Messages you send meanwhile are held and delivered after. The focus text tells the summary what to keep.\n\nExample: /compact keep the schema decisions and the open questions",
    build: (cmd) => {
      cmd.argument("[focus...]", "what the summary should keep");
    },
  },
] as const satisfies readonly CommandSpec[];

export type SessionCommandName = (typeof SESSION_COMMANDS)[number]["name"];
