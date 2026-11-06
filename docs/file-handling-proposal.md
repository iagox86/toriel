# File-handling layer proposal

Status: PROPOSAL - not decided, not implemented. Drafted 2026-11-05 from
Vikunja tasks 148, 63, 13 plus two Claude design consults. Awaiting Ron's
review; nothing here is committed to a plan of record until he signs off.

## The theme

Four work items keep pointing at the same layer:

1. **148 - scoped agents.** Chroot-style file confinement for subagents via a
   profile `scope:`/`root:` key. Motivated by the worktree-rail violation
   (2026-11-05): a worker wrote into the main checkout despite its brief.
2. **63 - tool efficiency.** Compare pi's shipped read/write/edit against
   Claude Code's (token cost, round trips, error recovery); possibly ship
   toriel tool overrides. Also: worktree tooling, git tools, one-shot prompt
   tools.
3. **13 - open file tracking.** Freshness state per session: refuse edits to
   files the session has not read, refuse writes to files changed underneath
   it, notify on external change (Claude Code's pattern).
4. **Containers.** Two shapes, both on the board: ticket 15 is the original
   "run the daemon in a container, UI outside"; the newer child-sandbox idea
   confines individual agent children at the spawn seam so boundaries are
   enforced, not advisory - the only real fix for the bash-indirection gap.
5. **98 - file triggers.** Run a prompt when a watched file or directory
   changes (born from the permissions.review.md poll experiment). This is
   filesystem-watching infrastructure - and watching turns out to be the
   shared primitive this whole layer wants (see "The watcher" below).

The observation that ties them: 13 and 63 both want toriel to own the file
tools, and owned tools are also the strongest 148 enforcement point. The
container closes what tools cannot, and 98's watcher gives the layer what
neither tools nor containers advertise: *detection*.

## The watcher (ticket 98's infrastructure, reused)

Ticket 98 needs a daemon-side watcher (fs.watch/inotify) that fires prompts
when watched paths change. That same primitive serves the rest of the layer:

- **Freshness notifications (13).** The extension's in-memory store knows
  what a session has read; a daemon-side watcher on those paths is how
  turn-start/cross-session change notices actually fire without polling.
- **Advisory out-of-scope detection (148).** Enforcement (tools, deny link,
  sandbox) prevents; it cannot report what slipped past the bash-indirection
  gap. A watcher covering a scoped agent's surrounding tree can SEE a write
  appear outside its root and notify - turning the known speed-bump hole into
  a detected event instead of a silent one. Not a wall, but an alarm.
- **File triggers (98).** Unchanged: watch -> deliver prompt, same delivery
  machinery as schedules.

Design note: keep the watcher a daemon-side pure module (watch-set management,
debounce, event normalization) with the trigger/prompt delivery layered on
top; the extension reports interesting paths to the daemon through the
existing session protocol when freshness tracking lands (protocol change,
`PROTOCOL` bump - batch it with that work).

## Verified facts (148 recon, 2026-11-05)

- pi-permission-system is `@gotgenes/pi-permission-system`, a pi package, not
  vendored in this repo; config at `~/.pi/agent/extensions/pi-permission-system/config.json`.
- Surfaces: `path`, `path_write`, `external_directory` (+ `bash`, `mcp`,
  `tool`, `skill`). Path rules parse bash path tokens (they block the write
  tool, redirects, `sed -i`, `cp`, `cat`) but miss `python -c` and
  variable-built paths; `bash -c` drops to `ask`.
- Rules are global config - one file per agent dir. No per-session injection
  seam.
- Authorizer chain: links answer allow/deny/defer; the chain owner downgrades
  a link's ALLOW to `defer` on path surfaces (so toriel-grants can never cover
  path asks) but honors DENY on all surfaces. toriel ships one link already
  (`pi/extensions/toriel-grants.ts`).
- Injection points: `src/daemon-children.ts` launch/startArgs (~:105-185)
  composes cwd/env/args for every child; `src/agents.ts` frontmatter `KEYS`
  whitelist (~:48); `src/daemon-subagents.ts` ~:275 creates subagent sessions
  at `parent.cwd`.
- docs/permissions.md:295-303 spike and docs/reference.md:301 ("a speed bump,
  not a wall") document the escape routes.

## Proposed architecture

Three parts; policy input, enforcement, and shared logic kept separate:

```
daemon spawn seam          src/daemon-children.ts (+ daemon-subagents.ts)
  profile scope: key  ->   sets child cwd + TORIEL_SCOPE_ROOT env (policy
                           input only, no logic)
        |
        v
toriel-files extension     pi/ (runs inside the child)
  - tool overrides: read/write/edit with a realpath jail (the wall)
  - freshness store: Map<realpath, {mtimeMs, size, hash?}> in memory
  - turn-start hook: re-stat tracked files, inject change notes (later)
        |
        v
src/file-scope.ts          pure module, unit-tested
  realpath resolution, symlink handling, root check
  imported by BOTH the extension and the authorizer link so the two
  jails cannot drift
        |
        v
toriel-scope authorizer    pi/ (second chain link, DENY-only)
  answers DENY for path/path_write/external_directory asks outside the
  root - covers bash (speed bump) and every tool we do NOT override
```

Key decisions, per the consults:

- **Tools enforce AND the link exists.** A realpath check inside an owned
  tool is a real wall for that tool's structured args - stronger than anything
  the authorizer chain offers (and immune to the allow-to-defer quirk, since
  the tool refuses itself). The link still adds: bash coverage (best-effort),
  every non-overridden tool (grep/find/ls, MCP tools with path args), and a
  backstop if an override fails to load.
- **Write jail strict, read jail deny-by-default (decision, Ron 2026-11-06).**
  Reads outside the root are denied unless the resolved path is inside an
  allowed root. The allowlist names RESOLVED targets, not link paths:
  `node_modules -> ../main/node_modules` works when that target is allowlisted
  (read-only), a symlink to `~/.ssh` resolves outside every allowed root and
  is denied. The rule lives in file-scope.ts: deny unless the realpath is
  inside an allowed root - so following symlinks is safe by construction.
- **Freshness lives in the extension, in memory.** It is the only place that
  sees every tool call, and it matches process lifetime: a sleeping session
  has no process, and after resume the model must re-read anyway - correct
  behavior. Minimal core: refuse edit/write of an existing unread file; refuse
  write when mtime/size differ from the record (hash only when mtime changed
  but size did not); errors tell the model to re-read; creating new files is
  always allowed. Turn-start change notification and cross-session
  (daemon-mediated) awareness are later steps; cross-session needs a protocol
  change and a `PROTOCOL` bump.
- **Fail closed.** A scoped child that starts without the extension (or the
  permission system) loaded refuses to start - scope that silently does
  nothing is worse than no scope.
- **Grandchildren clamp.** A scoped child's own spawns inherit the root or a
  narrower one; the daemon enforces this at the spawn seam (today subagents
  are created at `parent.cwd`, so this is also where per-subagent cwd lands).
- **Agent tool surface (decision, Ron 2026-11-06).** Scoped agents get the
  git MCP's new structured per-verb tools (git_status/git_diff/git_log/... -
  ticket 152: typed args, server-built argv, gateable by name) at allow;
  the raw `git_read` facade stays `ask` for supervised full agents; no
  github MCP, no shell git, no `SSH_AUTH_SOCK` in the sandbox. The 151 fix
  (repo-config execution holes) lands first; 152 builds on it. If the raw
  facade is ever needed for agents, its audit gate applies.
- **Two enforcement layers, in order (decision, Ron 2026-11-06).** Phases
  1-4 are scoping (tool jail + deny link + cwd): a wall for the file tools,
  a speed bump for bash. Phase 5 is sandboxing (bwrap): kernel-enforced,
  closes bash indirection. Each ships standalone; the sandbox does not gate
  the scoping work.
- **Scope-able grants (follow-up feature, Ron 2026-11-06).** toriel owns the
  toriel-grants chain link, so grants can become root-conditional: a grant
  answered for a scoped session passes the command's path tokens through
  file-scope.ts, and out-of-root path asks still hit the deny link. This
  keeps scoping inside the existing day-to-day permission UX ("allow bash
  for 1 hour" implicitly reaches only inside the root) instead of running a
  parallel system. Designed for from the start (env/seam shape), built as a
  later phase.
- **User sessions get the same path later**: an opt-in `--root <dir>` flag on
  session spawn, same env, one code path (subagents-only for the first cut,
  decision 2026-11-06 - but the seam is built so this drops in).

## Verify-first results (2026-11-06, explore agent #8)

1. **Extension tool replacement: YES.** pi's registry merge puts
   extension tools over built-ins (`agent-session.js:2922-2926`), and
   `pi/extensions/toriel-jobs.ts` already ships a same-named `bash` replace
   (docs/design.md:1191). `--no-builtin-tools`, `--tools +name/-name` and
   `--exclude-tools` also exist. Phases stay in order; owned read/write/edit
   is viable.
2. **Authorizer chain semantics: PARTIALLY UNKNOWN.** The package source is
   not on disk (only its config.json), so first-non-defer-wins vs any-deny
   and the bash ask-count cannot be confirmed from code. The allow-to-defer
   downgrade is documented and was verified against installed source on
   2026-11-01 (docs/permissions.md:58-60) - rely on that; re-verify chain
   order and ask-count after reinstalling the package BEFORE designing the
   deny link around them.
3. **pi hooks: YES / YES.** `tool_call` blocks execution via
   `{ block: true, reason }` (docs/extensions.md:106, 282-290); turn-start
   injection via `pi.sendMessage(..., { triggerTurn: true })` plus a
   `before_agent_start` handler returning a message (docs/extensions.md:216).
   No new pi capability needed for the enforcement seam or ticket-98-style
   triggers.
4. **git_read audit: NOT SAFE as-is** (ticket 151, board 6). Config argv is
   already blocked, but repo-LOCAL config executes code: `diff.external` /
   `diff.<driver>.textconv|.command` via diff-family reads, `gpg.program`
   via `verify-commit`, `remote show` honoring `ext::` transport URLs. A
   scoped agent that can write its root can edit `.git/config`, so the repo
   pin does not help. Fix the git MCP (sanitize config at execution, drop
   `verify-commit`/`remote show` from the read allowlist, or sandbox the git
   process) before any scoped-agent rollout relies on it.

## Build process (Ron, 2026-11-06)

We are building toriel from within toriel - the running daemon hosts the
sessions doing the work, so merges must not break the builder.

- **Default: standalone, dormant-by-default chunks through the normal PR
  flow.** A chunk that changes nothing until it is used (file-scope.ts,
  `scope:` frontmatter parsing, spawn-seam env, the deny link extension
  shipping inert until added to the authorizer chain config, doctor entries,
  the opt-in bwrap wrapper, the watcher module) merges to main as soon as its
  gates pass. Each is individually testable; behavior only appears when a
  scoped profile or flag is set.
- **Feature branch for live-on-merge chunks.** Anything that changes
  behavior for ALL sessions the moment it merges (phase 2's tool overrides
  replacing read/write/edit; phase 4's turn-start injection) builds on a
  dedicated feature branch, is dogfooded with `toriel --isolated` plus real
  sessions, and merges only after surviving real use. Consider a setting
  gate for the first cut so even the merge stays opt-in.
- **Never break the manager:** daemon-startup-affecting changes get an
  isolated run plus doctor before merge; the live daemon is always running
  last-known-good main.

## Container track

Two distinct ideas; do not merge them.

**Child sandbox (the minimum viable wall for bash).** Bubblewrap at the spawn
seam as an argv prefix on the pi child. Recommended shape: `--unshare-pid
--unshare-ipc --die-with-parent`, share the network, fresh `/proc` and `/dev`,
`/tmp` and `$HOME` as tmpfs with read-only binds back in for what the child
needs (`~/.nvm` node install, pi config/auth, `.gitconfig`, `known_hosts`) and
read-write binds for what it writes (the worktree, the pi sessions dir).

What breaks, and the answers:

- Worktrees: the `.git` file points into the main repo's common dir - the
  common git dir must be writable, with `hooks/` and `config` read-only
  (code-exec paths back out). Note this reopens git-object writes the jail
  was meant to close.
- node_modules symlinks: bind targets at identical absolute paths; never
  remap.
- ssh-agent: binding `SSH_AUTH_SOCK` lets the child sign anything the agent
  holds - prefer a dedicated deploy key or https token for subagents.
- Credentials: `auth.json` must be readable, so a hostile child can still
  exfiltrate it over the shared network. bwrap does not fix this; state it.
- Fail closed: sandboxing requested but bwrap missing or user namespaces
  disabled = refuse to spawn. Doctor gets a `CATALOG` entry (bwrap on PATH
  plus a trial run), a test (fake-pi under the wrapper, write outside the
  worktree must fail), and a reference.md line.

Landlock: attractive (paths unchanged, symlinks/sockets just work, deny-only
fits) but no stock CLI and no node binding - needs a small native helper.
Park unless bwrap disappoints.

The wrapper is payload-agnostic: pi children AND claude invocations (ticket
154's delegation wrapper) take the same bwrap manifest, parameterized. For
delegation-to-claude there are two profiles: reviewer-tight (ro-bind the
repo, no worktree write, rw-bind only the findings output file - a tmpfs
/tmp path vanishes with the namespace - plus ~/.claude rw for transcripts
and auth, shared API network) and worker-loose (adds the worktree rw).
Claude Code also ships its own bash sandboxing (bwrap/Seatbelt) - verify the
installed version supports it and use as defense-in-depth, not the wall.

**Daemon in a container (the original container ticket).** Run the whole
daemon in a container, controller outside: bind-mount the unix socket (never a
network port - the protocol has no auth; socket permissions are the gate),
keep agent children INSIDE the daemon's container (sibling containers need the
podman socket mounted in, which is host-equivalent power), mount workspaces at
identical absolute paths (the protocol carries cwds and the UI shows host
paths). Buys bounded blast radius and pinned dependencies; does not give
per-agent worktree rails - all sessions share one container. Orthogonal to and
later than the child sandbox. Separate ticket when someone wants it.

**Podman MCP: skip.** The spawn seam uses `execFile("podman", ...)`/bwrap
directly; experiments use plain podman in a shell. Exposing container
management to agents is itself an escape route - rootless podman acts with the
user's full authority.

**Residual gaps to state plainly in whatever ships:** network exfiltration
(shared net), readable `auth.json`, shared git object writes. The container
path is worth it at the bwrap level; full OCI per child is not yet.

## Phasing (each phase ships standalone value)

1. **Scoping (148 rescope).** `src/file-scope.ts` + tests; `scope:` frontmatter
   key (agents.ts whitelist, profileArgs); spawn seam sets cwd + env;
   toriel-scope DENY link ahead of toriel-grants in the chain; fail-closed
   start; grandchild clamp; doctor CATALOG entry (permission-system
   dependency + scope requirements); docs (permissions.md, reference.md).
2. **Tool overrides with the jail.** Owned read/write/edit importing
   file-scope.ts - writes become a hard wall; fold the 63 efficiency findings
   (error messages, round-trip cost) in here since we are overriding anyway.
3. **Freshness core.** Small once overrides exist: read-before-edit, stale
   write block, re-read errors.
4. **Turn-start change notification.** Re-stat at turn start, inject a note.
5. **Child sandbox (bwrap).** Doctor entry, spawn-seam wrapper, fake-pi test.
   Can start in parallel with 2-4 (it does not depend on them).
6. **User `--root` flag; scope-able grants; cross-session tracking; daemon-in-container (ticket 15); out-of-scope watcher alarm; file triggers (98).** Parked
   until asked for; the watcher module is the one piece worth building early
   if 98 moves.

Swap rule: if verify-first #1 fails (no tool replacement), swap 1 and 2 - the
authorizer link carries the jail, and freshness becomes a wrapper tool.

## Decisions (Ron, 2026-11-06)

1. Read jail: deny-by-default with resolved-target allowlist (decision 1).
2. First cut is subagents-only; the seam is built for user `--root` and
   scope-able grants later (decision 2).
3. Agents use only the git MCP read facade, no github, no ssh-agent; the
   facade's safety is a verify-first gate (decision 3).
4. Build order stands: sandbox stays at phase 5 (decision 4).
5. Daemon-in-container (ticket 15) remains a separate future plan.

## Former open questions (resolved above)

- Read jail default: deny-outside-root with allowlist - DECIDED (1).
- Subagents-only vs `--root` now - DECIDED (2).
- ssh-agent tradeoff - MOOT (3): agents never see `SSH_AUTH_SOCK`.
- bwrap queue position - DECIDED (4): stays at phase 5.
