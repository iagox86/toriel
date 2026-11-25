// Wire protocol between the daemon and controllers: JSONL over a unix socket.
import type { Todo } from "../pi/extensions/lib/tasks.ts";
// Framing is LF-only (never readline: U+2028/U+2029 are legal inside JSON strings).
//
// Model: the daemon tracks SESSIONS; a session may have a live child process
// (active: streaming or idle) or not (inactive: file only, lazily respawned).
// A live session's input is exclusively attached to one controller socket;
// every connected controller still sees the full event stream (viewing is
// never exclusive).

/**
 * Bumped by hand when the message set or a message shape changes in a way an
 * older daemon or controller cannot cope with. A mismatch blocks the controller
 * (see version-check.ts); a mere code difference with the same protocol only warns.
 */
/** How the durable notice for a prompt a grant answered begins; a controller attaches such a notice to the tool call it allowed (ticket 205). */
export const GRANT_ANSWERED_NOTICE = "allowed by permission grant";
/**
 * Why pi is asking, as the grants link read it from the package's own policy (ticket 213): `explicit` when a rule the user wrote
 * (or a package safety floor) asks about this, not the catch-all default. Auto mode leaves an explicit ask to the user; an ask
 * with no report at all is left to the user too, so an older link fails closed.
 */
export interface AskRule {
  explicit: boolean;
  /** The pattern of the rule that asks (`git *`), when there is one. */
  pattern?: string;
  /** Which config scope or mechanism contributed it ("global", "project", "agent", "fail-closed", "builtin", ...). */
  origin?: string;
}

/** The same for a prompt auto mode answered (ticket 213). */
export const AUTO_ANSWERED_NOTICE = "allowed by auto mode";
/** The prefix of the durable notice for a prompt the daemon denied because nobody answered it in time (ticket 88). */
export const AUTO_DENIED_NOTICE = "denied automatically";
/** The notice for a question nobody answered in time (deny-after), dismissed as if cancelled. */
export const AUTO_DISMISSED_NOTICE = "dismissed automatically";

export const PROTOCOL = 17; // 17: observe_dialogs, the ui_resolved message, and the optional `source` of ui_response and prompt (any controller can watch and answer a dialog, the first answer wins, ticket 270); 16: the publish command and SessionMeta.published/chatUp (a session shown in chat, ticket 269); 15: auto_mode/plan_mode's optional `quiet` and the mode_notice command (the shift+tab cycle announces only the mode it settles on, ticket 236); 14: spawn's optional `model` (a new session starts on that model, /new -m, ticket 247); 13: the feedback_snapshot command (the daemon's state for a /feedback bundle, ticket 239); 12: the plan_mode command and SessionMeta.plan/tasks (a read-only session until the user approves a plan, ticket 229; the agent's task list, ticket 228); 11: the deny_after command (deny a permission prompt nobody answers in time, ticket 88); 10: the auto_mode command and SessionMeta.auto/autoUntil (a session that allows its permission prompts except the sketchy ones, ticket 213); 9: watch_add's optional `by` ("agent": a file trigger an agent made through toriel_watch_create, held to the agent limits); 8: permission_check's optional `probe` (answer from the grants without remembering a suggestion for a dialog; the reply says `expiresAt`), for the toriel_permission_check tool; 7: spawn's optional `wake` (start a sleeping session because the user typed a command into it; answers `woke: false` with a reason instead of starting a file another pi may have open); 6: 6: rename and adopt answer with the applied `name` and `nameVerified` (the daemon makes names unique); 5: file-path prompts carry grant rows, and permission_add's `dialog` (4: the watch_add command (file-trigger schedules); 3: agent_spawn's optional cwd; 2: the `cd` command and adopt's `keepPermissions`)

/** Which toriel code a process runs (build-id.ts). */
export interface BuildInfo {
  /** Hash of the source; the only thing compared. */
  fingerprint: string;
  /** For people: git short hash (+dirty), else the fingerprint. */
  label: string;
  /** The checkout the code was loaded from. */
  dir: string;
}

/** One quota window of a provider account, e.g. z.ai's rolling 5h. */
export interface UsageWindow {
  label: string;
  /** Percent of the window used, 0-100. */
  pct: number;
  /** When the window resets (ms since epoch). */
  resetsAt?: number;
}

/**
 * An account's usage as reported by whatever can see it (a pi extension for pi
 * providers; a Claude Code adapter later). Backend-neutral on purpose: the
 * daemon keeps the newest report per provider, and the status bar only needs
 * windows and/or a spend figure.
 */
export interface UsageReport {
  v: 1;
  provider: string;
  /** Which adapter produced it ("zai", "litellm", later "claude-code"). */
  source: string;
  plan?: string;
  windows: UsageWindow[];
  spend?: { used: number; max?: number; resetsAt?: number };
  /** When it was fetched (ms since epoch). */
  at: number;
}

export interface SessionMeta {
  /** Daemon-assigned short id, stable for the daemon's lifetime. */
  id: number;
  cwd: string;
  /** Explicit session name; undefined until the session has been named. */
  sessionName?: string;
  model: string;
  /** Session UUID (from the session file header), when known. */
  sessionId?: string;
  /** Absolute path of the session file, when known. */
  sessionFile?: string;
  messageCount: number;
  streaming: boolean;
  /** A compaction is running (pi's compaction_start/end). */
  compacting: boolean;
  /** Child crashed or exited unexpectedly; session can be respawned. */
  dead: boolean;
  /** False when the child has been deactivated (session is file-only). */
  active: boolean;
  pendingDialog: boolean;
  /** The session is published to chat (ticket 269), and whether the chat bridge is connected right now (set only on a published session). */
  published?: boolean;
  chatUp?: boolean;
  /** toriel settings-file mtime this child started with (null = no file); undefined when inactive. */
  settingsMtime?: number | null;
  /** Problems the settings file had when this child started. */
  settingsProblem?: string;
  /** The session file is open in an external pi process (presence ext). */
  externallyLive?: boolean;
  /** The child has the session bridge extension (inter-session messages skip pi's steering queue). */
  sessionBridge?: boolean;
  /** Upstream provider id of the current model (e.g. "zai-coding-cn", "litellm"). */
  provider?: string;
  thinkingLevel?: string;
  /** Tokens in the model's context now; null right after a compaction until its next reply. */
  ctxTokens?: number | null;
  ctxMax?: number;
  /** The provider account's latest usage report, shared by every session on that provider. */
  usage?: UsageReport;
  /** Lifetime token/cost rollup tracked by the daemon. */
  tokens?: number;
  cost?: number;
  /** Agent profile the session was started as, when it was. */
  agent?: string;
  /** Active schedules in this session, and the soonest next fire (epoch ms); undefined when it has none. */
  schedules?: number;
  nextFire?: number;
  /** The strip above the editor: a line per active schedule (see scheduleStripLines). */
  scheduleLines?: string[];
  /** The agent's task list (ticket 228), drawn above the editor and listed by /tasks; undefined when it has none. */
  tasks?: Todo[];
  /** While the session works and the list still has open items: when the list last changed or this run began, whichever is later (epoch ms), so a controller can say the list has gone stale (ticket 251). */
  tasksStaleSince?: number;
  /** Plan mode is on (ticket 229): the session can only look. */
  plan?: boolean;
  /** Active permission grants in this session, the soonest expiry among the timed ones (epoch ms), and saved grants waiting for /permissions restore. */
  grants?: number;
  /** Auto mode is on (ticket 213), and when it ends by itself (epoch ms; undefined = it does not). */
  auto?: boolean;
  autoUntil?: number;
  nextGrantExpiry?: number;
  grantsSaved?: number;
  /** A subagent this daemon run started: how it stands, and whether its parent has the result (the row greys out when it ended and was delivered). */
  subagent?: {
    state: string;
    delivered: boolean;
    /** UUID of the session that started it. */
    parent: string;
    /** Budget counted so far and its cap (see subagents.ts), and turns taken against the profile's cap, if it has one. */
    tokens: number;
    budget: number;
    turns: number;
    maxTurns?: number;
  };
  /** Whether the current model takes images; undefined when pi did not say. */
  acceptsImages?: boolean;
  /** True iff THIS receiving controller holds the exclusive input attach. */
  attachedToYou: boolean;
  /** True iff another controller holds the attach. */
  attachedElsewhere: boolean;
}

// controller -> daemon. Commands with an `id` get a {type:"response", id}.
export type ClientCommand = ClientCommandBody & { id?: string };

export interface PromptImage {
  type: "image";
  data: string;
  mimeType: string;
}

export type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

type ClientCommandBody =
  | {
      type: "prompt";
      id?: string;
      message: string;
      /** Pasted images sent with the message (base64 data, as pi's RPC takes them). */
      images?: PromptImage[];
      /** The kind of client that sent it ("chatto") when it is not a toriel controller; the daemon logs it. */
      source?: string;
      /** Live session to prompt. */
      session?: number;
      /** Inactive/dead session to (re)spawn and prompt: resume this file. */
      sessionFile?: string;
      /** Required with sessionFile: working directory for the spawned child. */
      cwd?: string;
      /** Optional display name for a newly spawned child. */
      name?: string;
      /** Continue on a possibly-external branch after the daemon flagged a fork risk. */
      confirmFork?: boolean;
    }
  | { type: "abort"; session: number }
  /** Run a shell command in the session's cwd; pi records it so the model sees it on the next turn. The response is pi's BashResult. */
  | { type: "bash"; session: number; command: string }
  /** Stop a command started with `bash`. */
  | { type: "abort_bash"; session: number }
  /** Move the bash command(s) the agent is waiting for in this session to the background (they become jobs). The child answers with a notice. */
  | { type: "background"; session: number }
  /**
   * Switch auto mode for a session (ticket 213): its permission prompts are answered "Yes" by the daemon, except the ones in the
   * always-ask floor (auto-mode.ts). `on` omitted toggles; `for` (a duration such as "2h") makes it end by itself. Answers `{ on, until }`.
   * Kept in the daemon's memory only: never stored, so a daemon restart ends it.
   */
  | { type: "auto_mode"; session: number; on?: boolean; for?: string; quiet?: boolean }
  | { type: "deny_after"; session: number; after: string }
  /**
   * Plan mode (ticket 229): a session that can only look until the user approves a plan. `on` omitted toggles. The state is a marker
   * file per session (PLAN_DIR), so it outlives the child and the daemon. Answers `{ on }`.
   */
  | { type: "plan_mode"; session: number; on?: boolean; quiet?: boolean }
  /**
   * Say in the transcript which mode the session is in now (ticket 236). The shift+tab cycle sends its flag changes `quiet` (applied at
   * once, nothing said) and asks for this once the keys stop, so a burst of presses leaves one line, for the mode it settled on.
   */
  | { type: "mode_notice"; session: number }
  /** The daemon's side of a /feedback bundle (ticket 239): the state it holds for the session (modes, scope, sandbox, grants, a prompt waiting) and its own build and settings. Answers the snapshot. */
  | { type: "feedback_snapshot"; session?: number }
  /** Drop queued steering/follow-up messages; the response carries their text. */
  | { type: "clear_queue"; session: number }
  /** The text pi's /mcp prints (servers and their states), for listing and completion. */
  | { type: "mcp_status"; session: number }
  /** Deliver a message to another session (UUID, UUID prefix, #number or name). `from` is the sender's UUID, for the label. */
  | { type: "message"; id?: string; to: string; text: string; from?: string }
  /** Start a subagent for the session `from` (its UUID). Answers when the subagent settles, or at once with a handle when `background`. */
  | {
      type: "agent_spawn";
      id?: string;
      from: string;
      agent: string;
      task: string;
      description: string;
      model?: string;
      background?: boolean;
      context?: "fresh" | "fork";
      system?: string;
      /** Optional absolute path; the subagent is launched (and scoped) there instead of the parent's cwd. */
      cwd?: string;
    }
  /** List, inspect, wait for, stop or fetch the result of the subagents the session `from` started. `ref` is a handle number (#2 or 2). */
  | { type: "agents_op"; id?: string; from: string; action: "list" | "status" | "wait" | "stop" | "result"; ref?: string; timeoutMs?: number }
  /** Create a schedule (docs/design.md item 10) in a session, named by daemon number or UUID. `when` is the time spec words (parsed per `mode`); the prompt is `prompt`, or else whatever follows the spec. `dryRun` answers with the next fire times and creates nothing. */
  | {
      type: "schedule_add";
      id?: string;
      session?: number;
      uuid?: string;
      mode: "auto" | "in" | "at" | "every" | "cron" | "loop";
      when: string[];
      prompt?: string;
      name?: string;
      max?: number;
      /** A duration ("3d"), or "never". */
      expires?: string;
      catchup?: "once" | "skip";
      by?: "user" | "agent";
      dryRun?: boolean;
      /** Shell checks run by the daemon before each fire (repeating schedules only). */
      until?: string;
      while?: string;
    }
  /**
   * Create a file-trigger schedule (board 98): `prompt` is delivered into the session when `path`
   * changes. A relative `path` is resolved against the session's directory. `events` "write" (the
   * default) is a create or modify, "any" also a delete or rename away; `cooldown` is the quiet time
   * after the last event ("2s" default); `once` ends it after the first fire; `expires` as for
   * schedule_add. The response is {schedule, echo}. `by: "agent"` (from toriel_watch_create) adds limits: a 30s cooldown floor and default, `once` or an expiry of at most 24h, at most 3 such triggers per session, and the scheduler pauses one that fires 6 times in an hour.
   */
  | {
      type: "watch_add";
      id?: string;
      session?: number;
      uuid?: string;
      path: string;
      prompt: string;
      name?: string;
      events?: "write" | "any";
      cooldown?: string;
      once?: boolean;
      expires?: string;
      /** "agent" for a trigger made by toriel_watch_create (default "user"): the tighter limits of daemon-schedule.ts apply. */
      by?: "user" | "agent";
    }
  /** Schedules of one session, or of all when neither `session` nor `uuid` is given. The response is {schedules: ScheduleView[]}. */
  | { type: "schedule_list"; id?: string; session?: number; uuid?: string }
  /** Act on schedules: `ref` is "#3", "3" or a name (within the session when one is given); `all` takes every schedule in scope. */
  | { type: "schedule_op"; id?: string; op: "pause" | "resume" | "fire" | "cancel"; ref?: string; all?: boolean; session?: number; uuid?: string }
  /** From a child's toriel-grants link (docs/permissions.md): is this ask covered by a grant? `grants` is pi's suggested session grant for it, `value` the command or target asked about. The response is {allow, grants?}; when not covered the daemon remembers the suggestion for the dialog that follows. With `probe` it only looks: nothing is remembered, and a covered answer also carries `expiresAt` (epoch ms of the soonest-ending grant used, null = until revoked) for the toriel_permission_check tool. */
  | { type: "permission_check"; id?: string; uuid: string; grants: PermissionGrantSpec[]; value?: string; probe?: boolean; rule?: AskRule }
  /** Permission grants of one session, or of all when neither `session` nor `uuid` is given. The response is {grants: GrantView[]}. */
  | { type: "permission_list"; id?: string; session?: number; uuid?: string }
  /** Grant a surface/pattern in a session. `for` is a duration ("1h"), or "session"/"never" for no expiry (the default). `dialog` is the id of the file-path prompt being answered: required, and checked against the prompt the daemon holds, for a file-path surface (those grants come only from a prompt). */
  | { type: "permission_add"; id?: string; session?: number; uuid?: string; surface: string; pattern: string; for?: string; note?: string; source?: "dialog" | "command"; dialog?: string }
  /** Revoke grants: `ref` is "#3", "3" or an exact pattern (within the session when one is given); `all` takes every grant in scope. */
  | { type: "permission_revoke"; id?: string; session?: number; uuid?: string; ref?: string; all?: boolean }
  /** Activate the grants a session had saved before the daemon restarted. */
  | { type: "permission_restore"; id?: string; session?: number; uuid?: string }
  /** Find a session from a UUID, UUID prefix, `#number` or name; the response is {uuid, name, file, id?} (id = daemon number when the daemon holds it). */
  | { type: "resolve"; id?: string; query: string }
  /** Show a session in chat (`on` omitted: toggle) or stop showing it; keyed by UUID, so a sleeping session can be published. Answers `{ published }`. */
  | { type: "publish"; id?: string; sessionId: string; on?: boolean; resume?: boolean; unpark?: boolean }
  /** The chat bridge says whether it is connected to the chat server (drives SessionMeta.chatUp). */
  | { type: "chat_status"; id?: string; up: boolean }
  /** pi's slash commands (extensions, skills, prompt templates). Without a
   * live session the daemon answers from the last list any child reported. */
  | { type: "commands"; id?: string; session?: number }
  /** `ready`: answer only once the child is up (for callers about to command it). */
  | { type: "spawn"; id?: string; cwd: string; sessionFile?: string; name?: string; agent?: string; model?: string; ready?: boolean; wake?: boolean }
  | { type: "deactivate"; id?: string; session: number }
  /** Deactivate if live, then move the session file to the trash dir. */
  | { type: "delete"; id?: string; session?: number; path?: string }
  /** Cut the session back to before a user message (tail goes to the trash). */
  | { type: "rewind"; id?: string; session?: number; path?: string; entryId: string; /** Also put back the files the agent's write/edit tools changed since that message (ticket 11). */ code?: boolean }
  /** Put back the files the agent's write/edit tools changed since a message, leaving the conversation as it is (ticket 11). */
  | { type: "restore_code"; id?: string; session?: number; path?: string; entryId: string }
  /** Live: setSessionName on the child. Inactive: append session_info to the file. */
  | { type: "rename"; id?: string; session?: number; path?: string; name: string }
  /** Acquire exclusive input attach (force: steal from another controller). */
  | { type: "attach"; id?: string; session: number; force?: boolean }
  | { type: "detach"; session: number }
  /** Answer a dialog. Only the pending dialog can be answered: a second answer (or one for a dialog that went away) is refused with "already answered" and nothing reaches pi. `source` is the kind of client answering ("chatto"), for the decision log and `ui_resolved`. */
  | { type: "ui_response"; session: number; response: Record<string, unknown>; source?: string }
  /** Start (default) or stop receiving every session's dialogs as `ui_request`, attached or not, without taking the attach; the dialogs already open are sent at once. For the chat bridge. */
  | { type: "observe_dialogs"; id?: string; on?: boolean }
  /** Orderly daemon shutdown (children stop too). */
  | { type: "shutdown" }
  /** Presence heartbeat from the toriel-presence extension in an external
   * pi process (live=false deregisters on shutdown). */
  | { type: "external_register"; pid: number; sessionFile: string; cwd: string; live: boolean }
  /** Fork an external session file into a new toriel-owned session.
   * `fork` forks even a file a live toriel session already owns (/fork).
   * `name` names the new session; `parentName` is what the parent is called
   * (recorded in the lineage the two sessions are told about).
   * `keepPermissions` (with `fork`) gives the copy the parent's active permission grants. */
  | { type: "adopt"; id?: string; path: string; cwd: string; fork?: boolean; name?: string; parentName?: string; keepPermissions?: boolean }
  /** Without `query`: the current model and the available ones. With it: switch to the match. */
  | { type: "model"; id?: string; session: number; query?: string }
  /** Without `level`: the current thinking level and the ones the model supports. With it: switch to the match. */
  | { type: "think"; id?: string; session: number; level?: string }
  /** Compact the session's context (refused mid-run); can take minutes. */
  | { type: "compact"; id?: string; session: number; instructions?: string }
  /** Wipe the conversation but keep the session (file, name, model); old contents go to the trash dir. Refused mid-run. */
  | { type: "clear"; id?: string; session: number }
  /** Move a deleted session back out of the trash (`trashedTo` is the file in the trash dir). */
  | { type: "restore"; id?: string; trashedTo: string }
  /** Undo the last /clear: put the old contents back (refused mid-run). */
  | { type: "restore_clear"; id?: string; session?: number; path?: string }
  /** Restart the child on the same file so it re-reads extensions, skills and settings. */
  | { type: "reload"; id?: string; session: number }
  /** Move an idle session to another directory: its file's cwd is rewritten and pi restarted on it.
   * `dir` may be relative (to the session's current directory) or start with ~. */
  | { type: "cd"; id?: string; session: number; dir: string }
  /** Controller announce: classifies the connection as a controller (not a
   * presence heartbeat) and requests the current session list. */
  | { type: "list" }
  /** Send this controller the session's current history again (drift cure). */
  | { type: "resync"; id?: string; session: number; /** how many messages the controller's view counted, for the daemon's log (diagnosis only) */ seen?: number };

/** A surface and pattern pair, in the shape of pi-permission-system's `sessionApproval.grants`. */
export interface PermissionGrantSpec {
  surface: string;
  pattern: string;
}

/** A permission grant as controllers see it. */
export interface GrantView {
  id: number;
  /** UUID of the session it belongs to. */
  session: string;
  sessionName?: string;
  surface: string;
  pattern: string;
  createdAt: number;
  /** Epoch ms; null = until revoked. */
  expiresAt: number | null;
  source: string;
  note?: string;
  /** Saved before a daemon restart and not active until /permissions restore. */
  dormant: boolean;
}

/** A schedule as controllers and the agent tool see it. */
export interface ScheduleView {
  id: number;
  /** UUID of the session it fires into. */
  session: string;
  sessionName?: string;
  name?: string;
  prompt: string;
  /** "every 30m", "cron 0 9 * * 1-5", "once, tomorrow 09:00". */
  when: string;
  state: "active" | "paused";
  /** Epoch ms; undefined while a loop's run is in progress or once paused for good. */
  next?: number;
  fired: number;
  max?: number;
  /** Epoch ms; null = never. */
  expiresAt: number | null;
  by: "user" | "agent";
  catchup: "once" | "skip";
  lastFire?: number;
  lastError?: string;
  until?: string;
  while?: string;
  /** Why it is being held back right now (daily limit, usage budget). */
  held?: string;
}

// daemon -> controller
export type DaemonMessage =
  /** First thing a controller hears: which code the daemon runs. A daemon that never sends it predates the version check. */
  | { type: "hello"; protocol: number; build: BuildInfo; pid: number; sock: string; profile?: string }
  | { type: "sessions"; sessions: SessionMeta[] }
  | { type: "event"; session: number; event: Record<string, unknown> }
  | { type: "history"; session: number; messages: unknown[] }
  | { type: "ui_request"; session: number; request: Record<string, unknown> }
  /** A dialog is over, whoever ended it: `by` is "user" (an answer; `source` names the client kind when it said), "expired" (pi's own timeout), "deny-after" (the daemon's timer) or "dropped" (the session stopped or died). Every controller closes the matching dialog at once. */
  | { type: "ui_resolved"; session: number; id: string; by: string; source?: string }
  | { type: "exited"; session: number; reason?: string }
  /** Something worth saying about a session that is not an event in its transcript (a schedule ended or failed). */
  | { type: "notice"; session: number; text: string; /** Worth reading later (a grant answered a prompt): a row in the transcript, not a four-second flash. */ durable?: boolean }
  /** How many messages pi holds, sent when a run settles; a controller whose count differs asks to resync. */
  | { type: "digest"; session: number; messages: number; streaming: boolean }
  | { type: "response"; id: string; ok: boolean; error?: string; data?: unknown };

export function encodeLine(obj: unknown): string {
  return `${JSON.stringify(obj)}\n`;
}

export class LineSplitter {
  private buf = "";
  /** Where the last scan for a newline stopped, so a long line arriving in many chunks is scanned once, not once per chunk. */
  private scanned = 0;

  push(chunk: string): string[] {
    this.buf += chunk;
    const lines: string[] = [];
    for (let idx = this.buf.indexOf("\n", this.scanned); idx !== -1; idx = this.buf.indexOf("\n", this.scanned)) {
      let line = this.buf.slice(0, idx);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      this.buf = this.buf.slice(idx + 1);
      this.scanned = 0;
      if (line.length > 0) {
        lines.push(line);
      }
    }
    this.scanned = this.buf.length;
    return lines;
  }
}
