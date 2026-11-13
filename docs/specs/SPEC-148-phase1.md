# SPEC: ticket 148 phase 1 - directory-scoped sessions (verification-first investigation)

Scope doc: `~/projects/toriel-worktrees/SPEC-148-scope.md` (Sonnet draft, claims verified by manager). This file is the executable spec for the investigation itself. Findings report + follow-up tickets; NO implementation in this ticket.

## Decisions of record (Ron, 2026-11-06)

1. **Reads AND writes**, if no extra work; defer reads only if they carry extra consequences.
2. **Threat model: mistakes** (the F8 qwen-worker incident). Adversarial workers are phase-5 (bwrap) territory; parser residue is acceptable until then.
3. **Scoping is ON by default** for every agent spawned with a worktree; exceptions via agent-profile frontmatter (`scope: none` or similar).
4. **Git goes through the git-MCP verbs only** for agents. The safer verb subset (toriel-git-mcp `src/verbs.ts`: git_status/git_diff/git_log/git_show/git_blame/git_grep) is what agents should have. Agent profiles' tool lists must be audited: any agent that needs git gets exactly the git-MCP verbs it needs, not raw `git` bash.
5. **No config files inside worktrees.** Scope reaches the child through daemon env + the toriel-grants link only, so nothing the worker can write can loosen its own scope.

## Verified facts (manager-confirmed, file:line)

- Package source: `/home/ron/projects/pi-permission-system-src` (@gotgenes/pi-permission-system 42.0.0, TS source only - no dist JS; pi loads it via jiti). Toriel: `/home/ron/projects/toriel` (TS, no build; node v27 alpha: `export PATH="$HOME/.nvm/versions/node/v27.0.0-alpha.0.0.0/bin:$PATH"`).
- **F1 chain**: `composeAuthorizerChain` (`src/authority/authorizer-chain.ts:24-52`) - links in order, defer falls through, terminal decides; link allow is non-persistent.
- **F2 bounded delegation**: `src/authority/delegation-envelope.ts:48-90` - a link ALLOW on path/external_directory surfaces downgrades to defer unless the "nothing-on-disk" license is present (external_directory only; `path` takes no license). So the scope guard must be DENY-shaped.
- **F3 directional surfaces**: `src/access-intent/path-surfaces.ts:31-36` (`path`, `external_directory` families with `_read`/`_write` members); resolver folds bare families most-restrictive (`src/policy/permission-resolver.ts:96-106`).
- **F4 bash gating**: `src/handlers/gates/bash-external-directory.ts:28-43` via `bashProgram.externalAccesses()` (`src/access-intent/bash/program.ts:160-230`) - tree-sitter parse, redirect/sed/awk analysis, cd folding, lexical+canonical symlink pairs, fail-closed `readsVerbatim()`.
- **F5 toriel seams**: daemon child env `src/daemon-children.ts:114` (`env: { ...childEnv(s, SOCK), ...delegationEnv(s) }`, builder `src/child-env.ts:14-26`); pi tool replacement feasible (`pi-coding-agent/dist/core/agent-session.js:2922-2926`); toriel-grants link registered in `toriel/pi/extensions/toriel-grants.ts`, activated by `authorizerChain: ["toriel-grants"]` in `~/.pi/agent/extensions/pi-permission-system/config.json`.
- **F6 project scope exists but is OUT** per decision 5: `getProjectConfigPath` = `<cwd>/.pi/extensions/pi-permission-system/config.json` (`src/config/config-paths.ts:18-20`), trust-gated (`src/session/permission-session.ts:110-116`). Probes must still document it (it is the fallback if the link proves unusable) but must not build on it.
- **F7 pi rule precedence**: `src/policy/wildcard-matcher.ts` + `src/policy/restrictiveness.ts` (mostRestrictiveOf) - verify last-match vs most-restrictive vs deny-wins empirically (probe P2).

## Probe mechanics

- Pure-engine probes (corpus, precedence): import the package through jiti (pi's node_modules has jiti; `createJiti(import.meta.url)` with the package dir as alias base), or run the smallest real pi (`--print`, `--no-tools` off) as the oracle when the engine API fights back. Save every probe script in the worktree under `probes/`.
- End-to-end probes (headless deny, chain order): spawn a real pi child from a scratch dir with a scratch agentDir; use `DEBUG_LOG_FILENAME` (referenced in `src/config/config-paths.ts`) and the permission review log (`~/.pi/agent/extensions/pi-permission-system/logs/permission-review.jsonl`) as evidence sources.
- Never touch the real `~/.pi/agent/extensions/pi-permission-system/config.json` from a probe; copy it to a scratch agentDir and aim pi at that (check how pi picks the agentDir: env or flag - verify, cite).

## Probes (all must be run, verdicts recorded, scripts saved)

**P1 - bash corpus through `externalAccesses()`** (cwd = a scratch worktree W; expected verdict in brackets):
redirects (`> ../o`, `>>`, `2>`, `&>`, `exec 3> ../o` [last doubtful]); `sed -i`, `sed -i` with glob, `awk -i inplace`; `cp a ../b`, `mv`, `install`, `ln -s`, `rm ../f`, `mkdir ../d`, `touch`, `dd of=../f` [dd doubtful], `tee ../f`, `tee -a` [tee doubtful]; `cd .. && echo x > f`, `pushd`, `(cd ..; ...)`, `env -C ..`, `git -C ..` [verify each]; `d=..; echo x > $d/f`, `echo x > "$(pwd)/../f"`, `eval "echo x > ../f"` [fail-closed expected]; symlink inside W pointing out; **git writes**: `git checkout`, `git apply`, `git -C <main> commit`, `git worktree add` (the realistic F8 leak paths). Residue list (expected NOT caught): `python -c`, `node -e`, `make`, `npm run`, `curl -o` computed, `sh script.sh` written-then-run, `find -exec`, `xargs`.
Output: table `command | verdict | gate | note`; every should-have-caught miss is a candidate upstream/toriel ticket.

**P2 - rule precedence** (decides whether `"*": deny` + `"<W>/**": allow` is expressible): table-driven probe with cases W/a, W/../x, sibling `W-evil/`, symlink out. Cite matcher + restrictiveness source for the mechanism, runtime output for the truth.

**P3 - read jail cost** (decision 1): repeat the P2 shape on `path_read`; then determine what an implement agent genuinely needs to READ outside W (node_modules, skills dir, `~/.pi/agent` extension dirs, the transcript dirs) and whether the deny-by-default + resolved-target allowlist of record is expressible with the matcher. Deliverable: the minimal allowlist that keeps a real implement worker functional, or the statement that reads must be deferred.

**P4 - chain order vs config allow**: with a config `path_write: {"*": "allow"}`, does an outside-W ask still reach the link (so the link deny applies), or does the config allow short-circuit first? Verify the call path from the gate to the chain (`authorizer-chain.ts:24-52` and its call site). This is the difference between "link deny is the guard" and "config must be deny-shaped too".

**P5 - headless deny, no hang**: subagent session, ask targeting outside W -> must resolve as deny with a legible reason, never hang on a prompt. Check `src/authority/approval-escalator.ts` / permission-forwarding for the subagent path.

**P6 - fail-closed semantics**: TORIEL_SCOPE_ROOT absent vs set-but-bogus - what does the link do today (it does not know the env yet; document what the env would need) and what pi does when a registered link throws.

## Findings report (deliverable, `FINDINGS-148-phase1.md`)

1. P1-P6 verdict tables + probe scripts.
2. The recommended guard, confirmed or revised: daemon sets `TORIEL_SCOPE_ROOT=<canonical W>` for worktree spawns (default on, `scope:` frontmatter opt-out), toriel-grants denies `path_write`/`external_directory_write` (and `_read` per P3) outside W with a reason, fail closed on unparseable env; git MCP verbs allowed so shell git is unnecessary.
3. Unenforced residue stated plainly (parser misses, git object-store writes if shell git were ever allowed, adversarial escape - phase 5).
4. The agent-tool audit list: every shipped profile in `toriel/agents/`, its tool list, and what git access (if any) it should have as MCP verbs.
5. Follow-up tickets (see below), each filed on the board with the evidence attached.

## Acceptance

- Every probe has a saved script + recorded output; no verdict from reading alone.
- The report names the exact first guard with file:line for every claim.
- Follow-up tickets filed; ticket 148 left open with `needs verification` + Done comment (validation steps) per the board workflow.

## Candidate follow-up tickets (file after probes confirm)

- **T1 scope deny**: TORIEL_SCOPE_ROOT env + toriel-grants deny outside W, fail closed; tests for `..`, symlink, sibling-prefix `W-evil`, git-metadata allowance.
- **T2 profile `scope` field + default-on**: frontmatter `scope: none` opt-out; daemon resolves W from the spawn's worktree; default scoped for worktree spawns.
- **T3 doctor**: scoped session without the registered link = error; authorizerChain check; worktree-spawn assertions.
- **T4 bash-parser gaps**: one ticket per P1 should-have-caught miss (upstream or toriel-side command-effects config).
- **T5 agent git-via-MCP audit**: update profiles per the findings report section 4 (decision 4).
- **T6 phase-5 sandbox spike**: bwrap vs landlock, worktree `.git` bind, pi inside-or-outside; blocked on T1.
