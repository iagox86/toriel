# PPS-148 Phase 1 scoping: directory-scoped pi sessions

Status: scoping only, no implementation. Facts F1-F8 are taken from the brief. Two extra findings from my own reading are marked **[new]**.

## 1. Framing
Phase 1 is a verification-first investigation. Its output is a findings report plus follow-up tickets, not code. We need to know which injection point can carry a "file effects only under W" ruleset into one session, what the existing path and bash gates catch, and what they cannot. Incident F8 (qwen implement worker wrote into the main checkout despite a worktree-only brief) shows that prompt instructions are not a guard. Whatever ships first has to be mechanical. It also has to be honest that rules are not a sandbox (F5 residue), so OS enforcement stays phase 5 (F7).

**[new] N1.** pi-permission-system already has a project scope: `<cwd>/.pi/extensions/pi-permission-system/config.json` (src/config/config-paths.ts:18-20, loaded in src/config/policy-loader.ts:217-235). It is withheld when the project is untrusted (src/session/permission-session.ts:110-116, #644). A worker's cwd is its worktree, so this is a candidate per-session injection point that needs no global edit. Per-agent files under `<cwd>/.pi/agents` also exist (config-paths.ts:29).

**[new] N2.** Toriel owns the child's argv and env (src/daemon-children.ts:105-187, src/child-env.ts:14-26). A spawn-time seam therefore exists on the toriel side without touching global config. It can set env, write a file into the worktree before launch, or add flags.

## 2. Testable probes

### (a) Can deny-everything-outside-W be expressed per session today?
- **H-a1 (global config).** Expressible, but it applies to every session. It cannot be per-worker, so it is out as the primary mechanism. Verify: write `path_write: {"*": "deny", "<W>/**": "allow"}` into a scratch agentDir. Check what the resolver does for an inside-W and an outside-W write.
- **H-a2 (rule precedence).** Unknown whether the wildcard matcher is last-match-wins, most-specific-wins, or deny-wins. This decides whether `"*": deny` plus `"W/**": allow` works at all. Verify by reading src/policy/wildcard-matcher.ts and src/policy/permission-resolver.ts:96-106 (the folding in F3), then run a table-driven unit probe with `bun test` or a scratch script. Cases: W/a, W/../x, a sibling `W-evil/`, a symlink out of W.
- **H-a3 (project scope).** A worktree-local `.pi/extensions/pi-permission-system/config.json` is loaded for a session whose cwd is W, if W is trusted. Verify with a runnable probe: create a git worktree, drop the config in it, start pi with `--print` or RPC, attempt a write to `../outside`, and read the debug log (`DEBUG_LOG_FILENAME` in config-paths.ts:6).
  - Sub-question: how does toriel's launch path (daemon-children.ts) answer the trust check? Does it ever prompt, or auto-trust?
  - Sub-question: is the project file merged with global as tighten-only, or can it loosen? The loosen case matters if W's contents are untrusted.
- **H-a4 (self-edit hole).** The config lives inside W, so the worker's own `write`/`edit` tool can rewrite it. It is cached by file stamp (policy-loader.ts:221-223), so a rewrite takes effect on the next evaluation. Verify with a probe: ask a session to overwrite its own project config, then retry the outside write. Mitigations to test: deny writes to `**/.pi/**` in the same ruleset, or put the file outside W.
- **H-a5 (per-session resource copy, F4).** The `/tmp/toriel-res-*` copy has unknown ownership and timing. Verify by launching one session and checking for it. Compare its mtime to the pi process start. Check whether the pi-permission-system loader reads the copy or the real agentDir (extension-paths.ts). Only useful if it is read AND toriel can write it before first tool call.
- **H-a6 (agent profile frontmatter).** Does pi-permission-system parse `permission:` frontmatter from the agent file (src/config/yaml-frontmatter.ts)? If it does, does toriel/agents/*.md reach it, given toriel passes profiles through `profileArgs`? That would be the natural place for an "implement" profile. Verify by reading yaml-frontmatter.ts and the agent-config caches (policy-loader.ts:166, 299).
- **H-a7 (session rules).** The package has session-scoped grants (`approved_for_session`). Verify whether session rules can be seeded at spawn, or only created by approval. Per F1 a chain-link allow is non-persistent.

### (b) Does the bash parser catch the common effects, and what escapes?
Run a fixed corpus through `bashProgram.externalAccesses()` (src/access-intent/bash/program.ts:160-230) with W as cwd. Report the verdict per case, with the expected verdict in brackets:
- Redirects: `echo x > ../o`, `>>`, `2> ../o`, `&>`, `exec 3> ../o` [catch, last one doubtful].
- `sed -i s/a/b/ ../f` and `sed -i` with a glob; `awk -i inplace` [catch via sed-invocation.ts / awk-invocation.ts].
- `cp a ../b`, `mv`, `install`, `ln -s`, `rm ../f`, `mkdir ../d`, `touch`, `dd of=../f` [catch via command-effects; check `dd of=` and `tee`].
- `tee ../f`, `tee -a` [catch? verify tee is in command-effects-config.ts].
- `cd .. && echo x > f` (cd folding), `pushd`, `(cd .. ; ...)`, `env -C ..`, `git -C ..` [verify].
- Variable and substitution: `d=..; echo x > $d/f`, `echo x > "$(pwd)/../f"`, `eval "echo x > ../f"` [expect fail-closed via readsVerbatim, confirm it asks or denies instead of allowing].
- Symlinks: a symlink inside W pointing out; write through it [lexical + canonical pair should catch].
- Git operations: `git checkout`, `git apply`, `git -C <main> commit`, `git worktree` writes. These are the likely real-world F8 leak, since the worker may `cd` to the main checkout.
- Residue (expected NOT caught): `python -c 'open("/main/f","w")'`, `node -e`, `make` or `npm run` scripts writing elsewhere, `curl -o` with computed paths, `sh script.sh` where the script is written first and then run, `xargs`/`find -exec` with generated paths.
Output is a table of `command | verdict | gate | note`. Cases that are allowed but should not be are bugs for upstream or toriel tickets.

### (c) Composition of the chain link and the config deny for the implement agent
- **H-c1.** Per F2 the toriel-grants link cannot allow path-surface asks. It can only deny or defer. The scope therefore has to be expressed as config rules (allow inside W, deny outside), with the link as a second-line deny (and optionally an audit log). Verify with the delegation-envelope.ts:48-90 tests and a probe: link returns allow for an inside-W write and the outcome is the config's decision, not the link's.
- **H-c2.** The link needs W. Proposed channel: env var set by the daemon at spawn (`TORIEL_SCOPE_ROOT`, via childEnv), read by toriel-grants.ts. A link deny is non-bypassable by config allow, because the chain runs before the terminal (F1). Verify the order: does an earlier config `allow` short-circuit before the chain is consulted? Read authorizer-chain.ts:24-52 and the call site.
- **H-c3.** Bare family `path` folds over `_read`/`_write` taking most-restrictive (F3). Scoping writes only (reads stay open for exploration) needs the `_write` members explicitly. Verify that a `path_write` rule does not also close reads (a read of the main checkout must still work for the implement agent).
- **H-c4.** What does an ask do for a headless worker? Outside-W should resolve as a deny with a legible reason, not hang waiting for a human. Verify the approval-escalator / permission-forwarding path (src/authority/approval-escalator.ts, permission-forwarding.ts) when the session is a subagent.

### (d) OS-level options (phase-5 follow-up, no work now)
Document only, as a comparison:
- **bwrap**: bind-mounts W read-write, the rest read-only or absent. It stops all child effects, including interpreters, `make`, and scripts written then run, which rules cannot see (F5 residue). Costs: user namespaces availability, the need for read access to toolchains, `.git` of a worktree pointing at the main repo's `.git/worktrees` (git writes there; it must be bound writable), network, and the fact that pi itself and its extensions would run inside or outside the sandbox (decide which).
- **landlock**: no mount-namespace setup. Self-restricted by the process before exec, inherited by children, irreversible. Needs a launcher shim (no stock CLI), kernel ABI support (probe `/sys/kernel/security/landlock` on this box, Fedora 7.1 should be fine), and can only allow-list path hierarchies. It does not hide paths, so reads of the main checkout stay possible unless excluded.
- Both: stop effects from the pi process itself (e.g. an extension bug), which rules cannot. Neither replaces the permission system's legibility (reasons, audit); they would be the backstop.
Probe: `bwrap --ro-bind / / --bind $W $W bash -c 'echo x > $MAIN/f'` and a landlock equivalent, checking the error mode an agent would see.

## 3. Option matrix (injection points)

| Injection point | Enforcement strength | Blast radius | Doctor implications | Phase fit |
|---|---|---|---|---|
| Global config (`~/.pi/agent/extensions/.../config.json`) | Same as rules (path gates + bash parser, F5). Cannot differ per session. | Every pi session on the box, including interactive ones | Doctor can check the file is present and sane, but a per-worker W cannot be in it | Not suitable alone. Could hold a static baseline (e.g. deny `**/.pi/**` writes). |
| Per-session resource copy (`/tmp/toriel-res-*`) | Same as rules, if it is read. Ownership and timing UNKNOWN (H-a5). | One session | Hard to inspect: ephemeral, regenerated by pi's ResourceLoader and likely overwritten | Only after probe H-a5. Fragile: a race with pi's copy. Do not build on it unproven. |
| Project-scope config in the worktree (N1) | Same as rules. Self-editable by the worker unless `.pi/**` is denied (H-a4). Depends on trust (#644). | One worktree/session | Doctor can verify the file exists in each live worktree and that the project is trusted. Add to `.git/info/exclude` so it never lands in a commit. | Good phase-1 candidate. Verify before committing to it. |
| Agent profile frontmatter (`toriel/agents/*.md`, H-a6) | Same as rules. Static per profile, so W would have to be templated in, which frontmatter does not do. | All sessions of that profile | Doctor can lint profiles. Easy to review in git. | Good for the *shape* of the policy (deny-outside, `_write` only), poor for the value of W. |
| Spawn-time env + toriel-grants link (N2, H-c2) | Deny-only (F2), but non-bypassable by config allow and independent of config files. Same parser limits (F5) apply to bash. | One session, daemon-controlled | Doctor can check `authorizerChain: ["toriel-grants"]` is registered and that the link loads. Failing open if the extension is missing is the key risk. | Best phase-1 fit. Smallest toriel-side change, in line with F7 "seam for --root + scope-able grants". |
| Spawn-time tool replacement (F6, agent-session.js:2922-2926) | Strong for pi's `edit`/`write`: scoped tools refuse in code, with no rule engine involved. Does not cover `bash`, unless bash is also replaced by a wrapped tool that runs the parser. | One session | Doctor can assert the replaced tools are the ones active. | Phase 2 candidate. More code, more drift from upstream pi tool behavior. |
| OS sandbox (bwrap / landlock) | Strongest. Catches interpreters and scripts (F5 residue). | One process tree | Doctor must check userns/landlock availability and toolchain binds | Phase 5 (F7). |

Reading the matrix: no single injection point is both per-session AND tamper-resistant AND covers bash residue. The first guard should combine two cheap layers (policy shape + a daemon-supplied W), and be explicit that the third layer (OS) is not there yet.

## 4. Recommendation: first mechanical guard

**Ship: a toriel-grants deny for write/edit/bash-external effects outside `TORIEL_SCOPE_ROOT`, set by the daemon for agent profiles that declare `scope: worktree` (or implicitly for any session spawned with a worktree).** Back it with a config-level baseline that denies writes to `**/.pi/**` and to the toriel agent files. Steps:
1. Daemon sets `TORIEL_SCOPE_ROOT=<canonical W>` in childEnv for scoped spawns only.
2. toriel-grants link: for `path_write` and `external_directory_write` asks (and the bash-derived external accesses that arrive as the same surfaces), resolve the target (lexical and symlink-canonical, as the gates already supply) and **deny** with a reason naming W if it is not under W. Otherwise **defer** (F2: allow is downgraded anyway).
3. Fail closed: if `TORIEL_SCOPE_ROOT` is set but unparseable or W does not exist, deny all writes rather than defer.

Why this one: it would have stopped F8 (a plain `write`/`edit` of a main-checkout path, or a `bash` redirect/cp into it), needs no config-file management, is per-session, and cannot be undone by the worker rewriting a file it can reach (the deny comes from the daemon env + extension, not a worktree file; the env var is not writable by the worker's tools, though a bash command can spawn children with different env, which does not matter for pi's own gate).

**Unenforced residue, stated plainly:**
- Side effects of programs whose target paths are not in the command text: interpreters (`python -c`, `node -e`), scripts written then run, `make`/`npm run`/build tools, `find -exec` and `xargs` with generated paths (F5). The parser sees the command line, not what the binary does.
- Git writes to the shared object store and `.git/worktrees` metadata, which are legitimately outside W for a worktree. Either allow-list that path precisely or accept it.
- Reads. This guard is writes only; the read jail is a separate decision of record (F7).
- A worker that is determined to escape (prompt-injected, or a model bypassing deliberately). This is a guard against mistakes, as in F8, not against an adversary. Only phase 5 changes that.
- The guard depends on the extension loading. Doctor must treat "scoped session but link not registered" as an error.

## 5. Acceptance criteria and follow-up tickets

### Phase-1 acceptance criteria
1. The (b) corpus has been run and the verdict table is in the findings report. Every cell is a command, not an inference from reading.
2. H-a2 (rule precedence) and H-a3 (project scope loads from a worktree and is trust-gated) are answered with a runnable probe each, with the probe scripts saved in the repo.
3. H-a5 is answered with a yes/no on "usable injection point", with the observed ownership and timing.
4. H-c1/H-c2 confirmed: a link deny beats a config allow, and a link allow is downgraded on path surfaces. A unit-level test points at the real chain.
5. H-c4: outside-W in a headless subagent resolves as deny with a reason, with no hang.
6. The report lists residue and the OS-level options (d) with a verdict on feasibility on this host (userns and landlock probe output).
7. Follow-up tickets below are filed, with the recommendation confirmed or revised by the evidence.

### Candidate follow-up tickets
- **T1: toriel-grants scope deny.** Implement the section 4 guard: `TORIEL_SCOPE_ROOT` in childEnv, deny outside W, fail closed, tests for symlink, `..`, sibling prefix (`W-evil`) and the git-metadata allowance.
- **T2: agent profile `scope` field.** Add `scope: worktree|none` to profile frontmatter (`profileArgs` in agents.ts) and have the daemon resolve W from the session's worktree. Default for `implement` profiles.
- **T3: doctor check for scoped sessions.** Assert that a session started with scope has the link registered, that `authorizerChain` includes it, and that the project config (if used) is trusted and excluded from git.
- **T4: bash-parser gap fixes.** File one issue per escape in the (b) table that should have been caught (tee, `dd of=`, `env -C`, etc.), upstream or in a toriel-side command-effects config (command-effects-config.ts).
- **T5: phase-5 sandbox spike.** bwrap vs landlock comparison from (d), including the worktree `.git` bind and the pi-inside-or-outside-sandbox decision. Blocked on T1 shipping.

## 6. Open questions for Ron
1. Should scoping cover reads too in phase 1 (jail the implement agent to W for reads), or writes only? F7 says the read jail is deny-by-default with a resolved-target allowlist, but that is a separate decision. This guard assumes writes only.
2. Is "guard against mistakes like F8" the right threat model for phase 1, or must it hold against a deliberately adversarial worker? That decides whether residue in section 4 is acceptable until phase 5.
3. Should the scoped profile be opt-in (`scope:` in frontmatter) or the default for every agent spawned with a worktree, with an explicit opt-out?
4. Git metadata: the worktree's `.git` file points into the main repo's `.git/worktrees/<name>`, and commits write to the shared object store. Allow those exact paths, or require agents to use the git-MCP verbs only (F7) so the shell never needs them?
5. Is it acceptable to put a pi-permission-system config file into worktrees (N1) at all, or should everything go through the daemon env and the link so nothing in the worktree can be edited into a loosening?
