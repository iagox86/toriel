# Permission grants: /permissions, persistence, timed grants

Built 2026-11-01 (branch `permissions`): tickets #81 (grant store and chain link),
#64 (`/permissions`), #47 (grants survive restarts) and #82 (dialog rows). User-facing
description: docs/reference.md "Permission grants". This file is the design and the record
of why; where the build differs from the design as first written, "As built" below says so.
Related, not built: #79 (auto-deny after a timeout), #85 (agent tool `toriel_permission_check`).

## As built: where it differs from the design below

- Connections carry no identity. The extension talks to the daemon with one-shot socket
  requests (no hello), so `permission_check` takes the session UUID from its payload (the
  child's `TORIEL_SESSION_ID`), not from the connection: a caller could probe another
  session's grants (information only). The planned "refuse grant changes from child
  connections" guard could not be built as designed, because a child cannot be told from `nc`.
  What exists instead (added after review): `permission_add`, `permission_revoke` and
  `permission_restore` are refused on a connection that has not announced itself as a
  controller, i.e. whose first line is not `list` (the real controller always sends `list`
  first; src/daemon-server.ts). That stops an accidental self-grant, not a deliberate one: any
  caller that sends `list` first gets through. Real protection rests on dormant restore, the
  path rule and review of the grants file.
- Restoring saved grants is an explicit `/permissions restore` plus a status-line warning
  ("N saved grants off"), not a y/n panel on attach. Same property (a keypress-level user
  action is required, held in memory per daemon start per session), far less UI.
- The dialog's pattern comes from the link's report matched to the dialog by its `tool :` /
  `command :` title lines. There is no option-text parsing fallback: when nothing matches,
  no rows are offered.
- `permissionGrantDurations` defaults to `["1h", "session"]`: pi's own "for this session"
  row dies on restart, so the "kept across restarts" row is useful, not redundant.
- Expiry notices come from a 30 s sweep in the daemon; matching never depends on it.
- The extension reads the package's service from its documented `globalThis` map, because an
  extension outside the package cannot import it (found in the spike).
- Verified end to end against the real package (real daemon, real pi child, real model):
  the first `sudo -V` ask produced a dialog carrying `toriel.grants`, `permission_add` stored
  a one-hour grant, and the same ask in the next turn ran with no dialog.
- Not built: hand-written wide patterns (`git *`), mcp/non-bash dialog verification (the
  payload shape is read from source, not observed), a `/permissions` row-action picker.

## What pi gives us, and what it does not

toriel has no permission system of its own; the gate is `@gotgenes/pi-permission-system`
in each child (installed 42.0.0, used unmodified: no fork, no patch). Facts checked in
its source and docs:

- "Yes, allow X for this session" records a rule in an in-memory `SessionRules`
  object. It is never persisted and cleared on `session_shutdown`
  (docs/session-approvals.md). There is no public way to list it, add to it or
  remove from it.
- So today grants die on every child respawn, `/reload` and daemon restart (#47),
  and toriel cannot enumerate them (#64).
- Project config (`<cwd>/.pi/extensions/pi-permission-system/config.json`) is only
  honored for trusted projects and lives in the repo: wrong place for personal
  grants, and writing into a checkout from the daemon is not acceptable.
- The supported extension seam is the authorizer chain: a sibling extension registers
  a named link with `getPermissionsService(sessionId).registerAuthorizer(name, fn)`
  from a `permissions:ready` handler. When a request lands on `ask`, the configured
  links run before the dialog and may answer `allow`, `deny` or `defer`. A link does
  nothing until the operator names it in `authorizerChain` in config.json. The chain
  owner downgrades a link's `allow` to `defer` for the `path` and
  `external_directory` surface families; every other surface honors it.

## Decision: toriel owns the grants, a chain link enforces them

```
  /permissions, dialog extras --(client cmd)--> daemon: grant store (permissions.json)
                                                   ^
  child pi: ask -> toriel-grants link --(socket: "is this granted?")--+
            allow -> no dialog;  defer -> normal dialog
```

1. The daemon holds the store. It is loaded at start, kept in memory, written
   atomically (mode 0600) to `$XDG_DATA_HOME/toriel/permissions.json` on change.
   Persistence across daemon restarts falls out of that.
2. A new extension `pi/extensions/toriel-grants.ts` (in `resources.ts`, so the usual
   audit covers it) registers the link `toriel-grants` at `permissions:ready`. On an
   ask it sends the daemon `{session, surface, grants, value}` and answers `allow`
   when a live grant matches, else `defer`. Daemon unreachable, slow (over 1s) or
   confused: `defer`. The failure mode is always more prompting, never less. Two
   rules from the package: the chain does not catch a link's errors (a throw breaks the
   ask), so the whole link body sits in a catch-all that returns `defer`, and the 1s
   timeout also cancels the pending socket callback; and `permissions:ready` may fire
   more than once per session while registering a duplicate name throws, so
   registration is guarded and idempotent.
3. The operator opts in once by adding `"authorizerChain": ["toriel-grants"]` to
   pi-permission-system's config.json. toriel never edits that file. The resources
   audit warns, with the exact line, when the extension is loaded but the chain does
   not name the link (same style and silencing as `warnNoPermissionSystem`).

Alternatives rejected: forking or patching the package (rebase chore, and upstream is
explicit that grants are ephemeral); answering the dialog from the daemon when a grant
matches (the dialog would still appear, race with the user, and need the same
matching); a project config overlay (above).

### Limits that follow from the chain

- Grants cannot cover `path` / `external_directory` asks (their `allow` is capped to
  `defer`; the one niche exception is an `external_directory` ask carrying pi's
  nothing-on-disk license, which we do not rely on). For those only pi's native one-shot "for this session" option works, and it
  still dies on restart. `/permissions add` refuses these surfaces with that
  explanation, and the dialog extras are not offered on such an ask. This is a
  deliberate package guarantee, not something to route around.
- pi's own native session grants stay invisible to toriel. `/permissions` says so in a
  footer line instead of pretending the list is complete.
- A small latency cost on every ask (one local socket round trip). Measured in the
  spike.

## The grant

```
Grant { id, session (uuid), surface, pattern, createdAt, expiresAt|null,
        source: "dialog"|"command", note? }
```

- Keyed by session UUID, like schedules: survives stop, park, respawn, `/reload`,
  daemon restart. Deleting the session removes its grants (same hook as schedules).
  A forked or spawned toriel session has its own uuid and starts with none (no
  inheritance). Exception, by decision: an in-process pi subagent node shares its
  parent's process and so its `TORIEL_SESSION_ID`; its asks match the parent session's
  grants. Acceptable and probably desirable; it is absorbed by the permission
  trickle-up ticket (revisit with the
  permission trickle-up ticket).
- No per-project or "always" scope in v1: a grant never applies outside its session.
- Match: same surface, and the pattern equals the grant pattern pi suggested for the
  ask (`details.sessionApproval.grants`, e.g. bash `git status *`, mcp `exa:*`).
  Exact-suggestion matching needs no glob engine and is the first cut. Hand-written
  wider patterns (`git *`, glob-matched against the ask's value) are a follow-up once
  the exact form is proven.
- `--for never` is an explicit alias of `--session` (the shared duration parser
  accepts `never`).
- Expiry is checked at ask time (an expired grant simply does not match) and swept from
  the listing. No timers. Default for dialog/`add` is the session (no expiry); timed is
  opt-in.
- Cap per session (100) so the store stays reviewable.
- Only user actions create grants: controller commands and dialog answers. No agent
  tool grants anything (same reasoning as `--until`).

### Threat model, stated plainly

The store is a stored "yes", and the agent runs as the same uid as everything it
could attack. Today a session with plain `bash` can already edit pi's `config.json`
(loosening its own policy, or removing the `authorizerChain` line), write
`~/.local/share/toriel/`, or talk to the daemon socket. The grant file adds no new class
of risk, but nothing in place stops tampering with it, and a same-uid agent with an
unrestricted shell cannot be fully contained short of sandboxing (the container
ticket). What the design does:

1. Dormant on restart. Grants loaded from disk at daemon start are NOT applied. The
   first controller to attach to a session with saved grants shows "3 saved
   permission grants: re-enable? (y/n)" and only a keypress activates them. A
   tampered file therefore needs the user's confirmation. (Grants created in the
   running daemon apply immediately; only restore-from-disk is gated.) The answer is
   remembered once per daemon start per session, in memory only: one keypress per
   restart, not one per attach. It is never persisted, because a stored confirmation
   would sit in a file the same agent can write.
2. The daemon trusts its in-memory copy once running; editing the file mid-run does
   nothing.
3. Grant changes (`permission_add`, `permission_revoke`, `permission_restore`) are refused
   on a connection whose first line is not `list`: the real controller announces itself that
   way, a stray one-shot caller does not (the refused line does not even sync it as a
   controller). This is a seatbelt against accidental self-granting, not a wall: a caller that
   sends `list` first gets through, `nc -U` from bash included. Connections carry no
   identity, so `permission_check` trusts the session UUID in its payload; probing another
   session's grants is possible and reveals only whether a pattern is granted.
4. File mode 0600, atomic writes.
5. Path rules in pi's config (first line of defense; the package does not protect its
   own config or any file by default, and Ron's config has no `path` key today). A `path`
   rule covers the built-in file tools, bash path tokens (redirects, `sed -i`), MCP
   path arguments and extension tools; it matches the path as written and its
   symlink-resolved form; a `deny` cannot be overridden by a per-tool allow; unparseable
   bash and wrapped commands (`bash -c`, `eval`, `sudo`, `xargs`) drop to `ask`.
   Suggested set, merged into `permission` (the catch-all must come first, last match
   wins):

   ```json
   "path": {
     "*": "allow",
     "~/.local/share/toriel/permissions.json": "ask",
     "~/.pi/agent/extensions/pi-permission-system/*": "ask",
     "~/.pi/agent/settings.json": "ask"
   }
   ```

   `ask` for the grant file, so an agent that wants to write permissions can, but only
   with Ron's approval each time (reads of it ask too: path rules have no read/write
   split); `ask` for pi's config and settings, so the agent cannot loosen its own policy
   unnoticed but Ron can still approve edits while configuring pi. Use `deny` instead if
   no agent should ever touch the grant file. Scoped to the one file, not the whole
   toriel data dir, so agents working on toriel itself are not blocked. A toriel grant
   can never cover these asks (path asks are capped, see the limits), so an agent cannot
   approve its own write to the file by getting a grant first.
   Optional: deny `/run/user/*/toriel.sock` to block `nc -U` from bash (only matches
   when the path is written out; pi does not expand `$XDG_RUNTIME_DIR`).
   Limits: a shell can build a path indirectly (`python -c`, variable-built paths),
   and `deny` blocks reads too. A strong speed bump, not a wall. The patterns are
   untested against 42.0.0: the spike verifies a write via the edit tool, a redirect and
   `sed -i` are each blocked.
   toriel's resources audit warns when no `path` rule (`ask` or `deny`) covers
   `permissions.json`, and prints the suggested rules. It never edits the config.

## /permissions

Declared once in `src/commands.ts` with help and completion like the other families.

```
/permissions                          list this session's grants (id, surface, pattern,
                                      source, expires in 52m); footer: pi's own native
                                      grants are not listed; saved grants awaiting
                                      re-enable, if any
/permissions add <surface> <pattern> [--for 1h|--session] [--note ...]
                                      e.g.  /permissions add bash "git status *" --for 1h
                                      surface completes from: bash mcp tool skill
/permissions revoke <id|#id|pattern>  remove one; no argument opens a pick list
/permissions revoke --all
/permissions --help
```

- `--for` takes the same durations as the scheduler (`90m`, `1h30m`, `never`);
  `--session` is the default.
- In the switcher the command lists all sessions' grants (session named in each
  line), like `/schedules`. `add` needs a session; revoke works anywhere.
- Echo on add says what it matched: `granted bash "git status *" for 1h (until 15:42)`.
- Markers: status segment `grants 3`; expiry has no timer, so the notice appears on the
  next list, ask or status refresh after the instant passes (the 5s keep-awake tick
  can drive a prompt one if wanted); notice line when a grant expires while the
  session is viewed.
- Reuse: `pickSchedule`-style pick list, `fmtDuration`/`parseDurationText` from
  `when.ts`, the info-panel listing.

## Permission dialog extras (#82)

The dialog stays pi's, byte for byte (options are the literal answers). The controller
appends toriel's own rows below them, visibly marked, for asks where a grant is possible
(the dialog carries a recordable suggestion and the surface is not capped):

```
 1. Yes
 2. Yes, allow bash "sudo -V" for this session          (pi: dies on restart)
 3. No
 4. No, provide reason
 -- toriel --
 5. Yes, and allow "sudo -V" for 1 hour
 6. Yes, and allow "sudo -V" for this session (kept across restarts)
```

Choosing 5 or 6 answers pi with the plain "Yes" (so this one call proceeds) and tells
the daemon to store the grant. pi never sees the extra rows. The 700ms guard,
esc-means-deny and the deny-reason flow are untouched. Durations come from a setting
(`permissionGrantDurations`, default `["1h"]`).

Where the controller gets the pattern and surface: the link reports its
`sessionApproval` suggestion (with the ask's `requestId` and command) to the daemon just
before the dialog. The spike showed asks are serialized per session (one pending dialog
at a time) and that the dialog's own id and title do not carry `requestId`, so the daemon
keeps the latest suggestion per session and attaches it to the next `select` dialog whose
`tool :` / `command :` title lines match the reported value (the request is a free-form
record, so it can be decorated). Fallback when nothing matches: no extra rows are
offered, or the quoted pattern is parsed out of pi's own "for this session" option text
(the same kind of heuristic as `denyOption`).

## Daemon and protocol changes

- `src/permissions.ts` (pure store, injected clock, like `Scheduler`): add, revoke,
  list, match, expiry, caps, load/save, `removeSession`, restore gating.
- Client commands: `permission_list`, `permission_add`, `permission_revoke`,
  `permission_restore`. Extension command: `permission_check` (link to daemon).
  Dispatch is exhaustive, so all are compile errors until handled.
- `SessionMeta.grants` count for the status segment; a `notice` on expiry.
- `handleDelete` also drops the session's grants.
- Settings: `permissionGrantDurations`, `permissionGrantLimit`.
- Docs: `reference.md` section, README, the resources audit text, and
  `permission-dialogs.md` (the "no timeout / no controller-side policy" rules still
  hold: grants add policy by explicit user action, they do not time out dialogs).

## Spike results (2026-11-01, pi 1.3.0, pi-permission-system 42.0.0)

Run in an isolated pi agent dir (a throwaway link extension, real model, rpc mode).
Items not covered are marked.

- `permissions:ready` fired twice per session (session_start, first turn): the
  registration guard is required, as documented.
- The link receives `requestId`, `command`, `toolName`, `source`, `payload.request`
  (surface, value, matched rule) and `sessionApproval.grants`, e.g. `[{surface:"bash",
  pattern:"sudo -V"}]`. The suggestion is the EXACT command for these asks
  (`dnf --version` suggests `dnf --version*`), so exact-suggestion matching is
  narrow: a grant covers the same command, not the family.
- The link runs before the dialog, and `allow` suppresses it (`sudo -V` ran with no
  dialog while `dnf` still asked). A `defer` falls through to the normal dialog.
- A link that THROWS makes the gate fail closed: the tool call is blocked with
  "Permission gate failed and blocked the tool call (fail-closed)". So the catch-all
  returning `defer` is essential, not hygiene.
- There is no timeout in the package: a link that takes 3s delays the ask by 3s. Our
  1s timeout (then `defer`) is ours to enforce.
- Asks are serialized per session: with two asking tool calls in one turn, the second
  ask's link did not run until the first dialog was answered (3s later with a slow
  answer). So at most one dialog is pending per session. The dialog request id
  (a UUID) is NOT the `requestId`, and the title does not carry it. Correlation is
  therefore: the daemon keeps the latest suggestion per session and attaches it to
  the next `select` dialog whose `command :` / `tool :` title lines match the
  reported value. Option-text parsing remains the fallback.
- Not measured: the daemon round trip (no daemon yet; the link itself added 0ms).
  Not tested: mcp and non-bash tool asks (the payload shape for those is read from
  source, not observed).
- Path rules (absolute-path deny on a `permissions.json`), observed:
  - blocked: the write tool, `echo > file`, `sed -i`, `cp`, `cat` (reads too), and a
    relative path after a literal `cd` (`cd dir && echo a > permissions.json`);
  - ASKED (opaque wrapper): `bash -c "echo d > file"`;
  - NOT blocked: `python3 -c "open(...).write(...)"` with a built-up path string, and
    `d=...; f=...; echo c > $d/$f` (variable-built path). Both overwrote the file.
  So the rule is a real speed bump against direct and common edits, and defeated by
  trivial indirection, exactly as the limits above say. It does not make the file safe
  against an agent that tries; dormant-on-restart (item 1) is what covers that.

- `ask` on the grant file (Ron's preferred setting, so agents may write it with approval),
  observed: the write tool and a `cat` each open a dialog (`surface : path_write` /
  `path_read`); "No" blocks and leaves the file unchanged, "Yes" lets the call through.
  Caveat: the dialog also offers pi's own "Yes, allow writes to <path> for this session";
  choosing that stops further prompts for that file for the rest of the session (it dies
  with the child). Say "Yes" rather than the session option when writing the grant file.

## Spike before building (original plan; see results above)

1. In a real child, register a link from `permissions:ready` that logs `details` for a
   bash ask, an mcp ask and a tool ask. Confirm `payload.request` fields,
   `sessionApproval.grants` content, that the link runs before the dialog, and that
   `allow` really suppresses it.
2. Correlation, repeated `permissions:ready`, link throw: done, see results.
3. Measure the link round trip to the daemon.
4. Verify the suggested `path` rules (threat model, item 5) against the installed
   package: edit tool, shell redirect and `sed -i` on `permissions.json` are blocked.

## Order of work

1. Spike, then #81 (store, extension, protocol, audit check, tests).
2. #64 (the command).
3. #82 (dialog rows).

## Later, not now

- `--permit "<surface> <pattern>"` on schedules, for unattended runs (pairs with #79).
- A `/permissions` picker with row actions.
- Wider hand-written patterns; per-project scope as an explicit opt-in.
- If path-surface grants ever matter, revisit carrying a patched fork (pi's `git:`
  sources can be pinned by commit); not needed for v1.
