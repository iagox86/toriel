# Permission grants: /permissions, persistence, timed grants

Design only (2026-10-31); nothing here is built. Tickets: #64 (the command),
#47 (grants survive restarts), plus the two filed with this document (#81 grant store
and chain link, #82 dialog options). Related: #79 (auto-deny after a timeout).

## What pi gives us, and what it does not

toriel has no permission system of its own; the gate is `@gotgenes/pi-permission-system`
in each child (installed 42.0.0). Facts checked in its source and docs:

- "Yes, allow X for this session" records a rule in an in-memory `SessionRules`
  object. It is never persisted and cleared on `session_shutdown` (docs/session-approvals.md).
  There is no public way to list it, add to it or remove from it.
- So today grants die on every child respawn, `/reload` and daemon restart (#47),
  and toriel cannot enumerate them (#64).
- Project config (`<cwd>/.pi/extensions/pi-permission-system/config.json`) is only
  honored for trusted projects and lives in the repo: wrong place for personal grants,
  and writing into a checkout from the daemon is not acceptable.
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
   Persistence across daemon restarts falls out of that, for free.
2. A new extension `pi/extensions/toriel-grants.ts` (in `resources.ts`, so the usual
   audit covers it) registers the link `toriel-grants` at `permissions:ready`. On an
   ask it sends the daemon `{session, surface, grants, value}` and answers `allow`
   when a live grant matches, else `defer`. Daemon unreachable, slow (over 1s) or
   confused: `defer`. The failure mode is always more prompting, never less.
3. The operator opts in once by adding `"authorizerChain": ["toriel-grants"]` to
   pi-permission-system's config.json. toriel never edits that file. The resources
   audit warns, with the exact line, when grants exist or the extension is loaded
   but the chain does not name the link (same style and silencing as
   `warnNoPermissionSystem`).

Alternatives rejected: patching or forking the package (maintenance cost, and
upstream is explicit that grants are ephemeral); answering the dialog from the
daemon when a grant matches (the dialog would still appear for a moment, race with
the user, and needs the same matching); writing a project config overlay (above).

### Limits that follow from the chain

- Grants cannot cover `path` / `external_directory` asks (their `allow` is capped to
  `defer`). For those only pi's native one-shot "for this session" option works, and
  it still dies on restart. `/permissions add` refuses these surfaces with that
  explanation, and the dialog extras are not offered on such an ask. This is a
  deliberate package guarantee, not something to route around.
- pi's own native session grants stay invisible. `/permissions` says so in a
  footer line instead of pretending the list is complete.

## The grant

```
Grant { id, session (uuid), surface, pattern, createdAt, expiresAt|null,
        source: "dialog"|"command", note? }
```

- Keyed by session UUID, like schedules: survives stop, park, respawn, `/reload`,
  daemon restart. Deleting the session removes its grants (same hook as schedules).
  A forked or spawned child session starts with none (no inheritance; revisit with the permission trickle-up ticket).
- Match: same surface, and the pattern equals the grant pattern pi suggested for the
  ask (`details.sessionApproval.grants`, e.g. bash `git status *`, mcp `exa:*`). A
  grant entered by hand with a wider pattern (`git *`) matches when it glob-matches
  the ask's value. Wildcard is `*` only, same as pi. Exact-suggestion matching is the
  safe default and needs no glob engine; the wider form is a spike item (below).
- Expiry is checked at ask time (an expired grant simply does not match), and swept
  from the listing. No timers needed. Default for dialog/`add` is the session
  (no expiry); timed is opt-in.
- Cap per session (say 100) so the store stays reviewable.
- Only user actions create grants: the controller commands and dialog answers. There
  is deliberately no agent tool to grant anything (same reasoning as `--until`).

### Threat model, stated plainly

- The store is a stored "yes". Anything that can write to it can self-grant. The
  daemon trusts only its in-memory copy after start, so editing the file while the
  daemon runs does nothing, but a restart reads whatever is there. Mitigation in v1:
  mode 0600 plus a documented recommendation to put `~/.local/share/toriel/**` under a
  pi `path` deny rule. A signed or MAC'd file is a possible v2 if that is not enough.
- The socket is user-level trust, like `bash` and `spawn`. A child's own bash tool can
  reach it. Cheap hardening worth doing: grant mutations are refused from connections
  that identified as a child (`TORIEL_SESSION_ID` hello). Decide at build time whether
  the existing extension connection can be told apart.
- Scope: grants never apply outside their session. No "always", no per-project scope
  in v1 (see open decisions).

## /permissions

Declared once in `src/commands.ts` with help and completion like the other families.

```
/permissions                          list this session's grants (id, surface, pattern,
                                      source, expires in 52m); footer: pi's own native
                                      grants are not listed
/permissions add <surface> <pattern> [--for 1h|--session] [--note ...]
                                      e.g.  /permissions add bash "git status *" --for 1h
                                      surface completes from: bash mcp tool skill
/permissions revoke <id|#id|pattern>  remove one; no argument opens a pick list
/permissions revoke --all
/permissions --help
```

- `--for` takes the same durations as the scheduler (`90m`, `1h30m`, `never`);
  `--session` is the default and means "until revoked or the session is deleted".
- In the switcher the command lists all sessions' grants (session named in each
  line), like `/schedules`. `add` is session-only (needs a target); revoke works
  anywhere.
- Echo on add says what it matched: `granted bash "git status *" for 1h (until 15:42)`.
- A small marker when grants are live: status segment `grants 3`; expiry shown in the
  listing, notice line when a grant expires while the session is viewed.
- Reuse: `pickSchedule`-style pick list, `fmtDuration`/`parseDurationText` from
  `when.ts`, listing in the info panel.

## Permission dialog extras (timed grants, ticket 2)

The dialog stays pi's, byte for byte (options are the literal answers). The controller
appends toriel's own rows below them, visibly marked, for asks where a grant is
possible (the dialog carries a recordable suggestion and the surface is not capped):

```
 1. Yes
 2. Yes, allow bash "sudo -V" for this session          (pi: dies on restart)
 3. No
 4. No, provide reason
 -- toriel --
 5. Yes, and allow "sudo -V" for 1 hour
 6. Yes, and allow "sudo -V" for this session (kept across restarts)
```

Choosing 5 or 6 answers pi with the plain "Yes" (so this one call proceeds), and tells
the daemon to store the grant. pi never sees the extra rows. The 700ms guard,
esc-means-deny and the deny-reason flow are untouched. Durations come from a setting
(`permissionGrantDurations`, default `["1h"]`).

Where the controller gets the pattern and surface: preferred is the link reporting
its `sessionApproval` suggestion to the daemon just before the dialog, which the
daemon attaches to the forwarded `ui_request`. Fallback is parsing the quoted
pattern out of pi's own "for this session" option text and the `tool :` title line,
the same kind of heuristic as `denyOption`. Spike first (below).

## Daemon and protocol changes

- `src/permissions.ts` (pure store, injected clock, like `Scheduler`): add, revoke,
  list, match, expiry, caps, load/save, `removeSession`.
- Client commands: `permission_list`, `permission_add`, `permission_revoke`.
  Extension command: `permission_check` (link to daemon). Dispatch is exhaustive, so
  all are compile errors until handled.
- `SessionMeta.grants` count for the status segment; a `notice` on expiry.
- `handleDelete` also drops the session's grants. `daemon-meta` unaffected otherwise.
- Settings: `permissionGrantDurations`, and a cap (`permissionGrantLimit`).
- Docs: `reference.md` section, README, the resources audit text, and
  `permission-dialogs.md` (the "no timeout / no controller-side policy" rules still
  hold: grants add policy by explicit user action, they do not time out dialogs).

## Spike before building (30 minutes, decides two details)

1. In a real child, register a link from `permissions:ready` that logs
   `details` for a bash ask, an mcp ask and a tool ask. Confirm: `payload.request`
   fields (surface, value), `sessionApproval.grants` content, that the link runs
   before the dialog, and that `allow` really suppresses the dialog.
2. Check correlation: does a queued second ask run its link before the first dialog is
   answered? That decides link-reported suggestion versus option-text parsing.
3. Measure the link round trip to the daemon (it adds latency to every ask).

## Open decisions for Ron

1. Scope of "kept across restarts": per session (recommended; matches schedules and
   the threat model) versus per project/cwd (convenient across sessions, but this is
   exactly the leak #47 warns about). Recommend session now, project later as an
   explicit opt-in if wanted.
2. The one-time `authorizerChain` line in pi's config.json: recommend toriel only warns
   and prints it (matches "the audit never changes anything"), not edits.
3. Hand-written wide patterns (`git *`): allow in v1 (glob against the request value),
   or exact-suggestion only until the spike is done. Recommend exact-only in the first
   cut, wide patterns in a follow-up commit once matching is proven.
4. Child sessions inheriting a parent's grants: recommend no, until permission trickle-up
   is designed.

## Later, not now

- `--permit "<surface> <pattern>"` on schedules, for unattended runs (pairs with #79).
- A `/permissions` picker with row actions, like the `/schedules` leftover.
- MAC on the store file.
