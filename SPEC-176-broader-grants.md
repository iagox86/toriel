# SPEC-176: Broader-grant matching (T11)

Ticket 176, board "Toriel - base". One change to `src/permissions.ts` `covers()` plus its
tests: a grant whose glob covers the suggested pattern now allows the ask, instead of
requiring an exact string match.

## Motivation

An agent asks for `projects/code/tests/*` access; the user wants to answer by granting
the broader `projects/code/*`. Today that is impossible: the daemon's grant check is an
exact match, so the broader grant never covers the narrower ask and the user must grant
the exact suggested pattern (or grant once per narrower ask).

## Verified facts (file:line, current main)

- `src/permissions.ts:250` - `covers(session, asked)`; the match is
  `live.find((g) => g.surface === a.surface && g.pattern === a.pattern)` at
  `src/permissions.ts:260`.
- `src/permissions.ts:257` - capped surfaces (`isCappedSurface`, `src/permissions.ts:61`)
  return undefined before matching; unchanged.
- `src/daemon-permissions.ts:38-42` - the only caller for coverage: `handlePermissionCheck`
  builds `specsOf(cmd.grants)` and calls `covers`, replying `allow: true` with the covered
  grant ids. No other caller.
- `test/permissions.test.ts:48-52` - existing test asserts the exact opposite
  ("matches the pattern exactly, not as a wildcard": grant `git *` does NOT cover ask
  `git status`). This test must be updated to the new semantics.
- `src/session-actions.ts:314` - dialog adds still use the exact suggested pair; the user
  can still type a broader pattern into a grant, and (after this change) it covers asks.
  Unchanged.
- `src/resources.ts:323` - scope-guard acceptance uses exact surface+pattern match; that is
  a different mechanism (settings key, not grants) and must NOT change.

## Design

### Matching rule

A grant `g` covers an ask `a` when:
- `g.surface === a.surface`, AND
- the ask pattern, treated as a literal string, matches the grant pattern treated as a
  glob: `*` in the grant pattern matches any run of characters (including `/`), `?` in
  the grant pattern matches any single character, everything else is literal.

So grant `projects/code/*` covers asks `projects/code/tests/*`, `projects/code/foo`,
and the literal `projects/code/*` (a `*` in the ask is literal text, and the grant's `*`
matches it). Grant `git *` covers `git status`, `git *`, `git checkout main`. Exact
matches remain covered (the old behavior is a subset).

### Rules that must not change

- Every pair in the ask must still be covered, or the ask is not covered (all-or-nothing).
- Empty ask is never covered; capped surfaces still return undefined before matching.
- The returned `used` array lists the covering grants (one per pair) - the daemon
  reports their ids, so the dialog/status shows the real grant.
- If multiple grants cover a pair, pick the first (existing `live.find` order), no new
  tie-breaking.

### Implementation

New module-level helper in `src/permissions.ts` (no new dependency):

```ts
/** The ask pattern as a literal string against the grant pattern as a glob. */
function coversPattern(grant: string, ask: string): boolean {
  const re = new RegExp(`^${[...grant].map((c) => c === "*" ? "[\\s\\S]*" : c === "?" ? "[\\s\\S]" : c.replace(/[.*+?^${}()|[\]\\]/, "\\$&")).join("")}$`);
  return re.test(ask);
}
```

(or a hand-rolled matcher if you prefer - the only requirement is: `*` = any run of
characters including `/`, `?` = one character, everything else literal, full match).

`covers` becomes:

```ts
const hit = live.find((g) => g.surface === a.surface && coversPattern(g.pattern, a.pattern));
```

### Tests (update `test/permissions.test.ts`)

1. Rewrite the :48-52 test: grant `git *` now covers ask `git status`, `git *`,
   `git checkout main`.
2. Grant `projects/code/*` covers ask `projects/code/tests/*` and `projects/code/foo`.
3. Grant `projects/code/*` does NOT cover ask `projects/other/*` or `projects/code-tests/*`.
4. Grant `projects/code` (no wildcard) covers only the literal ask `projects/code`.
5. Grant `a?c` covers ask `abc` and `a/c`, not `abbc` (the `?`-is-one-character rule).
6. All-or-nothing still holds: one covered pair + one uncovered pair = undefined.
7. Capped surface still returns undefined even with a covering grant.
8. `used` contains the covering grant (its id).
9. Special characters in a grant pattern are literal: grant `a.b` does not cover ask
   `axb` (the `.` is escaped, not a regex dot).

### Documentation

- `docs/permissions.md`: wherever the exact-match rule is described, say a grant covers
  any ask whose suggested pattern matches the grant's pattern as a glob (`*` = any
  characters including path separators, `?` = one character). Grep the docs for
  "exact" / "matches" to find the wording.
- `src/permissions.ts` docstring of `covers` and the `coversPattern` comment: state the
  rule and note the ask pattern is treated as literal text (a `*` in the ask is a
  character, not a wildcard).

### Out of scope

- No UI changes (the dialog, `/permissions add` are untouched; the user can already type
  a broader pattern).
- No change to the scope-guard acceptance matching (`src/resources.ts:323`).
- No change to `add`/`update`/expiry/cap logic.
