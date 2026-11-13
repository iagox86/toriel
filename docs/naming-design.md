# Session naming: one authority (design review for Vikunja 156)

Source: Claude (Sonnet) design review, 2026-11-06, farmed per Ron. Ticket: 156.
PR 1 of section 6 is built (docs/design.md "Naming"); PR 2 and the parked items are not.

---

# Session naming: design review

Facts from the code that shape everything below:
- A fork's file is a copy of the parent's, so it carries the parent's `session_info` entries. Until the fork's own entry is written, "latest session_info" is the parent's name. That is the Vikunja 156 symptom, and it explains why the one-shot `--name` / `set_session_name` write is never verified.
- `refreshMeta` (daemon-children.ts:264) blindly copies `state.sessionName` into `s.sessionName` (:274). The registry is therefore a cache of pi's view and never an authority. It runs on every `agent_settled` (:515), and after most ops handlers.
- The existing uniqueness primitive is `uniqueName(wanted, taken)` (session-id.ts:53). It is case-insensitive and appends ` #2`, ` #3`. Callers: controller.ts:706-718 (over `sessions` plus `local` file names) and daemon-subagents.ts:277-278 (over registry names only).
- Both uniqueness callers check, then spawn, with the name registered only after pi answers. There is a check-then-act window in both.

## 1. Is one authority the right shape?

Yes, but the authority is the daemon's registry plus a reconciler, not a bare `applyName` function. Three alternatives were considered:
- Controller keeps uniqueness, daemon purely executes. This is today's design and is what failed: the controller's view is stale by definition. It does not see subagents or external pi sessions, and it cannot see two controllers racing.
- Event-sourced names. This is overkill. The names live in pi's session file, and a toriel-side log would be a second source of truth that must itself be reconciled with the file.
- Name owned by pi only. Not viable: pi resolves late by reverse walk, and it has no notion of cross-session uniqueness or of the fork glyph.

Pick: the daemon holds the *desired* name (`s.wantedName`) and owns uniqueness. A single `naming.ts` module verifies and re-asserts against pi's *observed* name, which is the only name pi reports. This puts the invariant (desired == observed, unique across the registry) in the one process that sees every session, and it makes every other path a caller rather than a writer.

## 2. The applyName contract

Two more writers turned up beyond the six: daemon-handlers-lifecycle.ts:91 (wake-with-name, `--name` only) and :128-131 (spawn with a conditional `setSessionName`, guarded by `!s.sessionName`). Both are fresh-start variants of path 3 and fold in the same way.

Signature, in a new `src/daemon-naming.ts` (a class taking `registry`, `hub`, `children`, like `DaemonChildren`, so there is no module state):

```ts
type NameSource = "user" | "fork" | "spawn" | "subagent" | "auto";
applyName(s, requested, { source, ifUnset?: boolean, background?: boolean })
  : Promise<{ name: string; state: "verified" | "pending" }>
```

Steps:
1. **Validate.** Trim, and reject an empty name by throwing (the only validation throw; today's check is handleRename at :212). Collapse newlines and cap the length (the subagent path slices to 60 at daemon-subagents.ts:277).
2. **Claim synchronously.** Before any `await`, compute `uniqueName(requested, taken)` over every registry name and every other session's `wantedName`. Write the result to `s.wantedName` and `s.nameSource`. This is the same "synchronous with the record" trick daemon-subagents.ts:275 relies on, and it closes the check-then-act window.
   - `ifUnset` (auto-namer) is a compare-and-set. Skip if `s.nameSource === "user"` or the session already has a name.
   - `source: "user"` always wins over `auto`. An auto-namer result that arrives after a `/rename` is dropped.
3. **Child live.** `child.setSessionName(name)`, then verify with `getState().sessionName === name`, up to 3 attempts with 100/300/900 ms waits. The `RpcClient` has no per-request timeout (rpc-client.js has only the 100 ms start probe at :79), so wrap each rpc in `Promise.race` against 5 s. Requests queue in order, so a child that is still loading answers late rather than never.
4. **No child (or `s.dead`).** Append to the file through the same module (`SessionManager.open(file).appendSessionInfo(name)`, today at lifecycle:221-222), then re-open and read the latest `session_info` entry back as the verify step. A throw here is a real error (disk, missing file) and propagates.
5. **Publish.** Set `s.sessionName = name`, then `hub.broadcastSessions()`.

Failure semantics:

| Situation | Behavior |
|---|---|
| rpc throws or times out | Retry the set once (it is idempotent). Then return `state:"pending"`. Do not throw. `s.wantedName` stays set and the reconciler (section 3) retries. |
| Verify mismatch after retries | Same as above, plus a `log()` line naming the wanted and observed values. The registry shows the wanted name (see below). |
| Child died mid-apply | Fall through to the no-child file write. A death is already handled by `refreshMeta` → `onStopped`. |
| File write fails | Throw. Roll back `wantedName`. |

**Registry shows the wanted name, not the observed one.** The daemon is the authority, so a controller should never display the parent's stale name for a fork. `refreshMeta` stops copying `state.sessionName` into `s.sessionName` (:274) and instead feeds the reconciler.

**Who blocks and who doesn't:**

| Path | Mode | Why |
|---|---|---|
| `/rename` | **await; surface error and pending** | User-initiated and short. `pending` returns `res(true, undefined, {name, nameVerified:false})` and the controller prints a notice. |
| `/fork` adopt (:343) | **await inside the `spawning` window, non-fatal** | The fork file already exists, so failing the adopt would orphan it. A mismatch becomes a notice plus reconciler repair. It must finish before `recordFork` (:370), which today records `cmd.name` unverified. Cost in the normal case is one `get_state`. |
| `/new`, spawn, wake (switcher-actions:206, lifecycle:91/128) | **fire-and-forget** (`background:true`) | `--name` already worked in the common case. Claim synchronously, verify in the background. Do not delay the controller's first paint. |
| Subagent (daemon-subagents.ts:278) | **fire-and-forget** | The claim must be synchronous because `book.add({childName})` at :282 needs the final name. |
| External pi | not a caller | Observation only; handled by the reconciler (sections 3 and 4). |
| Auto-namer (62) | **fire-and-forget, `ifUnset`** | Never overrides `source:"user"`. |

## 3. Drift re-assertion

Add three fields to `DaemonSession`: `wantedName?: string`, `nameSource`, and `nameAssertAt?: number` with `nameAsserts: number`. They live next to `sessionName` (daemon-session type, line ~22).

The guard lives at the one place that observes pi's name, the `s.sessionName = state.sessionName` assignment at daemon-children.ts:274. It is a pure comparison on a value `refreshMeta` already fetched, so it costs no extra rpc:

```ts
const observed = state.sessionName;
if (s.wantedName && observed !== s.wantedName) {
  this.naming.noteDrift(s, observed);   // sync, cheap, never awaits here
} else {
  s.nameAsserts = 0;                    // converged: reset the budget
}
```

`noteDrift` decides:
- **Rate limit:** at most one re-assert per session per 30 s (`now - s.nameAssertAt`), and at most 5 consecutive without convergence. After 5, stop, log once ("pi keeps resolving X; giving up"), and reset only when the observed name equals the wanted one or the user renames. This bounds churn if something else (an extension, an external `/name`) keeps flipping it.
- **Re-assert is `setSessionName(wanted)` fire-and-forget**, no verify loop. The next `refreshMeta` (agent_settled or the 15 s poll) is the verification. This keeps `refreshMeta` itself from becoming recursive or slow.
- **Compaction case:** after compaction the latest `session_info` can sit off the active branch, so `get_state` reports the older name. That shows as drift on the next `agent_settled` refresh (:515), which is exactly when it occurs. One re-assert appends a fresh entry on the active branch, which converges, and the counter resets. Also trigger a `noteDrift` check directly on `compaction_end` (:520ff) so the repair doesn't wait for the 15 s poll.
- **Steady-state cost is one string compare per refresh.** Nothing is written when names match, so there is no churn.

**External renames** (path 5) are the one case where observed ≠ wanted legitimately. Distinguish by *when* the change appears. A pi-side rename the daemon didn't issue arrives with no `applyName` in flight and (ideally) with a different observed name than any previously wanted or observed value. Policy: treat an observed change while `nameSource !== "user"` or while no apply is pending as an adoption candidate, i.e. run it through the uniqueness check and, if it passes, set `wantedName = observed`. Only an observed name that equals a *previous parent name* (the fork-inheritance signature) or is blank is repaired. That is a heuristic; the safer default for the first PR is "re-assert always", with external-rename adoption parked in design.md. Decide this with the repo owner before building.

Guard against the fork race specifically: during `s.spawning` skip `noteDrift`. The adopt handler's own applyName is already verifying, and the drift check would double-write.

## 4. Uniqueness semantics

**Policy: append, never reject.** Reuse `uniqueName` (session-id.ts:53) unchanged. It is case-insensitive and appends ` #2`, ` #3`. Rejecting would add a failure mode to fork, spawn, subagent and auto-namer flows that have no good place to ask the user again. For an explicit `/rename` the answer comes back in the response (`name` = what was applied) and the controller shows "renamed to X #2 (X was taken)", so the user is never surprised silently.

Rules at the authority:
- **Taken set** = every `ctx.registry.all()` entry's `wantedName ?? sessionName`, excluding `s` itself. Renaming a session to its own current name is a no-op, not `#2`. Today's controller code excludes self by `selfKey` (controller.ts:708); the subagent path has no self (the child is fresh).
- **Inactive sessions count.** The registry holds them, so they are in the taken set. Sessions the daemon has never seen (files on disk that were never registered) cannot be checked; that is the same blind spot the controller's `local` map covers today (:713-717). The daemon should read the same file-name cache the controller uses, or accept the gap and park it.
- **Edge in `uniqueName`:** `wanted.replace(/ #\d+$/, "")` strips a user's own `#5`, so a user-chosen "Task #5" colliding becomes "Task #2", not "Task #5 #2". That is arguably a bug; fix it with a test or leave it, but know that it exists before moving the function.
- **Release:** clear `wantedName` when a session is deleted or trashed, and roll it back on a failed apply, so a failed claim doesn't permanently reserve a name.

**In-flight forks with a stale controller name.** The controller's `uniqueSessionName` result is now only a *request*. The `adopt` handler passes `cmd.name` through `applyName`, which re-runs uniqueness against the current registry:
- If the controller's name is still free, nothing changes.
- If it collided in the meantime, the daemon appends `#N` after the fork glyph (`FORK Parent #2`). The glyph is part of the requested string from `forkName` (fork-placement.ts:8-10), so it is preserved. The final name is returned in `res(true, undefined, {sessionId, name})`.
- `recordFork` (lifecycle:370-375) must use the *applied* name, not `cmd.name`, or the fork graph disagrees with the session list.
- `session-commands.ts:373` can stop calling `uniqueSessionName` once the daemon owns this. Keep it for one release as an optimistic preview, then delete it and `Controller.uniqueSessionName` (controller.ts:706). That deletion belongs to PR 2.
- Two controllers forking the same parent at once are serialized by the synchronous claim in section 2 step 2; the second gets `#2`.
- A protocol field is needed (`name` in the adopt/spawn/rename responses), so bump `PROTOCOL` in shared.ts per CLAUDE.md. Old controllers ignore an extra response field, but the version bump keeps the controller from silently relying on it.

## 5. Test strategy

What fake-pi does today (test/fixtures/fake-pi.mjs):
- `sessionName` is a plain variable seeded from `--name` (:31).
- `set_session_name` flips it (:217-219) and `get_state` returns it (:206).
- Nothing is written to the session file.
- `--fork` only reads messages from the parent (`loadMessages(forkFrom)`, :52); the child's file does not inherit the parent's entries.
- So the fake can never reproduce "the fork reports the parent's name". It would pass the 156 bug.

**Minimal upgrades** (about 40 lines, all env-gated so existing tests are untouched):
1. **Names as file entries.** `set_session_name` appends `{type:"session_info", id, parentId: lastEntryId, name}` to the file via a shared `appendEntry` helper, the same shape `persist` already writes (:106-117). Track `lastEntryId` as the active leaf.
2. **`get_state` resolves late.** Replace the variable with `resolveName()`: reverse-walk the file's entries from the active leaf by `parentId` and return the first `session_info.name`, else the `--name` flag. The walk is by `parentId`, not by file order, so a session_info entry on an abandoned branch is ignored. That models the compaction case.
3. **Fork inherits the parent's entries.** On `--fork`, copy the parent's JSONL lines (header rewritten with the new id) into the new `sessionFile` at startup. This is what makes the fork observably carry the parent's name until its own entry lands.
4. **Fault modes**, read from env at startup or a `FAKE_PI_NAME_MODE` control:
   - `delay:<ms>`: answer `set_session_name` after N ms, but apply it after the answer is sent plus M ms (late write).
   - `fail:<n>`: respond `success:false` (or never respond) to the first n `set_session_name` calls.
   - `ignore:<n>`: respond `success:true` but do not write the entry for the first n calls (the silent drop that matches the 156 symptom).
5. **Compaction hook for the branch case.** The existing compact command (`FAKE_PI_COMPACT_MS`, :248) additionally moves the active leaf to a pre-name ancestor so the latest session_info is off-branch. Gate it as `FAKE_PI_COMPACT_ORPHANS_NAME=1`.

**Tests** (in `test/daemon.test.ts`, plus a pure `test/naming.test.ts` for the module):
1. **Regression for 156: fork of a busy parent gets its own name.** Parent live and streaming with name "Parent". Adopt with `fork:true, name:"FORK Parent"` and fake-pi in `ignore:1` mode. Assert the session list shows "FORK Parent" (glyph included) after adopt, the fake's `get_state` also reports it (the verify loop retried), and `recordFork` holds "FORK Parent". It fails on current main because the fork reports "Parent", the inherited entry.
2. **Verify-after-delay converges.** `delay` mode: first `get_state` after the set still reports the old name. Assert `applyName` returns `verified` after the retry and made no more than N rpc calls (count via a request log the fake writes).
3. **Exhausted retries return `pending`, not an error, and the reconciler heals.** `fail:5` on the fork path: `adopt` still resolves `true` with `nameVerified:false` and the session exists. Switch the mode off, trigger `agent_settled` (or call `refreshMeta` directly), and assert the name converges and re-asserts are no more than the 5-attempt cap with the 30 s limit (inject a fake clock into the `nameAssertAt` check rather than sleeping).
4. **Compaction drift re-assertion.** Name "A", run compact with `COMPACT_ORPHANS_NAME`, observe fake `get_state` reports the old name, assert exactly one `set_session_name` follows and the registry never showed the old name. A second `refreshMeta` with converged names issues zero further writes (the no-churn assertion).
5. **Daemon-side uniqueness races.** Two simultaneous `adopt`/`spawn` requests with the same name from two clients: both succeed, names are `X` and `X #2`, and `recordFork`/subagent records carry the applied names. Add a sub-case for `/rename` on a no-child session going through the authority, with the file read back showing the `session_info` entry and the `#2` suffix when taken.

Pure unit tests (no daemon): `uniqueName` self-exclusion and the `#5` edge case; `noteDrift` rate limit and budget reset; `ifUnset`/`source:"user"` precedence for the auto-namer.

## 6. Scope guard: what goes in the first PR

**Overlap with 141.** Both touch `handleAdopt` (lifecycle.ts:343-371). The comment at :352-353 and the test at test/daemon.test.ts:720-724 (asserts `toriel-agents.ts` and `+toriel_message` on a fork's argv) suggest the tool-loadout half of 141 is already addressed through `startArgs`. Confirm 141's current status on the board before starting. If it is open for a different cause, land 141 first as its own small PR and rebase the naming work on it, since both edit the same ~30 lines and a bug in the tool loadout should not be blamed on the naming change.

**PR 1 (the minimum that kills the class for forks, plus the shared core):**
- `src/daemon-naming.ts` with `applyName`, the verify loop, `wantedName`/`nameSource` on `DaemonSession`, and the `noteDrift` guard in `refreshMeta` (daemon-children.ts:274).
- Path 1 (/fork adopt): this is the 156 bug.
- Path 2 (/rename), including the no-child file write. It is the same primitive, it removes the second write mechanism, and it is a tiny diff (lifecycle:207-230).
- Daemon-side uniqueness inside `applyName` (controller check stays as optimistic preview), the `name` field in responses, and a `PROTOCOL` bump.
- The fake-pi upgrades (section 5 items 1 to 4) and tests 1 to 3, 5. Test 4 (compaction) can ride along since the guard is in PR 1.
- Docs: `docs/design.md` (new "Naming" section replacing the six-path description) and the protocol-gotchas note; `docs/reference.md` if user-visible rename wording changes.

**PR 2 (call-site migrations, each mechanical once the authority exists):**
- Path 3 (/new, spawn, wake: switcher-actions:206, lifecycle:91/128-131). Fire-and-forget `background:true`. Delete controller-side `uniqueSessionName` (controller.ts:706) and its call in `session-commands.ts:373` afterwards.
- Path 4 (subagents, daemon-subagents.ts:275-278). Replace the local `taken`/`uniqueName` with the authority's claim. It must keep the synchronous-claim ordering because of the parallel-call limit comment at :275.

**Later / parked in design.md:**
- Path 5 external-rename adoption policy (needs a product decision, section 3).
- Path 6 auto-namer (Vikunja 62), which is a pure consumer of `applyName({ifUnset:true, source:"auto"})` once PR 1 exists.
- The `uniqueName` `#N` edge case, and reading unregistered on-disk session names into the taken set.

**Why this cut.** Forks and rename share one primitive and the 156 failure, so they prove the contract; spawn and subagents already work in practice because `--name` is applied at start, so migrating them is cleanup that can be reviewed separately. Keeping the first PR to handleAdopt and handleRename also keeps the 141 conflict surface to a single file.
