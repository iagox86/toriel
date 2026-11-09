# Spec: scope deny link (Vikunja 163, "148-T1")

Implements T1 of `phase1-scope-probes/FINDINGS-148-phase1.md` (§1 P2/P4/P5/P6, §2, §5-T1). Repo: `/home/ron/projects/toriel` (work in your own worktree of it). Everything below is decided; follow it and report deviations. Stay small: one env contract, one link check, one env seam, tests. No read jail, no doctor, no sandbox, no profile field (section 6).

## 1. Decisions and rationale

1. **Deny only, writes only.** The link denies asks on `path_write` and `external_directory_write` whose canonical target is outside W. Everything else defers. A link `allow` on the path families is downgraded to defer by the delegation envelope (FINDINGS P4 S3; `pi-permission-system/src/authority/delegation-envelope.ts:53-87`), so the link can only deny or defer there. Reads are not jailed in phase 1 (FINDINGS P3 verdict, ticket T7).
2. **Decide on the canonical, never the pattern.** The deny compares `accessIntent.boundaryValue` to W. `matchValues()` is lexical ∪ canonical (`pi-permission-system/src/access-intent/access-path.ts:41-47`), so a symlink inside W pointing out matches `W/**` lexically; config rules cannot close that (FINDINGS P2 "symlink-alias bypass"). Do not look at `matchValues`, the grant `pattern`, `details.path` or `details.value` to decide.
3. **Fail closed, never throw.** `TORIEL_SCOPE_ROOT` present but not an absolute, existing, canonical directory = deny every covered-surface write ask, reason naming the env failure. Never defer in that state: defer hands the ask to the subagent terminal or the parent prompt, which is fail-soft (FINDINGS P6 contract; P5 S5/S6). A throwing link does not defer, it blocks the tool call with a generic `gate_error` reason the model cannot act on (`authorizer-chain.ts:38-52` has no try/catch; `tool-call-boundary.ts:21-61`). So the scope check is wrapped in its own try/catch that returns a **deny** (not the grants link's every-failure-defers rule, which stays as is for the grants path).
3b. **Absent = off.** `TORIEL_SCOPE_ROOT` unset (`undefined`) = guard off, defer everything, today's behavior (FINDINGS P6). An empty or whitespace-only string is "present but invalid" (deny), not absent: a daemon bug that sets `""` must not silently disable the guard.
4. **Scope comes only from the daemon's env, read once.** The link reads `process.env.TORIEL_SCOPE_ROOT` once, when it registers (`permissions:ready`), and closes over the result. No config file in the worktree is read (decision 5 of the scope doc: a worker could loosen it; SPEC-148-scope.md §6 Q5, §4 last paragraph).
5. **Scope link runs before the grants daemon round-trip.** Order inside the authorizer: scope check first, then the existing grants logic. A path-family ask is never sent to the daemon for a grant allow once it has been denied for scope.
6. **The daemon decides who is scoped; T1 ships the narrowest rollout.** There is no worktree concept in `src/` today (grep `worktree` in `src/*.ts` is empty). T1 scopes a launch when BOTH hold: the session has a profile (`s.agent` set, i.e. a `/new --agent` or `toriel_agent` spawn, `src/daemon-children.ts:166-170`) AND its cwd is the root of a **linked git worktree** (the cwd contains a `.git` that is a *file*, not a directory). Plain interactive sessions, and profile sessions in a normal checkout, are never scoped. Rationale: that is exactly incident F8 (a profile worker in a worktree writing to the main checkout; SPEC-148-scope.md §1) and needs no new frontmatter. SPEC-148-scope.md §4 allows "implicitly for any session spawned with a worktree"; FINDINGS §2 says default-on with a `scope:` opt-out, but the opt-out field is ticket T2 and the wider rollout is T164/T8. Do not add either here. Opt-out in T1 = run from a non-worktree cwd or without a profile.
7. **Sub-cwd is not W.** W = the worktree root (`.git` file's directory), not the session cwd, and is the realpath of it. A profile session started in a subdirectory of a worktree is not scoped in T1 (no walk up), documented as a limit.
8. **Doctor enforcement is NOT this ticket (T3/165).** Note for the reviewer: the link deny is only reachable on the ask path. A config ALLOW on `path`, `path_write`, `external_directory_write`, `write` or `edit` short-circuits before the chain and disables the guard (FINDINGS P4 S1a/S1b, §2 revision 1; `src/handlers/gates/runner.ts:202-206`, `src/policy/permission-gate.ts:61-102`). T1 ships with that hole documented in `docs/reference.md` (slice f); the doctor check lands in 165.

## 2. Verified facts (cite, do not re-derive)

Toriel repo (`/home/ron/projects/toriel`):
- The existing link is `pi/extensions/toriel-grants.ts`. It returns early unless `TORIEL_CHILD` and `TORIEL_SOCK` are set (`:63-66`), registers on `permissions:ready` once (dispose-guarded, `:67-80`) via `services.get(sessionId).registerAuthorizer(LINK_NAME, ...)`, and its `authorize()` defers on every error (`:46-60`). The `Verdict` type is only `allow | defer` (`:17`); it must grow a `deny` variant with a `reason` (the probe's link returned `{ kind: "deny", reason }`, `phase1-scope-probes/probes/p4-chain-order.mjs:173-185`, and the real chain surfaced that reason verbatim: FINDINGS P5 S2).
- `AskDetails` (`:20-26`) has no `accessIntent`/`surface`. The real details object carries `accessIntent: { surface, matchValues, boundaryValue: string | null, delegationLicense? }` (`pi-permission-system/src/authority/permission-forwarding.ts:109-126`, `src/handlers/gates/helpers.ts:83-92` `accessFactsFromPath`) and a display `surface`. `boundaryValue` is `null` for a literal-only path with no canonical form (`helpers.ts:88-91`).
- Family naming: the gate-authoritative surface is `details.accessIntent.surface`, falling back to `details.surface`; membership is tested with `surfaceFamilyOf` (`pi-permission-system/src/authority/delegation-envelope.ts:75-82`, `src/access-intent/path-surfaces`). Directional members are `path_read`/`path_write`, `external_directory_read`/`external_directory_write` (`src/config/config-schema.ts:98,138`). **Not yet verified by a probe:** the exact surface string a write ask carries in `accessIntent.surface` (the probe link did not filter by surface). Slice (b) step 0 settles it; do not guess.
- The child env seam is `childEnv(s, sock, base)` (`src/child-env.ts:14-27`): copies `base` (= daemon `process.env`), then sets `TORIEL_CHILD`, `TORIEL_SOCK`, optional `TORIEL_SESSION_ID`. `bangEnv` (`:36-53`) calls `childEnv`, so any variable added there also reaches `!command`. **Hazard:** because `childEnv` spreads the daemon's own env, a `TORIEL_SCOPE_ROOT` in the daemon's environment would leak into every child. `childEnv` must delete it before conditionally setting it.
- The only production call that starts a pi child: `launch()` builds `env: { ...childEnv(s, SOCK), ...this.delegationEnv(s) }` at `src/daemon-children.ts:114`, with `cwd: s.cwd` at `:112`. Callers: `startArgs()` then `launch()` at `src/daemon-children.ts:198-200` and `src/daemon-handlers-lifecycle.ts:353-358` (fork). `startArgs` settles `s.agent` (`:166-167`) before `launch`, so `s.agent` and `s.cwd` are both known at `:114`. Respawn, `/reload` and `/clear` go through the same path, so the scope is re-resolved on each launch.
- Subagents get `ctx.registry.create(parent.cwd)` (`src/daemon-subagents.ts:276`): a subagent runs in its parent's cwd, so "a worktree spawn" in practice = a manager session whose cwd is a worktree spawning profile children, or a profile session started with that cwd (`spawn` command carries `cwd`, `src/shared.ts:221`; "spawn requests carry an explicit cwd", AGENTS.md).
- `DaemonSession` has `cwd` and `agent?: AgentProfile` (`src/daemon-session.ts:48`). `EnvSession` (`src/child-env.ts:8-11`) has only `sessionId`/`sessionFile`; the call passes the whole `DaemonSession`, which is structurally assignable.
- Extensions are loaded only from the explicit `RESOURCES` list in `src/resources.ts:50-55` (`-e <path>` per entry, `:75-80`). A helper file dropped in `pi/extensions/` is NOT loaded as an extension and is importable by relative `.ts` path (`toriel-grants.ts` already imports `./toriel-agents.ts`; tests import `../pi/extensions/*.ts`, e.g. `test/grants-extension.test.ts:13`).
- Existing tests to extend/mirror: `test/grants-extension.test.ts` (imports the extension, sets `TORIEL_CHILD/SOCK/SESSION_ID` before import, has a `fakeDaemon` socket stand-in), `test/child-env.test.ts` (`childEnv`/`bangEnv`, `deepEqual` on the whole env). The deepEqual at `test/child-env.test.ts:11` must keep passing: with no scope root `childEnv` output must be unchanged.
- Layout and conventions (AGENTS.md): `src/` TS run directly by node, no build; `test/` has one `*.test.ts` per module, `npm test` = `node --test test/*.test.ts` (`package.json:24`); node type stripping means no enums, namespaces or constructor parameter properties, `import type` for types, `.ts` extensions on imports; 2-space indent; block statements always (`if (x) { ... }`); pure logic in small modules with a unit test beside it; prefer explicit error handling; update `docs/reference.md` and README when behavior changes; env vars are listed in `docs/reference.md` "## Env". `agents/` profiles and `test/agents-shipped.test.ts` are untouched by T1 (profiles must not change).

pi-permission-system (source `/home/ron/projects/pi-permission-system-src`, v42.0.0):
- The chain exists only on the ask path (`src/authority/authorizer-selection.ts:252-266`); allow/deny from config never reach it (`src/policy/permission-gate.ts:61-102`, `src/handlers/gates/runner.ts:202-206`). Probe P4 S1a/S1b confirmed: config `*` allow on the covered surfaces = link never called. Doctor work is T3/165.
- Chain has no try/catch (`src/authority/authorizer-chain.ts:38-52`); a throw rejects `pipeline.evaluate` and the boundary converts it to a generic block (`src/handlers/tool-call-boundary.ts:21-61`). P6 S7 confirmed.
- A link `deny` is final and its reason is shown to the model verbatim: "The 'toriel-grants' authorizer denied this '<surface>' call for tool '<tool>' ... Reason: ..." (FINDINGS P5 S2). The decision is mapped in `decideFromVerdict` (`authorizer-chain.ts:~55+`). A link deny is not touched by the delegation envelope (it only downgrades `allow`, `delegation-envelope.ts:53-70`).
- Bare `path` and the `write`/`edit` tools fold into `path_read`+`path_write` (`src/policy/permission-resolver.ts:96-118`), so a `write`/`edit` tool call outside W produces a `path_write`-family ask and is covered with no extra tool-name logic. Bash redirects/`cp`/`mv`/`tee`/`sed -i` etc. arrive as the same surfaces (`src/handlers/gates/bash-path.ts:25`; FINDINGS P1 table; parser misses are T4).

## 3. Implementation plan

Do the slices in order; each is verifiable on its own (`node --test <file>` named in each). Work in a worktree of `/home/ron/projects/toriel`; do not run mutating git commands beyond what your worktree needs, Ron commits (CLAUDE.md).

### Slice (a): env contract module (pure, unit-testable)

New file `pi/extensions/scope-root.ts` (not in `RESOURCES`, so pi never loads it as an extension; `src/resources.ts:50-55`). No enums, `import type`, `.ts` import extensions. Imports only `node:fs` and `node:path`.

```ts
export const SCOPE_ENV = "TORIEL_SCOPE_ROOT";
export type Scope = { kind: "off" } | { kind: "root"; root: string } | { kind: "invalid"; why: string };
export function readScope(env: Record<string, string | undefined>, fsApi = { realpathSync: fs.realpathSync, statSync: fs.statSync }): Scope
export function isInside(root: string, target: string): boolean
```
`readScope` rules (FINDINGS P6 contract; decisions 3, 3b), wrapped in try/catch that returns `{ kind: "invalid", why }` and never throws:
1. `env[SCOPE_ENV] === undefined` -> `{ kind: "off" }`. Nothing else is "off".
2. Any present value (including `""` or whitespace-only) must satisfy ALL of: `path.isAbsolute(value)`; `value !== path.parse(value).root` (a filesystem root as scope would allow everything: invalid); `fsApi.statSync(value).isDirectory()`; `fsApi.realpathSync(value) === value` (canonical: no symlink component, no `..`, no trailing slash, no `//`). Otherwise `invalid` with a `why` such as `not an absolute path`, `does not exist`, `is not a directory`, `is not canonical (resolves to <real>)`. Do not trim or normalize the value; a value that needs fixing is invalid, never silently repaired.
3. Valid -> `{ kind: "root", root: value }`.

`isInside(root, target)`: `true` iff `target === root` or `target.startsWith(root + path.sep)`; `false` for a non-absolute `target`. Prefix match with the separator is the sibling-prefix defence (`/x/W-evil` is not inside `/x/W`). Both arguments are already canonical; do not call `resolve`/`realpath` on `target` here (the gate already canonicalised `boundaryValue`; re-resolving a path that does not exist yet would lose that).

Test: new `test/scope-root.test.ts`. Cases: unset -> off; `""`, `"  "`, `"relative/dir"`, nonexistent absolute, a regular file, `/`, a symlink to a real dir, `<W>/` (trailing slash), `<W>/../<W-name>` -> each `invalid` with a non-empty `why`; real tmp dir via `fs.realpathSync(fs.mkdtempSync(...))` -> `root`; injected `fsApi` whose `statSync` throws -> `invalid` (not a throw). `isInside`: W itself, child, nested child, `W-evil` sibling prefix, parent, `W/..`-style non-canonical text (a literal `/w/../x` is not inside; callers pass canonical), relative target.
Verify: `node --test test/scope-root.test.ts`.

### Slice (b): the scope check inside the toriel-grants link

File: `pi/extensions/toriel-grants.ts`. Header comment: update it (it currently says "Every failure defers ... nothing here may throw"; add that the scope check is the exception: it fails closed with a deny, and still never throws).

Step 0 (do first, 10 minutes, report it): confirm the surface strings. Build one covered ask through the real gate stack by adapting `phase1-scope-probes/probes/p4-chain-order.mjs` in a scratch file OUTSIDE the repo (it loads pi-permission-system from `PI_PERM_SRC`, default the global install; `p4:173-185` is the link slot): log `details.surface`, `details.accessIntent.surface`, `details.accessIntent.boundaryValue` for (i) the `write` tool outside W, (ii) `echo x > ../outside.txt` via bash, (iii) a symlink-out write, (iv) a `read` outside W. Expected: write-asks show `path_write` or `external_directory_write` (family via `surfaceFamilyOf`, `src/access-intent/path-surfaces.ts:76-83`); reads show `*_read`. If the strings differ from `path_write`/`external_directory_write`, set the `COVERED` set to what the gate actually emits and say so in your report. Do not commit the scratch file.

Changes:
1. `import { isInside, readScope, type Scope } from "./scope-root.ts";`
2. Extend `Verdict` (`:17`) with `{ kind: "deny"; reason: string }`.
3. Extend `AskDetails` (`:20-26`) with `surface?: unknown` and `accessIntent?: { surface?: unknown; boundaryValue?: unknown }`. Everything is `unknown` and type-narrowed by hand: the link must not trust the shape.
4. New exported pure function, the whole scope policy:
   ```ts
   export const COVERED = new Set(["path_write", "external_directory_write"]);
   export function scopeVerdict(scope: Scope, details: AskDetails): Verdict
   ```
   - `scope.kind === "off"` -> `defer`.
   - surface = `details.accessIntent?.surface` if a string, else `details.surface` if a string. Not a string, or not in `COVERED` -> `defer` (reads, bash, mcp, skills: not this ticket). Decide on the exact string; do not use `surfaceFamilyOf`-style prefix matching that would also catch `path_read`.
   - `scope.kind === "invalid"` -> `deny`, reason: `scope guard: TORIEL_SCOPE_ROOT is set but unusable (${scope.why}); denying all writes. Fix the environment the daemon starts this session with.`
   - `scope.kind === "root"`: `b = details.accessIntent?.boundaryValue`. If `typeof b !== "string" || b === ""` -> `deny`, reason `scope guard: cannot resolve a canonical target for this write; denying (scope root ${root})`. Fail closed: a covered write with no canonical form is not provably inside W. If `isInside(root, b)` -> `defer`. Else `deny`, reason `scope guard: ${b} is outside this session's write scope ${root} (TORIEL_SCOPE_ROOT). Write only under ${root}.` The reason MUST contain both the offending canonical path and W (FINDINGS P5 S2: the model sees it verbatim).
   - NEVER read `matchValues`, grant patterns, `details.path`, `details.value`, or `details.command` here (decision 2).
   - The whole body is in `try { ... } catch { return scope.kind === "off" ? defer : deny("scope guard: internal error evaluating this write; denying") }`. `scopeVerdict` never throws, including when `details` getters throw or `details` is a hostile/odd object (`null`, a string).
5. `authorize` (`:46`): add a 5th parameter `scope: Scope = { kind: "off" }` after `send`. First statement of the function, before the existing `try`: `const sv = scopeVerdict(scope, details); if (sv.kind === "deny") { return sv; }`. Then the existing grants logic runs unchanged (a scope `defer` falls into it; nothing else changes). A scope deny must not call `send` (decision 5). The existing `catch { defer }` for the grants path stays. Because `scopeVerdict` is itself total, `authorize` as a whole still never rejects.
6. Default export (`:62`): after the existing `TORIEL_CHILD`/`TORIEL_SOCK` early return, `const scope = readScope(process.env);` once (decision 4), and pass `scope` as the 5th arg in the `registerAuthorizer` callback (`:76`). The link does not log (no logging seam here); an invalid env surfaces as the deny reason, and the doctor (T3) reports it later.
7. Do not change `LINK_NAME`, `CHECK_TIMEOUT_MS`, `describeAsk`, or the registration/dispose logic.

Tests in `test/grants-extension.test.ts` (extend; reuse `fakeDaemon`, the preset `process.env` at the top of that file; do NOT set `TORIEL_SCOPE_ROOT` in the file-level env, pass `Scope` objects directly): see section 4.
Verify: `node --test test/grants-extension.test.ts`.

### Slice (c): the daemon sets TORIEL_SCOPE_ROOT in the child env

Two small edits plus one new pure module.

1. New `src/scope-root.ts` (daemon side; the one place that decides who is scoped; decision 6):
   ```ts
   export function scopeRootFor(cwd: string, hasProfile: boolean, fsApi = fs): string | undefined
   ```
   Returns the realpath of `cwd` iff `hasProfile` AND `<cwd>/.git` is a regular file (lstat, not a directory, not a symlink) whose first line is `gitdir: <p>` where `<p>` matches `/[\\/]worktrees[\\/][^\\/]+[\\/]*$/` (a linked worktree; a submodule's `.git` file points into `.git/modules/...` and must NOT match). Any other case, including any fs error while probing, returns `undefined` (unscoped); never throws. A relative `<p>` is fine (match on the text). The returned value is `fs.realpathSync(cwd)` and it is passed through unchanged to the env; `readScope` (slice a) re-validates it in the child, which is what makes it "canonical or deny-all" if e.g. the directory is moved between resolution and exec.
2. `src/child-env.ts`: `childEnv(s, sock, base = process.env, scopeRoot?: string)`. In the copy loop (`:16-20`) skip the key `TORIEL_SCOPE_ROOT` (a daemon started inside a scoped session must not leak its own scope; `TORIEL_SCOPE_ROOT` must only ever come from `scopeRoot`), and after the `TORIEL_SESSION_ID` block set `env.TORIEL_SCOPE_ROOT = scopeRoot` when `scopeRoot !== undefined`. Keep the 3-arg call shape valid: `bangEnv` (`:37`) keeps calling `childEnv(s, sock, base)` and therefore a `!command` never receives the variable (it is the user's own command, run by the daemon, not by the worker). Doc comment: say so.
3. `src/daemon-children.ts:114`: `env: { ...childEnv(s, SOCK, process.env, scopeRootFor(s.cwd, s.agent !== undefined)), ...this.delegationEnv(s) }`. Import `scopeRootFor` from `./scope-root.ts`. Compute it into a local `const scopeRoot` just above the `new RpcClient` (`:110`) and `log(\`scope root for ${s.sessionId ?? s.id}: ${scopeRoot}\`)` only when defined (the file already has `log`, used at `:80,126`). The cwd check `fs.existsSync(s.cwd)` (`:107`) already ran, so `realpathSync` will not hit a missing dir.
4. `delegationEnv` (`:91-97`) and `startArgs` are untouched. Do not add a `scope` field to `shared.ts`/`PROTOCOL` (no wire change).

Tests: `test/scope-root.test.ts` gets a `scopeRootFor` block (real tmp dirs): a plain repo (`.git` dir) with profile -> `undefined`; linked worktree (`.git` file `gitdir: /r/.git/worktrees/w1`) with profile -> realpath of cwd; same worktree with `hasProfile=false` -> `undefined`; submodule-style `.git` file (`gitdir: ../.git/modules/m`) -> `undefined`; no `.git` -> `undefined`; cwd that is a symlink to the worktree -> the canonical (realpath) target, not the symlink; unreadable/garbage `.git` file -> `undefined`, no throw. `test/child-env.test.ts` gets: `childEnv(..., {A:"1"}, "/w")` includes `TORIEL_SCOPE_ROOT: "/w"`; a `base` containing `TORIEL_SCOPE_ROOT: "/leaked"` with no `scopeRoot` argument -> key absent; with one -> the argument wins; `bangEnv` with such a base -> key absent. The existing 3-arg deepEqual (`test/child-env.test.ts:11`) passes unchanged.
Verify: `node --test test/scope-root.test.ts test/child-env.test.ts`, then `node --test test/daemon.test.ts` (launch path; fake pi at `test/fixtures/fake-pi.mjs` via `test/helpers.ts` still starts).

### Slice (d): what absence means, and how the daemon decides (opt-out story)

No code beyond (a)-(c); this slice is the contract in `docs/reference.md` and a code comment in `src/scope-root.ts`.
- `TORIEL_SCOPE_ROOT` absent in the child = guard off; the link defers everything (FINDINGS P6 "absent"). That is the only opt-out. The daemon simply does not set it unless `scopeRootFor` returns a root.
- T1's rule for "scoped" = profile session whose cwd is a linked-worktree root (decision 6, FINDINGS §2 "worktree spawns", SPEC-148-scope.md §4). It is deliberately narrow. Not in T1: the `scope:` frontmatter field and default-on/off per profile (T2), any broader rollout (T164/T8), reads (T7), the doctor check that a scoped session actually has the link and no allowing config rule (T3/165).
- Known limits to state in the docs: a session started in a subdirectory of a worktree is unscoped (decision 7); a config `allow` on `path`/`path_write`/`external_directory_write`/`write`/`edit` short-circuits the link (P4); and an extension that fails to register (older pi-permission-system without the authorizer seam, `toriel-grants.ts:77-79`) means no guard (FINDINGS §3).

### Slice (e): docs

- `docs/reference.md` "## Env" (`:323`): add `TORIEL_SCOPE_ROOT` as set BY the daemon for the child (not an operator knob): meaning, the three states (absent/invalid/valid), who gets it (decision 6), that the link denies covered writes outside it and fails closed when invalid, and the four limits from slice (d). Add `src/scope-root.ts` and `pi/extensions/scope-root.ts` to "Code layout" if that section lists files individually (it does: AGENTS.md says it "lists every file").
- Update the `toriel-grants.ts` row/description in `docs/reference.md` and, if `docs/permissions.md` states the link "only allows or defers", correct it (it now also denies).
- Do NOT add a doctor `CATALOG` entry: AGENTS.md requires one for setup a user must do; `TORIEL_SCOPE_ROOT` is daemon-set, not user setup. Say so in your report (T3/165 owns scoped-session checks). `README.md`: no change unless it lists child env vars.
- `docs/design.md`: one parked-work line pointing at FINDINGS-148 T2/T3/T4/T7 follow-ups (the doc already references the probe worktree at `:1327-1329`).

### Slice (f): optional live confirmation (not committed)

With slices (a)-(c) done, run the scratch harness from slice (b) step 0 with `scopeVerdict` imported from the real `pi/extensions/toriel-grants.ts` instead of the probe's inline link, `TORIEL_SCOPE_ROOT` = the probe's canonical W, and report the S2-style outcomes: outside-W `write` -> block with the link's reason; in-W write -> defer then terminal; symlink-out write (probe's `W/link-out`) -> block; no-config default. This is evidence for the ticket comment, not a test (pi-permission-system is not a repo dependency, so `npm test` must not import it).

## 4. Test plan

Runner: node >= 26 on PATH. On this host the default `node` is v27 alpha (`/home/ron/.nvm/versions/node/v27.0.0-alpha.0.0.0/bin/node`); AGENTS.md names v26 (`~/.nvm/versions/node/v26.12.0/bin`). Check `node --version` and put one of them first on PATH. Single file: `node --test test/scope-root.test.ts`; one case: `node --test --test-name-pattern="sibling" test/grants-extension.test.ts`. Use real tmp dirs for fs cases (`fs.mkdtempSync(path.join(os.tmpdir(), "toriel-scope-"))`, then `fs.realpathSync` it: `/tmp` may itself be a symlink on some hosts; every W you pass must be canonical).

Build asks with a helper in the test, `writeAsk(surface, boundaryValue, extra?)`, returning `{ surface, accessIntent: { surface, matchValues: [...], boundaryValue }, sessionApproval: { grants: [{ surface, pattern }] }, payload: { request: { value } } }`. `matchValues` must deliberately contain the LEXICAL alias inside W for the symlink case so the test fails if the implementation looks at it.

`test/grants-extension.test.ts` (scope link), each case asserts the verdict shape AND that the daemon stub (`fakeDaemon`) saw zero `permission_check` commands for denies:
1. `..` escape: W=`<tmp>/W`, ask `path_write` with `boundaryValue` = `<tmp>/outside.txt` (what the gate yields for `../outside.txt`) -> `deny`; `reason` includes the boundary path and `W`.
2. symlink-out: create `W/link-out -> <tmp>/main`; ask `external_directory_write` with `matchValues: ["<W>/link-out/f.txt", "<tmp>/main/f.txt"]` and `boundaryValue: fs.realpathSync` of the target dir + `/f.txt` (= `<tmp>/main/f.txt`) -> `deny` (P2 bypass closed).
3. sibling prefix: W=`<tmp>/W`, `boundaryValue` `<tmp>/W-evil/x` -> `deny`; also `<tmp>/W` itself -> `defer`; `<tmp>/W/sub/x` -> `defer`.
4. throwing link: (i) `details` whose `accessIntent` is a getter that throws, scope `root` -> returns `deny` (does not throw/reject); (ii) same details with scope `off` -> `defer`; (iii) `authorize(sock, uuid, null as never, ..., scope)` and a `send` stub that throws -> resolves, never rejects; (iv) registered through the default export with a fake `pi`/service map (mirror how the existing file exercises registration, if it does; otherwise call the captured authorizer closure) and a thrown getter -> a verdict, not a rejection.
5. invalid env: for each of `{ kind: "invalid", why }` produced by `readScope` from: `""`, `"relative"`, nonexistent, file-not-dir, `"/"`, symlink-to-dir, trailing slash -> `authorize` on a covered write inside the would-be W returns `deny` with a reason containing `TORIEL_SCOPE_ROOT`; and on `path_read`, `bash`, `mcp` surfaces returns `defer` (only the covered writes are denied). Never `defer` on a covered write while invalid.
6. defer-when-absent: scope `off` (and `readScope({})`) with an outside-W covered write -> `defer` (and the existing grants behavior is intact: the pre-existing `authorize` tests stay green unmodified).
7. family fold: asks produced the way the fold produces them for a `write` tool call (`details.surface: "write"` display, `accessIntent.surface: "path_write"`) and a bare-`path`-origin ask with `accessIntent.surface: "path_write"` outside W -> `deny`; a `path_read` outside W with the same boundary -> `defer` (reads not jailed); `external_directory_read` -> `defer`. Add a one-line comment citing `src/policy/permission-resolver.ts:96-118` in pi-permission-system. If slice (b) step 0 showed different surface strings, use the real ones here.
8. missing boundary: covered write with `boundaryValue: null` or `""` or non-string under a valid scope -> `deny`.
9. order: a valid-scope outside-W ask whose grants WOULD be allowed by the daemon stub (`allow: true`) is still `deny`, with zero daemon calls; an inside-W ask with grants reaches the daemon and honors its answer (grants path unchanged).

`test/scope-root.test.ts`: the `readScope`, `isInside`, `scopeRootFor` cases from slices (a) and (c). `test/child-env.test.ts`: the `scopeRoot` cases from slice (c). Each file keeps the repo style: `node:test` `describe`/`it`, `node:assert/strict`, one behavior per `it`.

Regression to eyeball: `test/daemon.test.ts` and `test/doctor*.test.ts` unchanged and green (the launch path and doctor catalog were touched only indirectly).

## 5. Gates

All three, from the repo root, with node >= 26 on PATH, must pass before reporting done (CLAUDE.md, AGENTS.md "Commands"):
- `npm test` (`node --test test/*.test.ts`; no network, no model).
- `npm run typecheck` (`tsc -p .`; node strips types and never checks them, so this is the real check of the new `Verdict`/`Scope` unions and the `childEnv` signature).
- `npm run lint` (`biome lint .`; formatter is not enforced but keep 2-space, blocks always).
- `test/agents-shipped.test.ts` is part of `npm test`; profiles (`agents/*.md`) must NOT change in T1, so it must pass untouched. If you touched any `agents/` file, you went out of scope: revert it.
- Do not run `toriel doctor` expecting a new finding; no catalog entry is added (slice e). `test/doctor.test.ts` still passes unchanged.
- Report: which of the three gates ran, their outputs' tails, the slice (b) step 0 surface strings you observed, and any deviation. Then follow the job-board workflow (AGENTS.md "Job board"): leave Vikunja task 163 open with the `needs verification` label and a `Done (agent, <date>)` comment with validation steps (run the new test files; slice (f) outcomes). Only Ron marks it done.

## 6. Out of scope

- Read jail: `path_read`/`external_directory_read` stay un-denied (FINDINGS P3 verdict; T7). The link must `defer` on them even with an invalid env (test case 5/7).
- Doctor: no `CATALOG` entry, no check that a scoped session has the link registered, that `authorizerChain` lists `toriel-grants`, or that operator config lacks allowing rules on `path`, `path_write`, `external_directory_write`, `write`, `edit` (FINDINGS P4 revision 1, T3; ticket 165). T1 documents the hole; it does not detect it.
- bwrap/landlock OS sandbox (T6, phase 5); program-side effects (`python -c`, `make`, scripts), parser misses (`dd of=`, variable/command-substitution redirects, `eval`; T4, FINDINGS P1/§3); in-cwd git semantics and worktree object-store writes outside W (a scoped `git commit` writing `.git/worktrees/<name>` is denied by design; decision 4 of the scope doc = git via MCP verbs only; the shipped profiles already comply, FINDINGS §4 / `test/agents-shipped.test.ts:67`; do not edit `implement`/`test-runner` prompts here, that is T2/T5).
- Profile frontmatter `scope:` field, per-profile default/opt-out, `agents/README.md` changes (T2). Any rollout beyond "profile session at a linked-worktree root" (T164/T8). Sub-directory walk-up to find the worktree root. `PI_SUBAGENT_PARENT_SESSION` plumbing / permission forwarding for scoped children (FINDINGS P5 note; T2).
- Config files in the worktree as a scope source (decision 5 of the scope doc), `/tmp/toriel-res-*` resource-copy injection (H-a5, not probed), protocol changes (`PROTOCOL` in `src/shared.ts` stays).
