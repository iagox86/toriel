# Spec: T8 - scope every agent to its launch directory, ask outside (Vikunja 172)

Sequel to T1 (deny, worktree spawns), T2 (`scope: none` opt-out), T3 (doctor + config lockdown). T8 extends scoping to EVERY profile spawn: the scope root becomes the launch directory, and outside-root covered writes ASK instead of deny. Repo: `/home/ron/projects/toriel` (work in your own worktree).

## Decisions

1. **Two modes, one env pair.** `TORIEL_SCOPE_ROOT` keeps its meaning (canonical root). New `TORIEL_SCOPE_MODE`: `"deny"` (today's T1 contract: outside-root covered writes denied with a reason) or `"ask"` (outside-root covered writes DEFER - the dialog/grants/parent-forwarding decides, never silently allowed). The daemon sets mode deny exactly when the launch cwd is a linked-worktree root (T1's incident), ask otherwise.
2. **Who is scoped.** Every profile spawn (`s.agent !== undefined && s.agent.scope !== "none"`), same as T2 decided - now regardless of cwd shape. Un-profiled sessions and `scope: none` profiles stay unscoped (no env, guard off). Subagents inherit the parent's cwd via `ctx.registry.create(parent.cwd)` (`src/daemon-subagents.ts:276`), so an agent tree is bounded by its root session's launch dir.
3. **Invalid env in ask mode defers, never denies.** Deny mode keeps T1's fail-closed deny (P6 contract). In ask mode the guard cannot know what is inside vs outside, and the mode's promise is "prompt, never silently allow": an unusable root defers every covered write (more prompting, never less). The link still never throws.
4. **`TORIEL_SCOPE_MODE` default is deny.** A root without a mode (older daemon, hand-set env) behaves exactly as T1 shipped - no behavior change for existing scoped sessions.
5. **Reads stay out** (ticket 167). Bash/unparsed surfaces stay out (phase 5, 166).

## Verified facts (cite, do not re-derive)

- `scopeRootFor(cwd, hasProfile, fsApi?)`: `src/scope-root.ts` - returns `fs.realpathSync(cwd)` iff hasProfile AND `<cwd>/.git` is a regular file whose gitdir matches a linked worktree; undefined otherwise; never throws. Called once at `src/daemon-children.ts:111` (`scopeRootFor(s.cwd, s.agent !== undefined && s.agent.scope !== "none")`), logged when defined (:112-113).
- `childEnv(s, sock, base, scopeRoot?)`: `src/child-env.ts:21` - drops an inherited `TORIEL_SCOPE_ROOT` from the copy loop, sets it only when the param is defined; `bangEnv` calls it 3-arg so a `!command` never sees it. T2's integration test (`test/daemon.test.ts:776`) asserts no-profile -> null, explore -> realpath, `scope: none` -> null; `test/fixtures/fake-pi.mjs` records `TORIEL_SCOPE_ROOT ?? null`.
- `readScope(env, fsApi?)`: `pi/extensions/lib/scope-root.ts` - `{kind:"off"}` when unset; `{kind:"invalid", why}` for any present-but-unusable value (empty, relative, missing, file, `/`, symlink, non-canonical); `{kind:"root", root}`. `TORIEL_SCOPE_MODE` does not exist yet.
- `scopeVerdict(scope, details)`: `pi/extensions/toriel-grants.ts` - off -> defer; invalid -> deny (reason names the env failure); root + covered surface (`external_directory_write`, `external_directory`, `path_write`) + missing boundary -> deny; outside -> deny with a reason naming the path and W; inside/other surfaces -> defer. `authorize` runs the scope verdict before the grants round-trip; a deny never calls the daemon.
- T3's doctor check (`scopeGuardFindings`, `src/resources.ts`) is mode-agnostic: it flags config allows that would short-circuit the chain regardless of mode - correct for both modes (an ask config cannot short-circuit; a deny-mode guard behind an allow config is dead, and so is an ask-mode one). No doctor change needed.
- Config lockdown already shipped on this host (external_directory_write `{"*": "ask"}`), so unscoped sessions already prompt for outside-cwd writes; T8's value is making the boundary config-INDEPENDENT (the link answers even when the operator config allows) and giving headless children the P5 fast-deny when no parent serves.
- Conventions: no enums/constructor properties, `import type`, `.ts` import extensions, 2-space, block statements; update `docs/reference.md` (+ "Doctor" if a check changes - none does), `agents/README.md` untouched unless it documents scoping (check; T2 added the `scope:` line only).

## Slices

### (a) The daemon decision: `scopeForSession`
`src/scope-root.ts`: export `isLinkedWorktreeRoot(cwd: string, fsApi = ...): boolean` (the `.git`-file probe `scopeRootFor` does today, extracted); add `export type ScopeAssignment = { root: string; mode: "deny" } | { root: string; mode: "ask" }`; add `scopeForSession(cwd: string, hasProfile: boolean, fsApi = ...): ScopeAssignment | undefined` - undefined when `!hasProfile` (or any probe error); `{ root: realpath(cwd), mode: "deny" }` when `isLinkedWorktreeRoot`; `{ root: realpath(cwd), mode: "ask" }` otherwise. Reimplement `scopeRootFor` on top of these (same signature, same results: root iff mode deny) so its existing tests keep passing untouched.

### (b) The env seam
`src/child-env.ts`: change the 4th parameter to `scope?: ScopeAssignment` (import type from `./scope-root.ts`); drop BOTH `TORIEL_SCOPE_ROOT` and `TORIEL_SCOPE_MODE` from the copy loop; set `env.TORIEL_SCOPE_ROOT = scope.root` and `env.TORIEL_SCOPE_MODE = scope.mode` when defined; doc comment updated (both variables are daemon-owned; `!command` never sees either). `src/daemon-children.ts:111`: `const scope = scopeForSession(...)`; log root AND mode when defined; pass into `childEnv`.

### (c) The link: mode-aware verdicts
`pi/extensions/lib/scope-root.ts`: `Scope` grows a mode on every non-off kind: `{ kind: "invalid"; why: string; mode: "deny" | "ask" } | { kind: "root"; root: string; mode: "deny" | "ask" }`. `readScope` reads `TORIEL_SCOPE_MODE` once: exactly `"ask"` -> `"ask"`, anything else (absent, other values) -> `"deny"` (decision 4). `pi/extensions/toriel-grants.ts` `scopeVerdict`: `invalid` + mode `"ask"` -> defer (decision 3; the reason text stays for deny mode); `invalid` + `"deny"` -> deny (unchanged); `root` + `"ask"` + outside -> `{ kind: "defer" }`; `root` + `"ask"` + missing boundary -> defer (unknowable, prompt); `root` + `"deny"` -> today's behavior byte-for-byte. Update the header comment (the scope half: deny mode fails closed, ask mode fails to prompting; neither throws).

### (d) Tests
- `test/scope-root.test.ts`: `isLinkedWorktreeRoot` matrix (worktree file, `.git` dir, submodule gitdir, missing, garbage - mirror the existing cases); `scopeForSession` (profiled plain dir -> ask + realpath; profiled worktree -> deny + realpath; unprofiled -> undefined; `scope: none` is handled by the caller's boolean, assert the boolean contract in a comment); `scopeRootFor` unchanged-and-green.
- `test/child-env.test.ts`: both variables set when scope defined; BOTH dropped from a leaked base; `bangEnv` never carries either; the 3-arg deepEqual stays.
- `test/grants-extension.test.ts`: ask-mode matrix - outside covered write -> defer (and the daemon stub receives the grants round-trip only if grants exist, per the existing flow); missing boundary + ask -> defer; invalid env + ask -> defer; invalid env + deny -> deny (existing T1 case, now with the mode asserted); deny mode unchanged (existing cases pass a mode-less scope - `readScope` defaults deny - plus explicit deny cases).
- `test/daemon.test.ts` (integration, fake-pi): extend the T2 test - a profiled session in a PLAIN dir now gets `TORIEL_SCOPE_ROOT` = realpath AND `TORIEL_SCOPE_MODE` = ask; the worktree case gets mode deny; no-profile and `scope: none` get neither. `test/fixtures/fake-pi.mjs` records `TORIEL_SCOPE_MODE ?? null`.

### (e) Docs
- `docs/reference.md` "Env": `TORIEL_SCOPE_ROOT` entry gains the mode pair (deny/ask, who gets which, the failure contracts); add `TORIEL_SCOPE_MODE` right after it. "Code layout": the `scope-root.ts` line mentions both functions. "Enforcement" paragraph: the link now denies (deny mode) or defers (ask mode) - one clause.
- `docs/permissions.md`: the scope-guard paragraph gains the mode sentence.
- `docs/design.md`: addendum under the T2 one (T8 shipped; decisions 2-4 with the why).

## Gates

`npm test` + `npm run typecheck` + `npm run lint` green. Do NOT edit `agents/*.md`. Do NOT change `COVERED` or the deny-mode reason texts.

## Out of scope

Reads (167), sandbox spike (166), parser gaps (168-171), per-profile mode overrides (a `scope: ask` frontmatter value - only `none` exists; revisit on demand).
