# toriel - design notes

## Status

**M1 COMPLETE and verified** (2026-10-20; M0 same day). Code in `src/`:
daemon.ts (session-centric: states, exclusive attach, trash, lazy spawn),
controller.ts, switcher.ts (overlay UI), groups.ts (shared groups JSON),
shared.ts (protocol v2), test/. See docs/reference.md for keys/semantics.
Verified end-to-end in tmux incl. csi-u keys: switcher listing/groups,
ctrl-n/ctrl-x deactivate/ctrl-x-x2 trash confirm, rename, group (shared
file), lazy respawn from file replay, /abort, permission dialog forward +
y-answer with tool actually executing, two-controller exclusivity +
take-over + view-only refusal. (The pi-side groundwork once lived in the
user's dotfiles; none of it is used any more: toriel's own pi resources are in
`pi/` and are loaded by flag, see "Packaging" below.)

**Current state (2026-10-23):** the session UX project is DONE except
per-item expand (parked: not useful without mouse selection). Built since M1:
Controller split (host.ts, switcher-actions.ts, session-actions.ts), solarized
theme as one JSON file driving pi components and the switcher (theme.ts,
pi/themes/), painted background (OSC 11), real tool renderers + collapsed tool
runs (ctrl-o), thinking toggle (ctrl-t), working indicator + queued-message
strip + switcher-row spinner, Esc restores queued messages then aborts,
rewind (esc esc), history seeded from the session file plus a slash-command
log, wheel scroll acceleration, scroll position held while output streams,
steeringMode "all", the toriel settings file (settings.ts), resources.ts for
pi/ resources. Everything is tested against a fake pi (test/fixtures/fake-pi
.mjs, incl. FAKE_PI_SLOW=1); real-model runs are the remaining verification.
Also built 2026-10-22 (night): ctrl-r history search (switcher rename moved to f2), /command autocomplete (registries in commands.ts; pi commands via daemon `commands`), plain text in the switcher starts a session.

Findings below were validated against pi's shipped code (pi 1.3.x era).
M0/M1 corrections to earlier assumptions are in "M0 findings".

## Refactor round (2026-10-22)

controller.ts (1700 lines) and daemon.ts were split along existing seams into
pure modules (see docs/reference.md "Code layout"), with unit tests for each and
an integration suite that runs the real daemon against a fake pi. Findings:
- `tsc --noEmit` (strict) is now part of the checks: node strips types without
  checking them, which hid dead code (switcher callbacks never declared) and a
  protocol mismatch (controller read `sessionName`, daemon sent `name`).
- Presence invariants: an externally-live session is reported tagged by the
  daemon's FIRST list to a controller, even before pi writes its file; the
  controller hides it until the file is visible locally, so a row can never
  appear without its [pi] tag. Registrations are dropped by pid liveness
  (3s tick), not only by the extension's deregister (lost when pi exits).
- spawn replies as soon as the session is registered; the child starts in the
  background and prompts arriving meanwhile wait on `starting`.
- The Controller class was split afterwards (2026-10-22/23): switcher actions
  (switcher-actions.ts) and session actions (session-actions.ts) behind the
  Host interface in host.ts; controller.ts keeps state and routing (2026-10-31: the
  daemon connection, clipboard, completion lookups and layouts moved out to
  daemon-link.ts, clipboard-actions.ts, completion-sources.ts and layout.ts; the
  switcher filter, summaries and trash restore out of switcher-actions.ts).

## Session UX project (scoped 2026-10-22; DONE 2026-10-23 except per-item expand)

Roadmap items 7 and 8 combined; goal: toriel sessions should look and feel
alive. Built; the per-step notes below record what shipped. Decision (Ron): ONE solarized palette drives both the
session view and the switcher chrome. Keyboard-only: no mouse (reporting would
break terminal select/copy, and click hit-testing against ScrollView offsets is
real work).

Packaging (decided 2026-10-22, revised 2026-10-31): toriel owns its pi-side
resources in the repo (`pi/extensions/`, `pi/skills/`, `pi/themes/`). First
version symlinked them into $PI_CODING_AGENT_DIR with `node src/install.ts`;
that landed files in the user's dotfiles (~/.pi/agent/extensions was a symlink
there), went stale when the repo moved, and left sessions silently without an
extension. Now the daemon passes each resource to every child it starts as
`-e <file>` / `--skill <dir>` (src/resources.ts; validated: with an empty agent
dir the bridge extension and skill load, and explicit paths still load under
--no-extensions), so nothing is installed and a child always matches the
daemon. pi's own config dir is the user's; toriel reads it and never writes to
it. The presence extension is the exception: it is for plain pi processes
toriel did not start, so it is not loaded by flag; plain pi opts in with its
`extensions` setting. The controller's own process loads the
theme straight from the repo: pi-theme.ts points PI_CODING_AGENT_DIR at the
repo's pi/ dir (it has themes/) for the duration of initTheme(), so it needs
no install step. test/theme.test.ts fails if pi silently falls back. Drop the
hack when pi exports setThemeInstance / loadThemeFromPath (upstream ask).

Steps, each independently shippable, in order:

1. Theme-loading spike (~10 min, gates everything). pi themes are JSON files;
   `initTheme(themeName)` takes a name, and pi's bundled dark.json/light.json
   (dist/modes/interactive/theme/) list the tokens. Check where initTheme looks
   (probably only ~/.pi/agent/themes/) and whether a path/object can be
   passed; if only that dir, ship the file there or via PI_CODING_AGENT_DIR.
   If neither works, upstream ask (see roadmap #7).
2. Solarized palette: one source file (JSON) -> pi theme (solarized-dark, plus
   light) AND theme.ts (switcher chrome, currently hardcoded 256-color
   approximations) derived from it. Covers markdown, code highlighting, tool
   backgrounds and diff colors, since pi components read the theme. Verify
   edit/write diffs render with a real session: our replay/live paths must pass
   tool args + result `details` to ToolExecutionComponent.
3. Working/thinking indicator (biggest usability win). Spinner line under the
   transcript with a label from the latest event ("thinking", "running
   bash", "writing"), elapsed time, tokens if cheap; spinner glyph on
   streaming rows in the switcher. Needs a ~100ms render timer that runs only
   while the viewed session streams (flicker risk on alt-screen full redraws).
   Check whether pi-tui's Loader is importable, else a ~30-line spinner.
   Events already flow (message_update/thinking deltas, tool_execution_*).
   Queued (not yet processed) messages (Ron, 2026-10-22): steering is always
   what we send (no follow-up, no queue-mode commands; settings.json modes
   apply to children as-is). Pi emits `queue_update {steering[], followUp[]}`
   with the COMPLETE queue on every change, so render the latest queue as
   pending user items at the very bottom of the transcript (below the last
   item, above the spinner line), dimmed with a "queued" marker; the real
   user item appears in place when message_start arrives and the queue entry
   drops. Esc-abort should `clear_queue` first and put the returned text back
   in the editor (pi's own behavior; rpc-commands.md "clear_queue"). Visual
   vocabulary (queued vs tool vs thinking vs error) will be tuned by eye;
   keep every style a theme token so it is one-file tweaking. To verify: does
   the daemon/controller already echo a user message at submit time (VERIFIED
   with fake-pi slow mode: no, a queued message shows only via queue_update),
   and does abort leave the queue intact (rpc says abort continues queued
   messages; still open, plus the clear_queue-on-Esc flow).
   STATUS 2026-10-22: indicator + queued strip BUILT (activity.ts, the strip
   docked under the transcript, 100ms timer only while working); daemon sets
   steeringMode "all" on every child (TORIEL_STEERING_MODE=one-at-a-time
   restores pi's default). Fake pi: FAKE_PI_SLOW=1 scripts thinking/tool/text/
   error and queues mid-run prompts. DONE 2026-10-23: switcher-row spinner (same
   timer, runs while the switcher is open and any session streams); Esc on a
   working session clear_queue's, restores queued text above the editor draft
   (pi's behavior), then aborts - verified an abort alone would deliver them.
   TICKET #47 (2026-10-28): the strip kept showing steered messages after the
   agent processed them (messaging-test incident, session 8). Post-mortem:
   repeated repros against real pi 1.3.0 (labeled + plain steers, mid-tool and
   mid-stream timing, full daemon, real controller TUI) all clear correctly -
   pi's exact-match removal at message_start is sound and toriel's relay is
   faithful, so the incident's one-shot loss was never reproduced. The defect
   that made it permanent is real, though: queue_update is fire-and-forget with
   no replay and pi exposes no read-only way to get the queued texts back, so a
   single lost update stuck the strip forever. FIX: refreshMeta (every agent_settled and
   child start) reads pi's pendingMessageCount and re-announces an empty queue
   when it is zero (held compaction messages are the daemon's own and keep
   their announce). Fake pi: FAKE_PI_DROP_QUEUE_REMOVAL=1 withholds the
   removal update to regression-test the reconcile. Daemon log now records
   queue_update counts. Still open / parked: what dropped the event in the
   incident (watch for it recurring - the log line above will show it); pi's
   exit race where a steer arriving between the run's final queue drain and
   _isAgentRunActive=false is stranded until the next prompt (pi-side, benign:
   the strip is honest and the next run delivers it); toriel pins
   pi-coding-agent 1.4.0 in package.json while node_modules holds 1.3.0
   (installed 2026-10-18) - run npm install and re-verify the queue paths on
   1.4.0.
4. (BUILT 2026-10-22; per-item expand PARKED - not useful without mouse selection: tool-run.ts groups consecutive tool
   calls into one collapsed summary line, ctrl-o toggles all sessions; ctrl-t
   toggles thinking, starting from pi's hideThinkingBlock setting. Step 5: pi's
   own assistant component already draws errors, so ours only adds a row for
   error messages that contain tool calls.) Collapse/expand: global `expanded` flag toggled by ctrl-o (pi's own key),
   applied with ToolExecutionComponent.setExpanded on every tool item; a second
   toggle (ctrl-t?) calls AssistantMessageComponent.setHideThinkingBlock
   (currently always hidden). All-or-nothing like pi; per-item expand would
   need a selected-item cursor in the ScrollView - later. Status-line hint.
5. Error rendering: stopReason/message.error as an attention-colored block
   (AssistantMessageComponent may already do this; verify with the fake pi).

Testing: grow test/fixtures/fake-pi.mjs a slow-streaming mode (thinking, tool
events, an error) so the indicator and toggles can be smoke-tested in tmux
without a model.
Risk: Loader/diff components are interactive-mode internals, not all exported
(see the caveat under "Building blocks"); use the shim-module plan there.

## Switcher backlog

- Group folding: BUILT 2026-10-25 (left/right/enter on a header; persisted as
  `collapsed` in session-groups.json; a folded group shows a one-line summary;
  dragging a session into a folded group unfolds it).
- Command completion beyond positional arguments (PARKED 2026-10-25, Ron: it
  would keep needing per-option work and add complexity). Audited candidates:
  flag-name completion for every command (from the option declarations),
  option VALUES (`-m <model>` for /summarize and /why, `-C <dir>` for /new,
  `-c <category>` for /feedback), `/help [command]`, `/restore` from trash
  names, a toriel `/group` inside sessions. Done so far: models (/model),
  groups (/group in the switcher), MCP servers (/mcp). pi's own extension
  commands cannot be completed through RPC (no completion API); only worth
  doing one by one, the way /mcp was, or upstream in pi.
- Known issue, no repro yet (tracked 2026-10-25): `right` on a normal session
  row sometimes does not open it. Ruled out: terminal key timeouts (kitty
  protocol sends whole sequences) and key-release events. Fixed as a
  contributing cause: `right` on a group header used to do nothing silently.
  If it recurs, run with TORIEL_KEYS=1 (writes logs/key-debug.log: every key
  and every selection change) and capture the tail right after a failure.

## M0 findings (corrections to earlier assumptions)

- **Fullscreen layout is the right model, not main-screen.**
  TuiMainScreen renders children straight into scrollback (no transcript
  viewport; pi's regular mode doesn't use ScrollView at all). The
  ScrollView + VStack flex layout only works on TuiAltScreen via
  setLayoutRoot - mirror pi's createChatViewport
  (dist/modes/interactive/chat-viewport.js): VStack([transcript
  {basis:0,grow:1}, dock{basis:"auto"}]) with the editor at minSize 3.
- **pi's theme instance is NOT exported** from the package index (only the
  Theme class + getMarkdownTheme/getSelectListTheme getters). M0 chrome
  uses raw ANSI (dim/accent helpers); real theming needs an upstream
  export request or theme access via the getters only.
- truncateToWidth, Editor, VStack, ScrollView, TuiAltScreen are pi-tui
  exports; AssistantMessageComponent/UserMessageComponent/
  ToolExecutionComponent/initTheme/getMarkdownTheme are pi exports. Easy
  to mix up; check both indexes.
- Node type stripping is erasable-only: parameter properties
  (`constructor(readonly x)`) throw ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX. No
  enums/namespaces either. Run files directly with node v26 (.nvmrc pins
  26.12.0; nvm default alias is v20, which will NOT run this).
- RpcClient: extension_ui_request records fall through to onEvent
  listeners; answer with (client as any).send({type:
  "extension_ui_response", id, ...}) (send is typed-private, present at
  runtime). cliPath defaults to cwd-relative "dist/cli.js" - always pass
  the absolute path. RpcClient spawns `node` from PATH: daemon must be
  launched with v26 first in PATH.
- message_update deltas: text_end/thinking_end carry authoritative
  `content`; replace on end and on message_end.message. toolcall_* deltas
  can be skipped - tools render from tool_execution_* events (args +
  partial results) via ToolExecutionComponent (side-map toolCallId ->
  item; the component doesn't expose its id).
- **Keys must go through matchesKey/Key, never raw bytes.** Through tmux
  extended-keys + csi-u, ctrl+letters arrive as `CSI 116;5u` (codepoint;mods),
  not legacy `\x14`. matchesKey(data, Key.ctrl("t")) decodes legacy, kitty,
  and csi-u uniformly; filter isKeyRelease first. Verified working via
  tmux's own key encoding. Known quirk: a CSI-u ctrl-chord pressed in the
  first moments after start (before kitty/DA1 negotiation settles) can be
  swallowed by pi-tui's keyboard-negotiation reader; presses after ~1s are
  reliable.
- **RpcClient.send() corrupts extension_ui_response**: it overwrites the
  record's id with its own req_N correlation id (dialog replies never
  match) and then waits 30s for an ack the protocol never sends. Dialog
  replies must be written RAW to child stdin. Worth an upstream issue.
- get_state returns model as {provider, id} -> "provider/id" for the
  status line; sessionName falls back to cwd basename.

## Stack

TypeScript on Node.js, effectively fixed by three Node-only imports the
design depends on: pi-tui (Editor/components), RpcClient, and (pending M0
verification) pi's exported markdown/message components. The daemon socket
protocol and session files are plain JSONL, so either half remains
rewritable elsewhere later without touching the other.

## Architecture

```
daemon                                                    controllers (N)
  owns child lifetimes                            view/switch/prompt TUIs
  event fan-out to attached controllers   <--->   unix socket, JSONL
  dialog routing (badge-and-block)                built on @earendil-works/pi-tui
  group/state storage (~/.local/share/toriel/)
   |
   +-- pi --mode rpc child <-> RpcClient (JSONL stdio)
   +-- pi --mode rpc child <-> RpcClient
   +-- (inactive sessions: files only, no process)
```

- Daemon: child lifecycle (spawn on demand, deactivate, respawn), event
  multiplexing, permission-dialog routing to the driving controller,
  exclusive per-child attach bookkeeping.
- Controller renders everything; children render nothing (no TUI in rpc
  mode). Controllers are stateless views: crash one and nothing is lost.
- Daemon crash kills children (accepted; see requirements Q2 for
  supervision options). One process to make reliable instead of N.
- pi-tui is a standalone published package: Editor (multiline, history,
  undo, autocomplete hooks), containers, borders, overlays, mouse events.
- `RpcClient` is exported from the pi package: spawn, id correlation,
  typed commands, event listeners.
- Controller<->daemon protocol: JSONL over a unix socket
  ($XDG_RUNTIME_DIR/toriel.sock), same framing rules as pi rpc.
- Spawn requests carry cwd; the daemon spawns children with it (RpcClient /
  child_process cwd option). Never rely on inherited cwd - the daemon's
  cwd is meaningless. Session storage is cwd-derived per pi's layout, and
  session listing spans all directories (SessionManager.listAll), so the
  switcher shows sessions from every project regardless of the controller's
  current directory.
- Usage accounting lives in the daemon: message events carry usage
  (input/output/cache/cost); accumulate per-child totals and a global total;
  get_session_stats reconciles on attach. Persist rollups under
  ~/.local/share/toriel/ if a budget window beyond daemon lifetime is
  wanted. Future MCP server = another client of the same daemon socket
  (list/spawn/deactivate/query), registrable in pi's mcp.json. A future web
  GUI is the same pattern again (bridge client); pi's export_html command
  is a rendering reference for HTML transcripts.

## Session states

- active/processing, active/idle: child exists; agent_settled vs streaming
  events distinguish.
- inactive: file only. Transcript replay parses the session file directly
  (documented JSONL format, session-format.md). Lazy spawn on first prompt.
- Transcript model must accept BOTH live event streams and file replays
  through one renderer, or the two views drift apart. Build the unified
  event-log abstraction first.

## UI paradigm (M1): the switcher, not tabs

M0's tab bar was a placeholder. The shipped UI (after one iteration: the
first overlay was a cramped popup, then a name-grid - Ron picked Claude
Code's agent-list shape) mirrors Claude Code's agent list:

- **Left-arrow on empty editor** opens the session overlay. Interception
  happens in the editor subclass before super.handleInput (same pattern as
  session-groups.ts); left arrives as `\x1b[D`, `\x1bOD`, or kitty/csi-u
  `CSI 1;<mods> D` - reuse the lock-bit-tolerant match, ignoring numlock
  (128) and caps (64) bits.
- **Switcher contents**: group headers from
  ~/.local/share/toriel/session-groups.json (shared with the stock pi
  extension), each session under its group with name + state marker
  (color: streaming/idle/inactive/dead), plus an (ungrouped) section.
  Sessions come from two sources merged: daemon tabs (live) and
  SessionManager.listAll() read directly by the controller (session files
  are the interface; inactive sessions spawn lazily on first prompt).
- **Keys in switcher**: up/down move, enter or right enters, esc closes;
  management on the highlighted entry: ctrl-n new, ctrl-x kill
  (context-sensitive: deactivate if active, trash+confirm if inactive),
  f2 rename (ctrl-r is history search), ctrl-g group. A command box at the bottom of the
  switcher offers typed equivalents (/new, /kill, /rename <name>,
  /group <name>, /exit, /help; /restore later) - every hotkey has a
  command form.
- **Session view keys**: left-arrow on empty editor opens the switcher;
  typed /abort and /exit are intercepted controller-side (never
  forwarded to the child - /abort maps to the daemon abort command,
  /exit quits the controller; child exit is deactivate's job). No
  ctrl-c anywhere (feels like hard-kill).
- **pi-tui machinery**: tui.showOverlay/hideOverlay with focus management,
  SelectList for the list. Build on these, not a custom grid.
- **Hotkeys** (act on current session; decoded via matchesKey/Key):
  ctrl-n new (daemon spawn with controller cwd), ctrl-x deactivate child
  (daemon command; file stays; lazy respawn on next prompt), ctrl-r
  rename (set_session_name via daemon; inline prompt), ctrl-g group
  (write shared groups JSON; switcher list of existing groups or type name),
  ctrl-c abort/quit. The old ctrl-t tab-cycle is dropped.
- **Lifecycle**: the controller auto-starts the daemon detached on cold
  start (same node binary via process.execPath; double-checked to narrow
  simultaneous-start races) and `controller.ts kill-server` SIGTERMs it via
  the pidfile (with a /proc cmdline identity check); shutdown is orderly -
  children stop, socket and pidfile are removed. The pidfile doubles as the
  single-instance lock (src/daemon-lock.ts, `daemon.pid` in the data dir, created
  O_EXCL; a dead holder's lock is replaced). It lives in the state directory, not
  beside the socket, because the old per-socket guard let a daemon on a renamed
  socket run next to the old one, and a second daemon on the same socket used to
  delete the first one's socket file and rebind it.
- **Manual ordering (implemented)**: session-groups.json carries an `order`
  array of session UUIDs (both writers preserve it; extension updated).
  Display: ordered ids first, unordered after (bottom). Shift+arrows move
  the highlighted row; crossing headers reassigns groups (down = first of
  the next section, up = last of the previous); headers reorder the groups
  array; selection follows the moved item. Group headers are selectable
  rows (that is the grab point), and enter on a header opens its first
  session.
- **Palette**: theme.ts, solarized-dark via 256-color approximations (bg
  234, dim 245, accent cyan 37, streaming yellow 136, attention orange
  166). Chrome styles use scoped resets (22/39) so they compose with the
  switcher's tinted background. Solarized-light = swap one file.
- **Budget rollups**: the daemon accumulates lifetime tokens/cost per
  session from message_end usage and exposes them in session meta; the
  switcher header shows fleet totals, the status line shows the viewed
  session's.
- **Steering**: daemon prompts always use streamingBehavior "steer" - the
  same call executes when idle and queues as steering when streaming. Never
  call prompt() bare during a run (pi rejects it).
- **Trash**: delete never unlinks - the daemon moves the session file to
  ~/.local/share/toriel/trash/ with a manifest (original path + timestamp)
  and drops its in-memory entry. The group assignment is deliberately KEPT
  so /restore brings the session back already grouped (orphan assignments
  are harmless - they attach to nothing until a session id matches).
  pi session files have no registry that can regenerate them; unlink
  would be permanent.
- **Status line** carries current session identity + ambient counts
  (N running, M waiting on permission); no permanent tab bar.

## What the pi side provides for free

RPC commands: prompt / steer / follow_up / abort / clear_queue;
new_session / switch_session / fork / clone / set_session_name;
get_state / get_messages / get_entries / get_tree / get_session_stats;
set_model / cycle_model / get_available_models; set_thinking_level /
cycle_thinking_level; compact / set_auto_compaction; bash / abort_bash;
export_html; get_commands.

- Extension commands execute via `prompt` server-side (disposition
  "handled"), even mid-stream: `/group foo`, `/skill:...`, templates.
- Extension UI forwarding: select / confirm / input dialogs arrive as
  extension_ui_request records and are answered with records. NOT custom
  components: the /sessions switcher UI and status-bar footer do not cross
  the boundary. The switcher becomes controller chrome; the status bar is
  rebuilt client-side.
- Events: message start/update/end, tool execution updates, agent_end /
  agent_settled, queue events. `agent_settled` is the "tab went idle"
  signal.
- Markdown: pi's own TUI renders assistant messages as markdown; check in
  M0 whether its interactive components (AssistantMessageComponent etc.,
  exported from the package) can be reused for the transcript view. If
  yes, requirement 9 is cheap; if no, pick a TUI-markdown renderer.

## Consequences for existing extensions (dotfiles)

Historical (2026-10-23): `permissions.ts` was replaced by the pi-permission-system
package (see `permission-dialogs.md`) and `session-groups.ts` and `status-bar.ts`
were dropped from the user's dotfiles on 2026-10-31; what follows describes the
state when the daemon was first built.

- permissions.ts: unchanged, runs in each child; dialogs forwarded through
  daemon to the driving controller.
- session-groups.ts: the /group command keeps working (dialog-based); the
  switcher half is superseded by controller chrome; left-arrow hook is
  TUI-only (reborn as a controller binding). Path moves to
  ~/.local/share/toriel/session-groups.json (shared with stock pi; migrate
  once, update the extension).
- status-bar.ts: superseded; spec reimplemented controller-side, extended
  with the session-state indicator.

## Protocol gotchas

- JSONL framing everywhere: split on LF only (Node readline also splits on
  U+2028/U+2029, which are legal inside JSON strings).
- Read streams continuously; honor backpressure both directions.
- During streaming, prompt requires streamingBehavior (steer | followUp).
- Subscribe listeners before prompting to avoid missing fast completions;
  RpcClient.promptAndWait() does this internally.
- Nested terminal context: controller inside tmux needs extended-keys
  (already configured). Kitty keyboard protocol passthrough to verify.
- Mouse: with mouse reporting on, middle-click arrives as a TuiMouseEvent;
  primary selection must be fetched via xclip (X11) / wl-paste (Wayland).
  Highlight-copy: implement selection like pi does (copy-on-select /
  OSC 52).

## Milestones

- M0 spike: **DONE, verified 2026-10-20**.
- M1 usable: **DONE, verified 2026-10-20** - switcher overlay with groups,
  session states + lazy spawn, exclusive attach + take-over, permission
  forwarding (badge-and-block, re-sent on attach), trash-based delete,
  rename, shared groups JSON in XDG data dir.
- Trial phase (current): Ron runs real work through toriel; friction list
  drives fixes. Presence/adopt work landed 2026-10-21 (toriel-presence
  extension, /adopt, live-in-pi markers, prompt-fork confirm, ghost
  pruning, controller announce).
- M2: the UX batch (see "M2+ roadmap" below) - quick wins first.
- Session UX project (solarized, indicator, collapse, rewind, history,
  settings): DONE 2026-10-23; see the section of that name above. The
  Controller-class split is also done.
- Done: ctrl-r history search, /command autocomplete, text-starts-session.

## toriel settings file (built 2026-10-23)

~/.config/toriel/settings.json (settings.ts): steeringMode, provider, model,
thinking, piCli; defaults < file < TORIEL_* env. Read by the daemon at EVERY
child spawn (not at daemon start), so changes need no restart; each child
records the file's mtime it started with (SessionMeta.settingsMtime) and the
switcher status line warns how many running sessions are behind (mtime, not
content hash: a touch is a harmless false alarm, create/delete counts as a
change). Parse/type problems are reported the same way and logged. Not in the
file yet: socket/log/trash/history paths (env only, read at import), UI
options (rendering ones still come from pi's settings.json), idle-exit
(decided against), search backend (future).

## Next session (medium priority, added 2026-10-23): history search, custom tools

Handoff for the next session (findings checked 2026-10-23):

- /command autocomplete. pi-tui's Editor has `setAutocompleteProvider(p)` and
  `setAutocompleteMaxVisible(n)`; pass `autocompleteMaxVisible` from pi's
  settings (default 5). `AutocompleteProvider` = getSuggestions(lines, line,
  col, {signal, force}) + applyCompletion(...); `force` is the likely Tab hook.
  `CombinedAutocompleteProvider(commands: SlashCommand[], basePath, fdPath)`
  gives slash commands (name, description, argumentHint,
  getArgumentCompletions) AND @file path completion for free - useful in the
  session editor. Two providers: (a) switcher box: toriel's own commands from
  commands.ts (needs descriptions/arg hints, and the session editor's /exit
  /quit /abort); (b) session editor: the child's `get_commands` list via a new
  daemon passthrough, plus (a)'s session-level commands. Open: inactive
  sessions have no child to ask (cache the last list per session, or ask a
  daemon-wide child); Tab-Tab listing vs popup-as-you-type (the decided
  preference is readline-style; verify what `force` does before building).
- ctrl-r. The Editor has no default ctrl-r binding (checked), and
  InputEditor.onKey already intercepts keys first, so a docked search line
  (like rewind-picker.ts) fits: type to filter, ctrl-r again = next older
  match, enter accepts into the editor, esc cancels. Search over the same
  merged list syncHistory() builds (prompts + commands). Session view only:
  ctrl-r means rename in the switcher. Consider exposing the merged list from
  the controller so the picker and the editor share one source.

- ctrl-r backward search over the session's input history (shell-style:
  type to filter, ctrl-r again for the next older match, enter accepts,
  esc cancels). NOTE ctrl-r is already "rename" in the switcher, so search
  would be session-view only. History already seeds from the session file; this is the
  search UI on top (a docked line like the rewind picker).
- Web search: NOT NEEDED - an off-the-shelf pi extension covers it (Ron,
  2026-10-23), installed outside this repo. Custom tools of our own remain
  possible via pi extension tools (`pi.registerTool()`) in pi/extensions/;
  candidates, roughly by value: toriel-aware tools via the daemon socket
  (spawn a named agent, message another session; see "Agent definitions"), a
  notify tool (push when a long run finishes or needs input), docs lookup
  (pi's own docs dir). If we ever write a fetch-style tool: block loopback,
  link-local and private ranges (re-check after redirects) and treat fetched
  content as untrusted model input. Tool declarations cost context for small
  models, so agent profiles should list tools explicitly; pi's tool_search /
  codemode built-ins (defaultTools "+codemode" today) already reduce that.
  Note for the parked file-restore: pi's `tool_call` event can mutate or block
  a call before it runs, so a pre-edit snapshot extension looks feasible.

## M2+ roadmap (tracked 2026-10-22, Ron's list)

Near-term (post-budget-reset), rough order = dependency + value:

1. Switcher quick-prompt: typing a non-command line in the switcher box +
   enter spawns a new session and delivers the text as its first prompt
   (pieces exist: spawn flow + pendingPrompt).
2. Slash autocomplete: pi-tui ships AutocompleteProvider /
   CombinedAutocompleteProvider (SlashCommand with description +
   argumentHint) - free for BOTH the switcher command box (toriel's own
   commands) and the session editor. Ron prefers readline semantics:
   tab completes, tab-tab lists options (the provider's force flag looks
   like the hook); use the popup if it comes free. Session-side needs the
   child's command list over RPC: CHECKED 2026-10-23 - `get_commands` exists
   (name, description, source extension/prompt/skill; run via `prompt` with
   a leading `/`). See "Next session" for the plan.
3. Status bar parity: adopt the dotfiles status-bar.ts segments verbatim
   ([session-name] dir | git:(branch) | model | ctx: used/max | thinking:
   level | $cost | prov: id, green->yellow->red "badness" gradient) in
   BOTH switcher and session views. Daemon must expose ctxUsed/ctxMax
   (from message usage + model context window), thinkingLevel
   (thinking_level_change events), and provider in SessionMeta; git branch
   is controller-side (git -C <session cwd>).
4. Paste: first test whether pi-tui's editor already handles bracketed
   paste (zero-code path); fallback = Ctrl-V / middle-click -> wl-paste
   insert (Wayland assumed, decided).
5. Session input history: **DONE 2026-10-22 for the core** - the Editor
   already had history (addToHistory + internal up/down with draft
   restore); wired addToHistory on successful submit and bound
   tui.editor.historyPrevious/Next to up/down (defaults are empty).
   Verified: recall, draft stash/restore, switcher navigation unaffected.
   Seeding DONE 2026-10-23: entering a session replaces the editor history
   with that session's own user messages (from the file, so it survives
   restarts and includes messages sent from standalone pi); a rewind reseeds.
   Slash commands (session editor AND switcher box) are logged to
   ~/.local/share/toriel/history.jsonl (TORIEL_HISTORY; trimmed to 500 at
   startup; history.ts) and merged by time with the session's prompts; the
   switcher's up-arrow shows commands only. Not built: a global cross-session
   history of prompts. ctrl-r backward search is wanted (see "Next
   session").
6. Rewind + /fork (related, different semantics). REWIND BUILT 2026-10-23
   (rewind.ts, daemon `rewind` command, rewind-picker.ts; esc esc on an idle
   session with an empty editor): conversation only, tail -> trash with a
   manifest, text returns to the editor, child stops and lazily respawns.
   Limits: cuts by file position, so a session branched in place via pi's
   /tree is only rewound correctly if the chosen message's parent is the
   entry right before it. /restore (undo) is not built; the trash manifest
   has what it needs. FUTURE (parked): rewind that also restores files.
   Replaying edits backwards is not viable (write loses the old content,
   bash is opaque); checkpoint before changes instead: (a) an extension in
   pi/extensions/ snapshots files before edit/write (check whether tool_call
   events fire before execution), or (b) a shadow git repo snapshotting the
   working tree per user message (covers bash, costs disk/time). Restore
   must warn when a file changed since the checkpoint.
   - esc esc = REMOVE: pi ships a user-message-selector component (the
     same popup as its escape-escape) - reuse it, but wire selection to
     truncate the session file back to before the chosen message and
     respawn, stashing the trimmed tail in trash first (rewind stays
     reversible like delete). Not a fork.
   - /fork = explicit fork command for a LIVE session: daemon already has
     the mechanics (adopt's --fork path); generalize so any daemon-owned
     session can be forked into a sibling. Forks the file as last
     flushed; in-flight child state stays with the original.
7. In-session solarized (SCOPED, see "NEXT BIG PROJECT: session UX"): ONE theme definition living in the dotfiles
   extensions (or a shared module), consumed by the controller - in RPC
   mode the child renders nothing, so the controller does all session
   rendering; the shared definition keeps toriel and any future pi-side
   use on one palette. Blocker to check: pi exports only
   getMarkdownTheme/getSelectListTheme/initTheme - read docs/themes.md and
   see whether initTheme accepts a custom theme object; if not, that is an
   upstream ask.
8. Rich output (SCOPED, same section): animated working/thinking indicator, show/hide thinking
   toggle, proper error rendering (message.error), better code-block
   colors (rides on 7).
9. Multiple agents / subagents (ADDED 2026-10-23; deliberately DEFERRED,
   BUT the project was started 2026-10-27 - read this status first, the notes
   below are the earlier evaluation). DESIGN (decided): subagents are real pi
   sessions owned by the daemon, started by a toriel_agent tool, shown nested
   under the parent, agent types as markdown files (Claude-style), limits
   enforced by the daemon; pi-subagents is NOT used. Full proposal and the
   decisions are in the job board ticket "Big feature - subagents" (Ron's
   notes folder, Issues/). BUILT so far (tickets 1-4 of 7): agent profiles
   (`agents/`, `/new -a`, `/agents`; profile saved per session UUID), session
   identity (UUIDs chosen at spawn via --session-id, `resolve`, unique names),
   the parent/child tree for agent-started sessions (`kind: "subagent"` in
   lineage.json: nesting, folds, banner, /parent, /detach), and session
   messaging (`toriel_message` tool, daemon `message`). NOT built: the spawn
   tool and limits (ticket 5), permission trickle-up (6), delegation skill and
   shipped types (7). Findings that matter: `--tools` does not remove
   extension tools (use --no-extensions); pi cannot select MCP servers per run
   (every enabled server connects; only --no-mcp or a project override
   changes that); pi's `--fork` ignores --session-id. Older evaluation:
   not installed): goal is CC-Task-style lightweight subagents living
   INSIDE a toriel-affiliated session - in-process, not switcher rows,
   results streaming into the conversation - plus an optional tree-view
   under the parent's switcher row. Two paths, decide when picked up:
   - pi-subagents (npm, nicopreme): foreground children run as in-process
     sessions (exactly the CC-Task model, works under RPC children);
     background children run in a DETACHED RUNNER process the daemon
     cannot see - a blind spot for the activation cap and budget
     tracking, and TORIEL_CHILD=1 env inheritance currently keeps them out
     of toriel-presence (decide then whether runners must register with
     the daemon instead). Ships the guards we would want anyway
     (maxSubagentSpawnsPerSession/PerRun, concurrency, depth caps) and
     writes machine-readable run artifacts + an extension API that an
     external viewer could consume for the tree-view. Its TUI surfaces
     (FleetView, /subagents-fleet) never render in RPC children - the
     artifacts are the integration surface. Its researcher/
     evidence-auditor agents want pi-web-access in the child (installed
     2026-10-23, searxngBaseUrl -> search.shiverthorn.com).
   - Own minimal Task-style tool (a toriel extensions/ entry spawning
     in-process child sessions via the pi SDK): we own the event stream,
     so the switcher tree-view is direct and the daemon sees everything;
     we lose pi-subagents' preset agent ecosystem (scout/reviewer/
     oracle, workflows, missions).
   Controller prerequisite either way: proper extension_ui_request
   handling (fire-and-forget setStatus/notify per rpc-extension-ui.md) -
   already forced by pi-usage status events and hermes-memory notifies.
   PARENT/CHILD COMMUNICATION (parked 2026-10-23, goes with this item):
   /fork sessions already know their parent (id, name, file) via an
   appended system prompt, and the daemon records both directions in
   lineage.json. The reverse - TELLING THE PARENT ABOUT ITS CHILD - is
   not built: a running pi child's system prompt is fixed at start and
   RPC only accepts user messages, and restarting the parent just to
   update its prompt was rejected as too hacky. Do it when
   parent/child messaging exists: likely a pi extension in the child
   that can receive daemon-delivered messages (check for a first-class
   delivery mechanism first). Until then parents are unaware of forks.
   USAGE AWARENESS FOR AGENTS (parked 2026-10-25, goes with this item):
   the toriel_usage tool exists (quota/budget windows, credits left, resets),
   but nothing tells an agent WHEN to use it. Design that with agent
   management: guidance in the agent instructions ("check usage before big
   tasks, save headroom in the long window"), and/or an extension that warns
   an agent when a window passes a threshold, and budget-aware spawning of
   subagents (a coordinator pacing work across a multi-week job).

10. Time-based commands (DESIGNED 2026-10-31, tickets #5 and #9; implementation in slices, see the end):
   pi has no scheduling, so toriel adds a suite that fires prompts into
   sessions on a timer, e.g. "check a process hourly until it exists".
   Decisions (Ron, 2026-10-31): hand-rolled time parser plus the cron-parser
   package for cron expressions only (no chrono-node); schedules respawn an
   inactive session; recurring schedules expire after 7 days by default,
   configurable per schedule, `--expires never` allowed; schedules are
   session-scoped only (a session spawns subagents or forks if it needs more,
   so no global schedules); no permission-dialog policy in v1 (a fire that hits
   a dialog blocks with the badge, as today; auto-deny after a timeout is a
   separate ticket); killing a session (ctrl-x ctrl-x, /delete) removes its
   schedules.

   One primitive. Every command normalises to a stored record:
     Schedule { id, name?, session (uuid), prompt,
       trigger: once{at} | cron{expr} | every{ms, anchor} | loop{gapMs?},
       until?, while? (shell commands), max?, fired, expiresAt|null,
       catchup: "once"|"skip", by: "user"|"agent", state: active|paused,
       nextFire, lastFire? }
   `loop` re-runs after the previous run FINISHES (never overlaps); `loop`
   with no interval means the model self-paces (below). `once` is a stored
   timestamp, not a cron pinned to a date, so DST cannot move it.

   Commands (one registry in commands.ts, each with --help and examples):
   - `/in 90m <prompt>`, `/at 14:30 <prompt>` (once); `/every 30m <prompt>`;
     `/loop [5m] <prompt>`; `/cron "*/15 * * * *" <prompt>`.
   - `/schedules` lists (id, when, next fire, fired/max, expiry); with no
     arguments it opens a picker whose choices are pause / resume / fire now /
     cancel. `/cancel <id|name|--all>`, `/pause`, `/resume`, `/fire <id>`.
   - Both scopes: inside a session the commands act on THAT session's
     schedules; in the switcher `/schedules` lists ALL schedules grouped by
     session and /cancel takes any id. Creating schedules is session-only.
   - Flags: `--until/--while "<shell>"`, `--max N`, `--expires 3d|never`,
     `--name`, `--catchup skip`, `--dry-run` (print the next 3 fire times, create
     nothing).

   Friendly time parsing (src/when.ts, pure, injectable now and timezone):
   durations (90m, 1h30m, "2 hours", "in 2h"), clock times (14:30, 9am,
   "tomorrow 9am", "mon 09:00"), cadences ("every weekday 9am"), and raw
   5-field cron detected by shape. The friendliness is in the feedback: the
   command echoes its reading with the real time ("every 30m, first run 14:05
   (in 12m), expires in 7d, max 20"); an ambiguous input fails with a concrete
   suggestion ('"at 5" is ambiguous - try "at 17:00" or "at 5am"'); tab
   completion offers examples; a past clock time rolls to the next occurrence
   and says so, a past one-shot is an error.

   Daemon (src/scheduler.ts + daemon-handlers-schedule.ts):
   - The DAEMON owns the clock. One timer aimed at the nearest nextFire (no
     polling tick), injectable clock for tests. Persisted in `schedules.json`
     (writeJsonAtomic), keyed by session UUID like lineage.json.
   - Firing = deliverToSession, the path the message tool uses, with the text
     labelled `[scheduled "name" #3, run 4/20]` (received.ts style) so a fired
     prompt is not mistaken for a typed one. An inactive session is respawned.
   - A fire never interrupts: it waits while the session is streaming,
     compacting (`held`) or showing a permission dialog. At most one fire per
     schedule is pending, so a slow session coalesces instead of piling up.
   - After daemon downtime the default is `catchup: once` (one fire, flagged
     late); `skip` is opt-in; a once-schedule always fires late.
   - `--until/--while` are shell commands the daemon runs (with a timeout, no
     model): `until` succeeding completes the schedule with one final fire of
     the prompt; `while` failing ends it quietly. This is what makes "poll
     hourly" cost nothing.
   - Guards: default 7 day expiry on recurring schedules (shown), 1 minute
     minimum interval for model-run schedules, a per-session cap (20), tighter
     caps for agent-created ones, a global per-day fire cap; later, pause when
     the toriel_usage window is nearly spent. Deleting/trashing a session, or
     killing it, removes its schedules.

   Visibility: a clock marker and next-fire time on the switcher row (#9); a
   status-line segment ("sched 2, next 14:05"); a strip above the editor like
   the queued-message strip ("every 30m 'check build' - next 14:05"); a notice on every expiry, completion, cancel, hold and delivery failure, so a schedule
   never disappears silently (fires are visible in the session itself and in the daemon log); the
   picker above. One `schedules` broadcast feeds all of them.

   Agents self-configure: a pi extension (toriel-schedule.ts, built like
   toriel-agents.ts, reusing its `ask()`) registers three tools named after the
   Claude Code ones the models know: `toriel_schedule_create({when, prompt,
   until?, max?, name?})` (`when` is the same string the /in /at /every /cron
   parser takes, so there is one grammar; it returns the interpreted time and
   next fire so the model can check itself), `toriel_schedule_list`,
   `toriel_schedule_cancel({id})`. Scope is the caller's own session. A skill
   (pi/skills/scheduling) says when to use them: prefer `until` with a shell
   test over re-prompting, prefer long delays, cancel when done, tell the user
   what was scheduled. Self-paced `/loop`: the daemon appends a footer to each
   fired loop prompt telling the model to call toriel_schedule_create for the
   next run, or stop to end the loop.

   Prior art (Claude Code, from its tool descriptions): CronCreate/List/Delete,
   5-field local-time cron, `recurring: false` one-shots, fires only while idle
   (our wait-for-idle rule), session-only memory and 7 day auto-expiry (ours is
   durable but keeps the expiry), per-job jitter (not needed against our own
   daemon, but display the real next fire), a Monitor tool for event wakeups
   (our --until/--while is the token-free middle). Searching pi packages for an
   existing scheduling extension is still to do before building slice 5.

   Built so far (2026-10-31, branch scheduler): when.ts, scheduler.ts, the
   daemon wiring and commands, switcher/status markers and end notices, the
   agent tools (inside toriel-agents.ts rather than a separate extension) and
   the scheduling skill, --until/--while, self-paced loop footer. Deliberate:
   the agent tools take no --until/--while (a shell command would bypass the
   permission dialogs). Also built: usage-budget guard (pause at 95% of a
   provider window), per-day global fire cap (200), the strip above the editor,
   sleep inhibition (#21: systemd-inhibit idle:sleep while a turn runs or a
   run is due within 30 min; setting preventSleep). Left: a /schedules picker
   with row actions.

   Slices: 1 when.ts parser + tests. 2 scheduler core + persistence (fake
   clock). 3 daemon handlers, protocol, /in /every /cron /loop /schedules
   /cancel. 4 switcher marker, strip, status (#9). 5 agent extension + skill.
   6 self-paced /loop, --until/--while, catchup, guards. 7 sleep inhibition
   while jobs are pending (#21).

## Usage and quota in the status bar (built 2026-10-24)

Goal: show how much of the account's quota is used (z.ai 5h / weekly, LiteLLM
budget, later Bifrost and Claude Code) next to context and cost, colored 0%
green to 100% red.

Decisions:

- **The key never leaves pi (trust boundary).** toriel does not read
  `~/.pi/agent/auth.json` or `models.json`. A small pi extension
  (`pi/extensions/toriel-usage.ts`, loaded into each child by flag) runs in
  toriel-spawned children only (`TORIEL_CHILD`), fetches the quota through pi's
  own model registry (`ctx.modelRegistry.getApiKeyForProvider`), and reports
  only percentages back as a `setStatus` record under the key `toriel-usage`.
  The daemon consumes that record itself (controllers never see it).
- **Normalized, producer-neutral report** (`UsageReport` in `src/shared.ts`):
  provider, source, plan, `windows[{label, pct, resetsAt}]`, optional `spend`,
  fetch time. The daemon keeps the newest report per PROVIDER (every session on
  that account shares it) and attaches it to each session's meta; the status bar
  only renders windows/spend and hides a report older than 30 minutes.
- **Adapters live in the extension, chosen by the model's provider/base URL.**
  Adding a provider = one adapter + one parse function (both unit-tested).
- **Cost of the approach:** each live child polls on its own (session start,
  model change, after each turn, at most once a minute per child), so N live
  sessions on one provider make N small requests. Accepted; revisit by letting
  the daemon say "someone just fetched" if it ever matters.

Adapters and their sources (verified from docs/community code on 2026-10-24,
NOT yet run against a live account - first run is the real test):

- **z.ai** (hosts `api.z.ai` and `open.bigmodel.cn`; pi's `zai-coding-cn` uses
  the latter): `GET <origin>/api/monitor/usage/quota/limit`. Undocumented by
  z.ai; taken from its own glm-plan-usage plugin and community tools (opencode-
  glm-quota, pi-glm-usage). Response `{code:200, data:{level, limits:[{type,
  unit, percentage, nextResetTime}]}}`; `unit` 3 = rolling 5h, 6 = weekly,
  5 = monthly (ignored). Pick windows by `unit`, never by position. Auth: docs
  disagree on a `Bearer ` prefix, so the adapter tries Bearer, then the bare key
  on a 401. May change without notice.
- **LiteLLM**: `GET <origin>/key/info` with the key as Bearer; reads
  `info.spend`, `info.max_budget`, `info.budget_reset_at`. UNVERIFIED: the docs
  only show this endpoint called with the master key and a `key=` parameter;
  whether a key may read its own info this way depends on the proxy version and
  settings. The adapter hides itself on any non-200. Fallbacks if it does not
  work: a user-supplied URL/headers setting, or reading spend from the daemon's
  own message_end usage totals.
- **Bifrost**: NO documented read endpoint for a virtual key's usage (the UI's
  key info sheet shows it; create/update endpoints return `current_usage`
  fields under `/api/governance/virtual-keys`). Not implemented. Candidates to
  try: `GET /api/governance/virtual-keys` (probably admin-scoped), or reading
  the `current_usage` from a key lookup once we have a real instance to test
  against.
- **Providers with nothing to report** (ollama, plain OpenAI-compatible hosts)
  show no usage segment.

### Claude Code as a session type: what this must stay compatible with

Recorded so the usage and status-bar work does not close the door (see also
"Bigger goals" below):

- The status bar and daemon speak `UsageReport`, not z.ai/pi concepts. A Claude
  Code backend produces the same report itself: its subscription limits are
  the 5h / 7d windows (`rate_limits.five_hour.used_percentage` /
  `seven_day.used_percentage` in the status-line JSON Claude Code feeds
  its `statusLine` command - see the `statusline-command.sh` Ron already has);
  whether headless/stream-json mode exposes them is UNCHECKED. If it does not,
  a tiny statusLine command can write them to a file the daemon reads.
- `SessionMeta` fields added for the bar (provider, thinkingLevel, ctxTokens,
  ctxMax, usage, cost) must be producible by any backend: a backend fills what
  it can and the bar omits the rest (it already hides absent segments).
- Context/cost come from the backend's own stats call (pi:
  `get_session_stats`; Claude Code: the `result` messages' usage and total cost
  in stream-json). The daemon should not sum events itself except as a bridge.
- Backend candidates seen for pi/Claude interplay (all third-party, review
  before use): `pi-claude-cli` (a pi provider that shells out to `claude -p`),
  `pi-claude-bridge` (pi provider over the Agent SDK, with session resume),
  `claude-code-tmux` (drives the interactive CLI in tmux), `pi-claude-code-auth`
  (reuses the Claude Code OAuth login - its README warns it imitates
  subscription traffic; avoid). These make Claude models usable INSIDE a pi
  session. A native "Claude Code session type" instead means a second backend
  next to the pi RPC child (see below); the two are different goals, and the
  provider extensions are the cheaper first step if all that is wanted is
  Claude models in toriel.
- Sessions-as-files: Claude Code stores transcripts under `~/.claude/projects/`
  (JSONL, different schema from pi's). `itemsFromFile` / compaction display /
  rewind / clear all assume pi's entry format today; a Claude backend needs its
  own reader behind the same functions, and rewind/clear/fork would need
  backend-specific semantics (or be disabled for it).
- Slash commands: the CLI-style parser and registries are toriel-side and
  backend-neutral; a backend can contribute its own commands the way pi's
  `get_commands` does.

## Building blocks already shipped (audit 2026-10-22)

Things pi/pi-tui give us for essentially free (* = wire-up only), found
while scoping M2:

- *Input history: our InputEditor extends pi-tui's Editor, which already
  has prompt history (addHistory + internal up/down with draft restore),
  an emacs kill ring, an undo stack, word navigation, and bracketed-paste
  handling with paste markers - we just never called addHistory. Roadmap
  #5 shrinks to "call addHistory on send"; #4's text paste is mostly
  handled by the editor itself.
- *Clipboard: pi-tui exports getNativeClipboard -> getText/getImage/
  getFilePaths (Linux via command-line tools, i.e. wl-paste/wl-copy).
  Ctrl-V text paste is nearly free; image paste = clipboard.getImage()
  plus the RPC image-content-parts check.
- Image display: pi-tui Image component renders images in the terminal
  (kitty protocol + PNG transcoder). Pairs with image paste: transcripts
  could show what was pasted.
- *Per-session /model and /thinking: the RPC protocol already has
  setModel and set_thinking_level; pi ships model-selector and
  thinking-selector popup components. Daemon passthrough + popup = new
  per-session commands.
- Rewind popup: pi's user-message-selector component (its escape-escape
  popup) - noted in roadmap #6.
- Search: alt-screen-search (search the transcript), fuzzyFilter/fuzzyMatch
  (ctrl-r, fuzzy pickers), session-selector-search (searchable session
  list - borrowable for the switcher).
- Rich output: Markdown/MarkdownTheme components, pi's diff and
  bash-execution components (proper tool-call rendering), Loader/
  CancellableLoader (animated working indicator), renderLatex (!).
- Mouse: pi-tui MouseRegion - clickable switcher rows are possible.
  ON THE ROADMAP, LOW PRIORITY (Ron, 2026-10-22).
- Terminal integration: formatProgramStatus emits OSC 7501 program status
  (idle/working/blocked + reason) - the terminal tab title could show
  "toriel: 1 working, 1 blocked on permission" without focusing toriel.
- KeybindingsManager: centralized keybinding config - user-configurable
  keys later.
- Colors toolkit: parseColor/okhsl/styleText - utilities for the
  solarized theme work.
- Core: buildSessionProjection (leaf projection of branched session
  files - the fix for interleaved-branch replay, currently deferred).

Caveat: the interactive-mode components (user-message-selector,
model-selector, diff, ...) are NOT exported from the package index -
importing by internal path works but is fragile across pi updates. Ron
flagged this as a concern (2026-10-22): when we first use one of these,
evaluate the best mechanism before committing to raw paths. Candidate
plan, in preference order: (1) one upstream ask exporting the interactive
components AND the theme (bundle both); (2) a single local shim module
(e.g. src/pi-internal.ts) that re-exports every internal path we use,
so a pi update breaks exactly one file with obvious fixes; (3)
version-pin + smoke-test on pi upgrades. Decide at first use, not before.

Bigger goals - design-arounds, not scheduled:

- Claude Code as a session type (compatibility constraints for current work
  are collected under "Usage and quota in the status bar" above): keep the daemon protocol agent-neutral
  (prompt/abort/history/session-meta are already generic); the session
  abstraction needs to grow a backend interface (spawn args, event
  mapping) with pi as the first implementation. Claude's headless
  stream-json mode is the counterpart; its project session files map onto
  the session=file model.
- Agent definitions (purpose-built agents; NOT a priority, recorded so we do
  not close it off - discussed 2026-10-22). A named record the daemon spawns
  from: model/provider/thinking, system prompt (inline or file), tool
  allowlist, mcp/extensions/skills/context-file switches, optional default
  cwd and first prompt. The motivating case is a tiny-model session where
  pi's default prompt + tool/MCP list overwhelms the model; pi already has the
  flags (--system-prompt, --no-tools/--tools, --no-mcp, --no-extensions,
  --no-skills, --no-prompt-templates, --no-context-files), so a "minimal"
  agent is only extra spawn args. Constraints to preserve:
  - The daemon SNAPSHOTS the resolved definition into a per-session sidecar
    (next to session-groups.json, keyed by session file) at spawn. Lazy
    respawn (`--session <file>`) must reapply it, or a deactivated tiny
    session comes back with the full tool list. Editing a definition only
    affects new sessions.
  - Keep launch config backend-neutral: pi flags live under a `pi: {...}` key
    so Claude Code as a session type (above) is not shut out.
  - Agent-spawned agents (later) name a definition; they never pass raw args
    (an arbitrary-args spawn command is command injection by a model).
  - Sidecar can record `agent` and `parent` for switcher tags ([tiny]) and
    grouping; forks/adopt inherit the agent.
  - Open: definition location (user file vs per-project .toriel/agents vs
    both), keeping some pi extensions while dropping others (-e with
    --no-extensions, unverified). Cheapest first cut: a hardcoded `minimal`
    profile + `/new <name>` + sidecar + tag. Not planned: inheritance,
    templates, per-agent permission policy, an editor UI.
- Agent inter-communication by name (forks included): the daemon becomes
  a message broker. Needs stable session names (rename exists; make names
  first-class + unique), an addressing scheme (@name), and a
  pi-extension-provided tool that talks to the daemon socket (the
  presence extension already proves the socket path). Forks should
  inherit reachability.
- Sub-agent spawning: same tool path as inter-comm - an extension tool
  asking the daemon to spawn a child agent and return a handle/name;
  composes with budget (below).
- Budget tracking: per-controller (later per-agent) token budgets. The
  daemon already sums tokens/cost per session; add budget config, a
  daemon-side stop/refuse condition, and propagation into spawned
  sub-agents (needs the spawn tool).
- Web interface: the daemon protocol is transport-agnostic JSON
  (LineSplitter over unix socket today); a web UI is a WebSocket bridge
  plus a re-implementation of the controller's rendering. Keep daemon
  state terminal-free so this stays possible.
- Image paste into sessions (BUILT 2026-10-25 as ctrl-v with an [image #N]
  marker in the chat box; still open: show the image in the transcript, and
  downscale big ones; X11 path (xclip) written but never run). Original notes
  (Ron 2026-10-24): wl-paste ->
  controller -> daemon -> child. Verified 2026-10-24: pi's RpcClient
  `prompt(message, images?: ImageContent[])` (and steer/followUp) carry image
  parts, so the protocol supports it; toriel's `prompt` command is text-only
  today and would grow an `images` field. Gate on the model: pi drops images
  for a model whose entry lacks `input: ["text","image"]` (the read tool says
  "Current model does not support images"; hit 2026-10-24 on a LiteLLM model
  in models.json), so paste must check the session's model (`get_available_models`
  does not return modalities - read it from pi's registry or the child's
  state) and say so instead of silently sending nothing. Show what was
  pasted in the transcript (pi-tui Image component, see the clipboard notes
  above). Size matters for small local models (a 1.5 MB PNG overran a 16K-
  context Gemma): consider downscaling before sending.
- Tool manager (FUTURE GOAL, Ron 2026-10-23; supersedes "Extension manager"):
  one place to see and control what a session can use: pi extensions, MCP
  servers and individual tools, per session or per agent profile, instead of
  hand-editing settings and dotfiles. Building blocks that exist today: toriel
  owns pi/extensions and loads them by flag (resources.ts); pi's `packages`
  setting and `pi install` / `pi config`; `defaultTools` with +name/-name
  entries; `--tools` / `--no-tools` / `--no-extensions` / `--no-mcp` child
  flags; `tool_search`/`codemode` built-ins; `pi.registerMcpServer()`. Likely
  shape: a switcher-style list of tools/extensions/servers with on/off per
  agent profile (ties to "Agent definitions": the profile snapshot records
  the loadout, since a lazy respawn loses launch flags), plus install/update
  of the extensions toriel ships. Open: whether to flip tools on a LIVE
  session (pi's RPC surface for active tools is unverified) or only at
  spawn; where profiles live (the toriel settings file is the natural home).
  Today's de-facto version is resources.ts (toriel's own pieces, by flag) plus
  pi's own settings for everything the user chose.

## Risks

- pi-tui and the RPC protocol move with pi: pin the pi version; adapters
  isolated one-per-module; re-verify markdown reuse each upgrade.
- Two protocols to maintain (pi rpc + controller/daemon), three event
  vocabularies to normalize (pi events, session file entries, daemon
  records).
- Unified transcript model (live + replay) is the design linchpin; get it
  right before chrome.
- Memory per child unmeasured; cap + lazy deactivation mitigates.
- Exclusive-attach semantics can surprise (controller died while attached:
  daemon must release the lock).

## Session bridge (designed + built 2026-10-29; #16/#52/#47 successor)

Replace text-labeled `prompt(..., "steer")` injection of messages from other
sessions with a pi extension ("the bridge") that owns a per-session,
id-tracked injection queue, with graceful fallback to the legacy path.
Implements the #52 "option B" direction (authoritative state + events as
invalidation) on the write and queue-read paths, and fixes #16's pains
(history pollution, naming side effects, delivery that can strand) without
a pi fork. Only messages FROM OTHER SESSIONS use it: the user's own prompts
(including ones held during a compaction) stay ordinary user messages, so
rewind, naming and history behave as before.

Revised after review the same day: the first version held a second,
persistent socket per pi process (registry by session file, reconnect timer,
pid matching). It was replaced by the command route below, which uses the
pipe the daemon already has to each child and removes the whole class of
"which process is this" bugs (a stray pi opening the same file stealing the
bridge, a changed session file after /clear, a dead socket).

### Verified pi facts (spiked 2026-10-29, pi 1.3.0 installed / 1.4.0 pinned)

- An RPC `prompt` whose message names a registered extension command is
  handled immediately even during streaming; the command text never becomes a
  user prompt. The handler receives the raw argument string. `get_commands`
  lists the command (how the daemon detects the bridge).
- `pi.sendMessage({customType, content, display, details},
  {triggerTurn: true})` from a handler starts a run; over RPC the message
  streams as `message_start`/`message_end` with `role: "custom"`,
  `customType` and `details` intact. Checked against the real pi through the
  real daemon, not just the fake.
- `turn_end` and `agent_before_settle` handlers return
  `BoundaryResult {entries?, continue?}`; entries may be `custom_message`
  drafts and `continue: true` buys one more provider request with them in
  context. Entries appended this way are NOT announced as `message_*` events:
  pi emits `entry_appended {entry}` instead (with `details.id` intact), so
  the daemon and the controller handle both shapes.
- `ctx.ui.setStatus(key, text)` reaches the daemon as an
  `extension_ui_request` (the channel toriel-usage already uses).
- pi documents that a steer's queued state "is not guaranteed to remain"
  (rpc-commands.md) - the loss #47 hit is acknowledged upstream.

### Protocol

No new sockets or client commands.

- daemon -> bridge: `prompt("/toriel-inject {"id": "b7", "text": "<labeled
  body>"}")` over the child's RPC pipe. `text` is the formatReceived-labeled
  body, so the model sees what it always has and the controller renders the
  "from" row by parsing it.
- bridge -> daemon: `setStatus("toriel-bridge", {v:1, kind, ...})` with kind
  `injected {id}`, `failed {id, error}` or `requeued {ids}`. Only failures
  and recoveries need it; the append itself is seen directly (below).
- Confirmation: the daemon acks an inject when pi announces the append
  (`entry_appended`, or `message_end` with `role: "custom"`, carrying the id).
  The `injected` status is a second, redundant route.

### Delivery (extension, pi/extensions/toriel-session-bridge.ts)

`InjectQueue` holds `pending` (waiting for a chance) and `inflight` (handed to
pi, not yet seen in the transcript). Busy state is tracked from
agent_start/agent_settled.

1. idle: move one pending message to inflight and
   `sendMessage(custom toriel-inject, {triggerTurn: true})`; a throw reports
   `failed`.
2. mid-run: `turn_end` returns all pending messages as custom_message entries
   with `continue: true`; they move to inflight.
3. end-of-run: `agent_before_settle` does the same, closing the exit race that
   stranded steers (#47).
4. Confirmation from the transcript: at `turn_start` inflight ids found in the
   session branch are reported `injected`; at `agent_settled` those still
   missing (an abort between the hook and the append) go back to the front of
   `pending` (reported `requeued`) and are delivered on the next chance. Never
   requeued mid-run, when the append may just be late.
5. Aborted turns hand nothing over; messages stay pending, like queued
   steering. `session_shutdown` drops the queue (the process is going away).

### Daemon

`daemon-bridge.ts`: `BridgeTracker` (per daemon session id: injects handed
over and not yet confirmed, unique ids, the warn-once set), `injectedId`,
`parseBridgeReport`. `daemon-handlers-bridge.ts`: `deliverToSession` sends the
inject command when `s.sessionBridge` is true, else steers (warning once in the
log). `ChildManager.detectBridge` looks for the command in `get_commands` at
start and caches it as `s.sessionBridge` (shown in the session meta).
Failures: a refused command, or a `failed` report, hands the text to pi's
steering queue so it is not lost. A child that goes away with unconfirmed
injects broadcasts `exited` with a reason naming them, and the controller shows
it, so the sender's "delivered" is never silently untrue. The #47 refreshMeta
re-sync keeps held and bridge-pending texts in the strip.

### Visibility

A running session without the extension has `sessionBridge: false`; the
switcher notice line says how many (`bridgeNotice`; restart them). It was
log-only in the first version.

### Controller rendering

`toriel-inject` custom messages render as "from NAME" rows: `message_start`
(idle delivery), `entry_appended` (boundary delivery) and `itemsFromMessages`
(replay) each have a branch; rewind excludes them like received labels.

### Known limits

- A message held during compaction (from another session) is delivered through
  the bridge on release; the user's own held prompts are not.
- A session whose first input is such a message has no user message to name it
  by; it shows as an unnamed session until it has one.
- Images are never part of an inject (messages between sessions are text).

### Deliberately out of scope

Follow-up-mode injection, injecting into external (non-daemon) pi
processes, per-message delivery receipts surfaced in the UI, and the
#52 full snapshot-epoch transport (this is its write/queue half; the
read half is below).

## Display state: events invalidate, snapshots reconcile (#52 read half; 2026-10-29)

Problem: a controller's view is built by patching it with events. Whatever an
event stream misses (a controller not attached, a daemon restart, a boundary
entry that arrives as `entry_appended` instead of `message_start/end`) leaves
the view wrong until something replaces it. The rule: **events are hints that
update the view cheaply; a snapshot of pi's own state is the truth, and a view
is replaced from a snapshot whenever the two may differ.**

What is snapshotted: the transcript, via the existing `history` message
(`historyOf`: pi's `get_messages`, or the session file after a compaction).
Everything else already has a pull path: session metadata (`sessions`
broadcast, rebuilt from `get_state` by `refreshMeta`), the queue strip (the
`pendingMessageCount` re-sync at settle/start), dialogs (the daemon's
`pendingDialog`, resent on attach). Not snapshotted: scroll position, expanded
state, the editor.

When re-syncs run:

1. **Connect / reconnect**: the daemon's initial sync (history for every live
   child); the controller replaces each view and drops its transient state.
2. **Settle (drift check)**: `digest {messages}` after every run; a settled
   view whose seen-message count differs asks for `resync`. Never judged
   while streaming: events are in flight and a snapshot would race them.
3. **After operations that rewrite the transcript** (compact, clear, rewind,
   reload): the handler sends history, as before.

How the two event shapes reconcile: both are only ever *added* to the view by
`applyEvent` and both count as one message in `messagesAdded` (`message_end`
for user/assistant/toolResult/custom, `entry_appended` for custom messages), so
the count equals what `get_messages` holds regardless of which shape carried
the message. Assistant streaming is bound to the item its own `message_start`
opened (`view.streaming`): update/end events never fall back to "the last
assistant item", which is what drew thinking above newer output (#49) when a
start was missed. A message_end with no open item becomes a new item at the
end.

Known gaps: `bashExecution` messages have no message event, so `!command`
costs one false-alarm replay; the check is a count, so a same-count content
difference is not caught (a hash of roles + timestamps would be the next step);
metadata and the strip are reconciled by their own checks, not by the digest;
the data-driven item model (no TUI components in state) stays parked.
