# SPEC: ticket 202 - wake on typing does nothing for a session the daemon has not registered yet

## Context

Ticket 68 (merged, PR #60) made the controller start a sleeping session when the user types a
`/command` or `!command` into it and pauses (WakeOnType debounce, 400 ms). While validating it on
the 2026-11-14 build, the wake silently did nothing for a session that predates the daemon's current
registry: after a daemon restart the registry is rebuilt, and a session is only registered when
first touched. The wake is therefore dead exactly when it matters most (first use after a restart).

Root cause, `src/session-commands.ts`, `wakeForTyping()`:

```ts
const known = this.viewedMeta() ?? (key ? this.h.local.get(key) : undefined);
if (!key || !known || !mayWake(...)) return;
```

The controller-side `known` guard is stricter than the daemon's own checks. The daemon already
handles an unregistered-but-existing file end-to-end: verified 2026-11-14 by sending
`spawn {sessionFile, ready: true, wake: true}` straight over the socket for a never-registered
session - the daemon registered it, ran the refusal checks, and started the pi child
(daemon.log `session 2 child started`). `/help` correctly not waking is unrelated (it is on the
NO_CHILD_COMMANDS skip list).

## Change

In `src/session-commands.ts` `wakeForTyping()`:

1. Drop the `!known` requirement. The request must go out when `mayWake` says the session may wake,
   regardless of whether the controller has meta for it.
2. Fix the cwd fallback so it survives `known === undefined`. Today it is
   `known.cwd || path.dirname(key)` - it breaks when `known` is undefined. Use
   `known?.cwd || path.dirname(key)` (or restructure).
3. Keep the `mayWake` gate and the existing refusal handling (`woke: false` notify, silent catch)
   exactly as they are.

No protocol change. Daemon-side code needs no change. Do not touch `mayWake`, `wakeRefusal`,
`NO_CHILD_COMMANDS`, `WakeOnType` or anything else.

## Tests (test/wake-on-type.test.ts and/or a sibling, follow the existing patterns)

1. The wake is still sent for a session the controller knows (regression).
2. The wake is still sent for a session the controller has no meta for - the new case: viewed key
   with `known === undefined`, cwd falls back to `path.dirname(key)`.
3. Refusal shapes still behave as today (`woke: false` notifies with the reason; a thrown error is
   swallowed silently so the real send reports it).

## Definition of done

`npm test`, `npm run typecheck` and `npm run lint` pass in this worktree (lint baseline is
2 warnings + 2 infos). Report the diff and the numbers. Commit nothing - the manager commits
after review.
