# Spec: profile `scope:` field (Vikunja 164, "148-T2")

Sequel to the merged T1 (main `628b94e`, PR #25): the daemon scopes a profile session whose cwd is a linked-worktree root (`src/scope-root.ts` `scopeRootFor`, called at `src/daemon-children.ts:111`). T2 adds the per-profile opt-out. Repo: `/home/ron/projects/toriel` (work in your own worktree). Everything below is decided; report deviations instead of diverging.

## Decisions

1. **Frontmatter `scope: none` = never scoped.** Any other value, including unknown ones, is a profile error (parse throws, like the other validators). Absent `scope` = default: scoped exactly as T1 decided (profile session in a linked-worktree root). There is no `scope: worktree` - that is the default and spelling it out adds a second spelling of the same behavior.
2. **The field is advisory only.** The daemon still computes the worktree root; `scope: none` just makes it not set the env. No protocol change, no `shared.ts` change.
3. **`PI_SUBAGENT_PARENT_SESSION` stays unset for scoped children** (decision recorded, no code): P5 verified un-granted asks resolve as a fast legible deny; the scope guard denies covered writes before the forwarding path anyway, so there is nothing a parent session could approve that should override the scope. Revisit only if a real session shows a need.
4. **The agent git-via-MCP audit folds in as a verified no-op** (no code): `agents/implement.md:19` and `agents/test-runner.md:16` already forbid git mutation; no shipped profile names `git_write`/`git_net` (`test/agents-shipped.test.ts` enforces). A scoped `git commit` would write outside W, which is why those prompt lines matter - they are already correct. Do not edit any `agents/*.md`.

## Verified facts (cite, do not re-derive)

- `AgentProfile` interface: `src/agents.ts:20-43` (`model?` at :27 shows the shape; add `scope?: "none"` near it with a doc comment).
- Frontmatter keys: `KEYS` at `src/agents.ts:52` (lowercase names: add `"scope"`).
- Parse + validation: the return object at `src/agents.ts:161-175`; `model` validation at :147-149 (`throw` on missing `/`) is the pattern for validating `scope` (value must be exactly `"none"` when present; throw a plain `Error` naming the field and the allowed value).
- The one scope call site: `src/daemon-children.ts:111` - `scopeRootFor(s.cwd, s.agent !== undefined)`. With the field, the second argument becomes "profile present AND its scope is not none" (e.g. `s.agent !== undefined && s.agent.scope !== "none"`).
- Tests: `test/agents.test.ts` exists for profile parsing (mirror its style); `test/daemon.test.ts` exercises the launch path via `test/fixtures/fake-pi.mjs`; `test/child-env.test.ts` has the scopeRoot cases from T1.
- Conventions: no enums/constructor properties, `import type` for types, `.ts` import extensions, 2-space indent, block statements always; update `docs/reference.md` and `agents/README.md` when behavior changes.

## Slices (small; do them in order)

### (a) The field
`src/agents.ts`: add `scope?: "none"` to the interface (doc comment: "opt out of the daemon's directory scoping for worktree spawns; unset = scoped when the spawn qualifies"), add `"scope"` to `KEYS`, validate in the parse function (present and !== "none" -> throw `scope must be "none"`), include `scope: fm.scope === "none" ? "none" : undefined` in the return object.
Tests in `test/agents.test.ts`: absent -> undefined; `scope: none` -> "none"; `scope: worktree` and `scope: yes` -> parse error naming `scope`.

### (b) The daemon decision
`src/daemon-children.ts:111`: pass the adjusted boolean as above. No other change; the log line (:112-113) already only fires when defined.
Test: extend the daemon test that covers scoped spawning if one exists (grep `scope` in `test/daemon.test.ts`), else add to `test/scope-root.test.ts` a unit test asserting the new predicate shape via a tiny helper if the spec's author determines the call site is not directly testable - prefer testing through `test/agents.test.ts` + the existing daemon integration coverage; do not build new harnesses.

### (c) Docs
- `agents/README.md`: document `scope:` in the frontmatter table/list (one entry: `scope: none` opts a profile out of worktree scoping; default is scoped-when-qualifying).
- `docs/reference.md`: the `TORIEL_SCOPE_ROOT` Env entry gains one sentence: "a profile with `scope: none` in its frontmatter is never scoped (the daemon does not set the variable for it)".
- `docs/design.md`: one addendum line under the T1 addendum noting T2 shipped the opt-out and recording decision 3 (no `PI_SUBAGENT_PARENT_SESSION` change) and decision 4 (audit no-op, verified at the file:line above).

## Gates

`npm test` + `npm run typecheck` + `npm run lint` (node >= 26 on PATH), all green before reporting. `test/agents-shipped.test.ts` must pass untouched (no profile changes are allowed in T2).

## Out of scope

Doctor checks for scoped sessions (165), read jail (167), bwrap/landlock (166), the all-agents rollout (172), bash parser gaps (168-171).
