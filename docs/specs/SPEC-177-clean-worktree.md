# SPEC-177: Clean worktree semantics (T12)

Ticket 177, board "Toriel - base". Two changes so a subagent working in a worktree has
zero permission dialogs: subagents spawn at the *requested* cwd (not the parent's), and
subagents are seeded with read-only git/gh grants plus a copy of the parent's active
grants.

## Motivation

Verified live: `src/daemon-subagents.ts:276` spawns a subagent with `ctx.registry.create(parent.cwd)`,
and the daemon log shows the ticket-176 worker got `scope for ...: /home/ron/projects/toriel (mode ask)`
- the manager's cwd, not the worktree. So a worktree worker's writes are outside its
scope root and every write asks (`external_directory_write`). Separately, a worker that
tries to read repo state with git (`git status`, `git diff`) hits the config's `git *`
ask rule and prompts. Both halves must be fixed for zero-dialog worktree work.

## Part 1: spawn subagents at the requested cwd

- `src/shared.ts` `agent_spawn` (line ~168): add `cwd?: string` (an absolute path; the
  spawn protocol carries an explicit cwd elsewhere, so this matches the convention).
- `pi/extensions/toriel-agents.ts` `toriel_agent` tool (line ~199-214): add a `cwd`
  parameter to the tool's schema ("Optional absolute path; the subagent runs there
  instead of the parent's cwd") and pass it through (`...p` already spreads it, so only
  the schema and the local `p` type change). The manager (a session) spawns workers
  through this tool, so without it the protocol field would be unreachable.
- `src/daemon-subagents.ts` `start()` (line ~236): validate `cmd.cwd` if present
  (`fs.existsSync`, else throw with the same style as `daemon-children.ts:108`'s
  "working directory no longer exists" message). Then `const child = ctx.registry.create(cmd.cwd ?? parent.cwd);`
  (replacing line 276).
- Note the scope consequence: with cwd = a linked-worktree root, `scopeForSession`
  (`src/daemon-children.ts:111`) now assigns the worktree as the scope root in **deny**
  mode, which is exactly the intent: writes inside the worktree are silent, writes
  outside are denied (the manager commits).
- `findAgent(cmd.agent, ...)` (line 237) keeps using `parent.cwd` for the *profile*
  lookup: project agents are found relative to the parent's cwd by design. Only the
  child's *launch cwd* changes.

## Part 2: seed read-only grants at spawn

- New module-level list in `src/subagents.ts` (or a small new module `src/seed-grants.ts`
  if you prefer; tests may be easier there): the read-only git/gh grants seeded for every
  subagent, as `{ surface: "bash", pattern: string }` pairs:
  - `git status*`, `git diff*`, `git log*`, `git show*`, `git blame*`, `git grep*`,
    `git branch*`, `git remote*`, `git fetch*`, `git pull*`
    - `fetch`/`pull` are network *reads* (they update the working tree but never push);
      include them, a worker refreshing its branch is legitimate.
  - `gh pr view*`, `gh pr list*`, `gh pr checks*`, `gh pr diff*`, `gh issue view*`,
    `gh issue list*`, `gh repo view*`
  - The trailing `*` in each pattern is what makes the grant cover the argument
    variants (`git status` covers `git status --short` under T11's glob matching, and
    `git status*` covers the ask `git status *`).
  - Deliberately NOT seeded: anything that mutates (`commit`, `push`, `checkout`,
    `rebase`, `merge`, `add`, `reset`, `stash`, `rm`, `gh pr create/merge`, `gh issue
    create/edit`) - workers don't mutate repos; the manager commits.
- Seeding happens in `start()` after the child is launched and its `sessionId` is known
  (after `rec.childId = child.sessionId` at line ~296): for each seed pair, call
  `ctx.grants.add({ session: child.sessionId, surface: "bash", pattern, source: "spawn" })`
  wrapped in try/catch (a failure to seed is logged, never thrown: more prompting, never
  less).
- `src/daemon-permissions.ts:76` `handlePermissionAdd` stores `source: cmd.source` in
  the grant; `source: "spawn"` is a new value, so the grant's `source` field is a plain
  string (verify: it is - `src/permissions.ts` Grant interface). No change needed there.
- The grants are per-session (GrantStore keys by session uuid), they expire with the
  session, and `removeSession` already cleans them up on session deletion. No lifecycle
  work needed.

## Part 3: inherit the parent's active grants

- In the same place, after the seeds: copy the parent's active grants into the child
  (`ctx.grants.active(parent.sessionId)`), for each grant add
  `ctx.grants.add({ session: child.sessionId, surface: g.surface, pattern: g.pattern,
  source: "inherit" })`, try/catch, same never-throw rule. Capped surfaces are already
  rejected by `add` itself (capped grant cannot be created per the store's invariants).
- The copy is per-session: the parent's grants stay with the parent (the child gets its
  own copy, not a shared reference).

## Tests

- `test/daemon.test.ts` (or a new `test/subagents.test.ts` addition if that file is the
  harness's home for subagent spawns; check where the existing subagent spawn tests live):
  1. Spawn a subagent with `cwd` pointing at a second directory; assert the child's
     `.env.json` (the harness writes `f.env.json` per test/daemon.test.ts:789) has
     `TORIEL_SCOPE_ROOT` = the child's cwd, not the parent's.
  2. Assert the child's grant file contains the seeded `git status*` grant (source
     `spawn`) and no `git commit` grant.
  3. Assert the parent's grants are copied into the child (source `inherit`).
  4. Assert the child's grants are gone when the child session is deleted
     (`removeSession`).
- Add a unit test for the seed list itself: every entry is a `bash` pattern with a
  trailing `*` (or exact), and no entry contains a mutating git subcommand (grep the
  list for `commit`, `push`, `checkout`, `rebase`, `merge`, `add`, `reset`, `stash`,
  `rm `).
- Add a test for the tool schema: the `toriel_agent` tool accepts a `cwd` parameter and
  forwards it (test/daemon.test.ts already spawns subagents through the protocol; the
  tool schema is the extension's, so assert the extension's parameter list contains
  `cwd` if the extension is testable, or assert the protocol accepts it).
- Add a test that the spawn is rejected when `cwd` does not exist (the error names the
  directory).

## Docs

- `docs/permissions.md`: add a short section "Seeded grants" - subagents spawn with
  read-only git/gh grants and a copy of the parent's active grants, so a worktree worker
  can read repo state without prompting; the seed list is read-only by construction.
- `README.md`: if it mentions the subagent spawn cwd anywhere, note the new `cwd` field.
- `docs/reference.md`: add the new module if one is created (or note the change in
  `src/daemon-subagents.ts`'s entry).
- The tool description in `pi/extensions/toriel-agents.ts` (line ~76): add a sentence
  about the `cwd` parameter ("pass cwd when the task lives in a worktree or another
  directory: the subagent is scoped to its own cwd, so its writes inside it are silent
  and outside it are denied").

## Out of scope

- The editable pattern in the dialog (T13, ticket 178) - separate ticket.
- The landlock spike (T6, ticket 166) - separate ticket.
- No change to the scope guard, the grants link, or the dialog.
