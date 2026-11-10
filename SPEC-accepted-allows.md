# Spec: accepted allows for the scope-guard doctor check (followup to 165/174)

Ron: the doctor must not warn about the deliberate `/tmp/*` allow - "I don't want to get into the habit of ignoring the doctor warnings". So the `scope-guard-short-circuit` finding gains an explicit acceptance mechanism in the toriel settings: an offender the operator has recorded as accepted is not flagged; anything unexpected still fires. Repo: `/home/ron/projects/toriel` (work in your own worktree).

## Decisions

1. **Settings key `scopeGuardAcceptedAllows`**: `Array<{ surface: string; pattern: string }>` where `surface` is exactly one of `"external_directory_write"`, `"external_directory"`, `"*"` and `pattern` is a non-empty config-glob string. The fallback offender is `{ surface: "*", pattern: "*" }`. Exact-match suppression only: an accepted `{ surface: "external_directory_write", pattern: "/tmp/*" }` silences that offender and nothing else.
2. **Suppress iff every offender is accepted; partial acceptance narrows the finding.** With offenders `[{e_d_w, "/tmp/*"}, {"*", "*"}]` and only the first accepted, the finding remains listing just the fallback. The message gains one trailing sentence teaching the mechanism: `(deliberate allows can be recorded in the toriel settings as scopeGuardAcceptedAllows so they are not flagged)`.
3. **No `--fix`.** Recording an acceptance edits the operator's settings - judgment, not mechanical.
4. **The finding fires from resources.ts's `scopeGuardFindings`; the doctor only supplies the accepted list.** No reordering hazards beyond moving `loadSettings` above the `auditFindings` call in `collectFindings` (they are independent; safe).

## Verified facts (cite, do not re-derive)

- Settings validation: `loadSettings` at `src/settings.ts:73-132` - per-key branches, problems array, unknown keys reported (`unknown setting "key"`). Existing array-valued precedent: `permissionGrantDurations` at :99-103. `TorielSettings` interface at :14-41 (`warnNoPermissionSystem?` at :40 shows the doc-comment style).
- The finding: `scopeGuardFindings(config)` at `src/resources.ts:292` - offenders are built as strings (`surface: "pattern"`, fallback rendered `"*" (fallback)`); `auditFindings` calls it in the else-branch at :352. `AuditOptions` at :317-323 (`permissionSystem`, `grantsFile`).
- `collectFindings` at `src/doctor.ts:97`: `auditFindings(...)` is called at :107, `loadSettings` at :108 - REORDER so settings load first, then pass `loaded.settings.scopeGuardAcceptedAllows` into the audit opts (spread: `{ ...opts, scopeGuardAcceptedAllows: loaded.settings.scopeGuardAcceptedAllows }`).
- Catalog: `permission-package-scope-patch` sits between `grants-path-rule` and `scope-guard-short-circuit` (`src/doctor.ts:52-54`); the bidirectional catalog test (`test/doctor.test.ts:38-47`) needs a firing scenario with acceptance ABSENT (already exists: `setup({ scopePatch: "absent" })` - it must STAY firing) plus the new quiet-with-acceptance scenario.
- Fixture: `over.settings` writes the toriel settings file verbatim (`test/doctor-fixture.ts:88-90`); `over.scopePatch: "absent" | "present"` places the package tree (`:68-73`). `opts.env.TORIEL_NODE` defaults to `/nonexistent-node` so the real global package is never located in tests (`:104`).
- Live setup: Ron's global config has `external_directory_write: {"*": "ask", "/tmp/*": "allow"}` and NO `~/.config/toriel/settings.json` exists yet. After this ships the manager creates the settings file with the acceptance entry; the live doctor must then be quiet while a config WITHOUT acceptance still fires.

## Slices

### (a) settings.ts
`TorielSettings` gains the field with a doc comment; the load loop gains the branch (pattern per `permissionGrantDurations`): array, length ≤ 20, every entry an object (non-null, non-array) whose `surface` is one of the three strings and whose `pattern` is a non-empty string; otherwise `problems.push('scopeGuardAcceptedAllows must be a list of {surface, pattern} entries (surface: "external_directory_write", "external_directory" or "*")')`.

### (b) resources.ts
`scopeGuardFindings(config, accepted?: Array<{ surface: string; pattern: string }>)`: collect offenders as `{ surface, pattern }` (fallback = `{ surface: "*", pattern: "*" }`); filter out accepted ones (exact surface+pattern match); empty remainder -> `[]`; else the finding as today, message listing only the remainder's labels and gaining the trailing acceptance sentence (decision 2). Export nothing new beyond the parameter. `AuditOptions` gains the passthrough field; `auditFindings` forwards it.

### (c) doctor.ts
Reorder `loadSettings` above the `auditFindings` call; pass the acceptance list through (decision 4). CATALOG unchanged.

### (d) Tests
- `test/settings.test.ts`: valid list -> settings carry it; entry with a bad surface -> problem with the exact message; non-array -> problem.
- `test/resources.test.ts` scope-guard block: all-offenders-accepted -> `[]`; partial -> finding naming only the remainder and matching the acceptance sentence; exact-match discipline (accepted `{ "external_directory_write", "/tmp/*" }` does NOT silence `{ "external_directory", "/tmp/*" }`); accepted `{ "*", "*" }` silences only the fallback offender; no accepted param -> today's behavior.
- `test/doctor.test.ts`: new scenario - `setup({ scopePatch: "absent", settings: JSON.stringify({ scopeGuardAcceptedAllows: [{ surface: "external_directory_write", pattern: "/tmp/*" }, { surface: "*", pattern: "*" }] }) })` -> the finding is ABSENT; the existing absent-without-acceptance scenario still fires; `test/settings.test.ts` count/style consistent.

### (e) Docs
`docs/reference.md`: the Doctor paragraph's scope-guard sentence gains "allows recorded in the toriel settings' `scopeGuardAcceptedAllows` are treated as deliberate and are not flagged"; and the settings documentation (wherever `warnNoPermissionSystem` is documented for users - grep it) gains the key with its shape and the three surfaces.

## Gates

`npm test` + `npm run typecheck` + `npm run lint` green. Do NOT edit `agents/*.md`, `pi/extensions/**`, or `src/scope-root.ts`.

## Out of scope

Creating the live settings file (manager, after merge), `--fix` support, read-jail allowlists (167), per-profile acceptance.
