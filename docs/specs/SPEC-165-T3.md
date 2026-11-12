# Spec: doctor check for scoped sessions (Vikunja 165, "148-T3")

Follows the merged T1 (`628b94e`) + T2 (`6fec6e1`). The scope guard is only reachable on the `ask` path: a config ALLOW on a covered write surface short-circuits the authorizer chain before the link (FINDINGS P4 S1a/S1b; the pi-permission-system config schema documents the semantics: each top-level `permission` key is a surface, a string value is shorthand for `{ "*": action }`, last matching pattern wins, and an OMITTED `"*"` surface key already means `ask`). T3 adds one doctor finding: the operator's config does not allow covered writes outright. Repo: `/home/ron/projects/toriel` (work in your own worktree).

## Decisions

1. **One finding, id `scope-guard-short-circuit`, level `hardening`, `needsPermissionPackage: true`.** It fires when any ALLOW rule exists on any covered write-shaped surface: `path`, `path_write`, `external_directory` (the bare key expands at load into read+write, so an allow there allows writes), `external_directory_write`, `write`, `edit`, or the `"*"` surface fallback. Rationale: the guard cannot know every session's scope root, so ANY allow on these surfaces may admit an outside-scope write without the chain running. Ask/deny rules never short-circuit and are fine.
2. **No automatic fix.** Narrowing an operator's allow rules is a judgment call about their whole permission posture, not a safe mechanical edit (unlike the grants-path-rule check, whose fix ADDS one rule). `fix: undefined`; the message says what to change manually.
3. **Bash is out of scope.** A `bash` allow does not bypass the guard: parsed redirects become path-family asks (probe P1/step-0: `echo x > ../o` -> `external_directory_write`), and unparsed commands never produce path asks at all (that residue is phase 5, ticket 166).
4. **The finding aggregates.** One finding listing every offender as `surface: "pattern"`, fallback written as `"*" (fallback)`. Do not emit one finding per offender.

## Verified facts (cite, do not re-derive)

- Config reading pattern: `grantsFindings` at `src/resources.ts:224` reads `join(agentDir, "extensions", "pi-permission-system", "config.json")`, returns `[]` on missing/parse-error/non-object (`permissionSystemProblem` already reported those), and `auditFindings` calls it in the else-branch at `src/resources.ts:299-302`. Follow the same shape: `export function scopeGuardFindings(config: unknown): Finding[]` exported for direct unit tests; in `auditFindings`, read+parse the same file the same way and call it in the same else-branch (a second read of a small file is fine and keeps each check standalone).
- Extracting rules: `pathRules` at `src/resources.ts:185-196` handles rule-as-string and `{action}`; it does NOT handle a surface SECTION that is itself a string (`"path_write": "allow"` = all-allow per the schema shorthand) - your helper must handle that form too.
- Schema semantics (from `pi-permission-system/src/config/config-schema.ts`, quoted in its own docstrings): surface keys are the `"*"` fallback (:120, "used when no surface-specific rule matches"; omitted = ask), `path` (:142, cross-cutting, all path-aware tools), `path_write` (:148 area), bare `external_directory` "expands at load into external_directory_read and external_directory_write", and "any registered tool name" is legal as a surface (:185, so `write`/`edit` sections exist).
- Catalog ↔ finding enforcement: `test/doctor.test.ts:38-47` - every finding id must be in `CATALOG` (`src/doctor.ts:44`) and every catalog id must be REPORTED by at least one fixture variant; the grading test at :49-52 asserts exact problem lists per fixture and will need updating when a fixture gains the new finding.
- Real-world confirmation: Ron's live config has `path: {"*": "allow", ...}` and a `"*": "allow"` fallback, so the check fires on his machine. That is the intended honest result, not a bug.

## Slices

### (a) The finding
`src/resources.ts`: add `scopeGuardFindings(config: unknown): Finding[]`. For each covered surface in a fixed order (`"path"`, `"path_write"`, `"external_directory"`, `"external_directory_write"`, `"write"`, `"edit"`, then the `"*"` fallback last): get the section; a string section = `{"*": action}`; a missing section = skip (except `"*"`, where missing = the schema default `ask` = skip); collect every entry whose action is exactly `"allow"` as `surface: "pattern"`. Non-empty list -> one finding:
- id `"scope-guard-short-circuit"`, level `"hardening"`
- message: `config allows covered writes outright (<list>): an ask these match is allowed before the authorizer chain runs, so the scope guard cannot deny it for directory-scoped sessions (TORIEL_SCOPE_ROOT); set them to "ask" - an omitted "*" fallback already means ask - if you want directory scoping to hold`
- no `fix`
Wire it into `auditFindings` next to `grantsFindings` (same else-branch, same read-and-parse-quietly pattern).

### (b) The catalog
`src/doctor.ts` `CATALOG` after `grants-path-rule`: `{ id: "scope-guard-short-circuit", level: "hardening", title: 'no config allow short-circuits the scope guard for directory-scoped sessions (path, path_write, external_directory, write, edit, the "*" fallback)', needsPermissionPackage: true }`.

### (c) Tests
- `test/resources.test.ts` (or a fitting existing file): unit cases for `scopeGuardFindings` - path `{"*": "allow"}` fires naming `path: "*"`; `"*": "allow"` fallback fires naming `"*" (fallback)`; `"path_write": "allow"` (string section) fires; `external_directory` allow fires; `write`/`edit` allows fire; ask-only config (`path: {"*": "ask"}, "*": "ask"`) does not; missing/broken config object does not (returns []); mixed `{allow, ask}` entries fire once for the allow.
- `test/doctor.test.ts`: extend a fixture so `scope-guard-short-circuit` is reported (the bidirectional check at :38-47 demands it), update the exact-list assertions the new finding changes (:49-52 and any others), and assert the new problem grades `hardening` and exits 0.

### (d) Docs
- `docs/reference.md` "Doctor" paragraph: extend the **hardening** list with the new check (one clause, same style as the grants-path-rule clause).
- `docs/reference.md` "Env", the `TORIEL_SCOPE_ROOT` entry's limits: replace "a doctor check is planned, not yet shipped" with a mention of the shipped check (and that it cannot prove every write is guarded - any allow on the covered surfaces short-circuits, which is what the check flags).

## Gates

`npm test` + `npm run typecheck` + `npm run lint` green. Do NOT edit `agents/*.md`. Do NOT touch `pi/extensions/**` or `src/scope-root.ts` (nothing in T3 changes guard behavior).

## Out of scope

Per-profile doctor reasoning (the check is global, not per profile), read jail (167), sandbox spike (166), all-agents rollout (172), parser gaps (168-171).

## Addendum (manager, 2026-11-09): the check refined to the surfaces that actually reach outside-scope asks

Post-spec verification against the real resolver changed the covered set. `PermissionResolver.resolve`
folds only the BARE family (`surfaceFamilyMembers` is defined for the bare names; a directional ask
skips the fold, `permission-resolver.ts:99-106`), and a directional ask consults its own surface
section plus the `"*"` fallback - `path`/`path_write`/`write`/`edit` allows gate in-cwd asks and
cannot short-circuit the guard for an outside-scope write. The bare `external_directory` key
expands at load into the directional sections (schema docstring), so an allow there is an allow in
`external_directory_write`. The fallback is reachable only when no explicit catch-all ask/deny on
`external_directory_write` (directly or through the sugar) answers.

So the shipped check fires on: any allow in `external_directory_write` or `external_directory`; or
a `"*": "allow"` fallback when no `external_directory_write` catch-all ask/deny exists. The
spec's original six-surface list (decision 1) is superseded by this; the tests and docs above were
rewritten to match. Verified live (real resolver, real config): before the lockdown
`external_directory_write` outside resolved `allow`; after adding `"external_directory_write":
{"*": "ask"}` it resolves `ask` (bare family too), outside reads and in-cwd writes stay `allow`,
and the real scope link denies outside-W writes through the real pipeline.

Same verification pass changed the grants-path-rule fix per Ron's direction ("lock down the
configuration as we go"): the fix no longer seeds `"*": "allow"` into a missing `path` section
(an omitted fallback means ask anyway), and its message no longer instructs adding one.
