# FINDINGS: ticket 148 phase 1 - directory-scoped pi sessions

Verification-first investigation per `SPEC-148-phase1.md`. Every verdict below
carries captured probe output (`probes/p*-output.txt`) plus file:line citations
into the pi-permission-system source (`/home/ron/projects/pi-permission-system-src`,
package 42.0.0, loaded by pi via jiti). Probe scripts: `probes/p1-bash-corpus.mjs`,
`probes/p2-precedence.mjs`, `probes/p3-read-jail.mjs`, `probes/p4-chain-order.mjs`
(P4/P5/P6 share one harness). No verdict is from reading alone.

## 1. Probe verdicts

### P1 - bash corpus through `externalAccesses()` (re-run 2026-11-06, reproduces)

`probes/p1-bash-corpus.mjs`, output `probes/p1-output.txt`.
21/24 should-catch cases caught. Verdict table (full version in p1-output.txt):

| command | verdict | gate | note |
|---|---|---|---|
| `echo x > ../o` / `>>` / `2>` / `&>` | CAUGHT | redirect | all four |
| `exec 3> ../o && echo x >&3` | CAUGHT | fd redirect | was "doubtful", works |
| `sed -i` plain / glob; `awk -i inplace` | CAUGHT | sed/awk invocation | |
| `cp`, `mv`, `rm`, `mkdir`, `touch`, `install`, `ln -s` (both directions) | CAUGHT | command-effects | |
| `dd if=/dev/zero of=../f` | **MISS** | - | real write primitive, not in command-effects → T4 |
| `tee ../f`, `tee -a` | CAUGHT | command-effects | was "doubtful", works |
| `cd .. && echo x > f`, `pushd`, subshell `(cd ..; …)`, `env -C ..`, `git -C ../main` | CAUGHT | cd-folding / -C | |
| `d=..; echo x > $d/f` | **MISS** | - | variable-expanded redirect not tracked → T4 |
| `echo x > "$(pwd)/../f"` | **MISS** | - | command-substitution redirect not tracked → T4 |
| `eval "echo x > ../f"` | **MISS** | - | expected fail-closed; `readsVerbatim()` still true and no access → T4 |
| write / read via symlink inside W pointing out | CAUGHT | lexical + canonical pair | works, as F4 predicted |
| `git apply ../patch.diff` | CAUGHT | - | as read of the patch file only |
| `git -C ../main commit -m 'msg'`, `git worktree add ../wt2` | CAUGHT | - | caught via the `-C`/operand directory, not via git semantics |
| `git checkout -b feature` (cwd = W) | **MISS** | - | in-cwd git writes are invisible to a parser that only sees external paths; git effect semantics are unmodelled. Mitigated by decision 4 (MCP verbs only), not a parser bug |
| `python -c`, `node -e`, `make`, `npm run`, `curl -o $(pwd)/../f`, `bash script.sh` | MISS | - | residue, as expected |
| `find .. -exec rm`, `xargs rm ../…` | CAUGHT | - | only because the corpus used literal outside paths; generated paths are residue, as expected |

Candidate upstream/toriel tickets from P1: `dd of=`, variable-expanded
redirects, command-substitution redirects, `eval` (fail-closed). One ticket
each, T4.

### P2 - rule precedence: last-match-wins confirmed (re-run, reproduces)

`probes/p2-precedence.mjs`, output `probes/p2-output.txt`.

- Mechanism: last rule matching wins. `evaluate()` uses
  `rules.findLast(ruleMatches)` (`src/policy/rule.ts:107`) and
  `evaluateAnyValue()` uses `rules.findLast(r => values.some(...))`
  (`src/policy/rule.ts:236`); the matcher itself is `findLast`
  (`src/policy/wildcard-matcher.ts:103`). Not most-specific-wins, not
  deny-wins. `mostRestrictiveOf`
  (`src/policy/restrictiveness.ts:31`, ordering `:44-47`) is used only for
  folding a bare family over its `_read`/`_write` members
  (`src/policy/permission-resolver.ts:96-118`) and combining multiple
  gate results - never for rule precedence.
- Runtime truth (`path_write`): RS-A `[deny "*", allow "<W>/**"]` gives
  inside-W allow, outside deny (parent and sibling included). RS-B (reversed)
  denies inside W too: the later catch-all deny shadows the earlier allow.
  So `"*": "deny"` + `"<W>/**": "allow"` **is expressible, in that order
  only**.
- **Symlink-alias bypass (confirmed, new):** a symlink inside W pointing out
  matches as `…/W/link-out/target.txt` → ALLOW under RS-A. The matcher sees
  the lexical alias union ∪ canonical (`src/access-intent/access-path.ts:41-47`,
  `matchValues()`), and last-match-wins means the later `W/**` allow matched
  on the lexical alias beats the earlier `*` deny even though the canonical
  target is outside W. Config rules cannot close this hole; only a chain link
  checking the canonical (`boundaryValue`) can. This is an "allow where you
  don't want", not a "miss where you do want": P1 shows the bash gate catches
  symlink writes, so only the tool-gate path (write/edit/read through the
  link) leaks, and only for symlinks the worker created.

### P3 - read jail cost

`probes/p3-read-jail.mjs`, output `probes/p3-output.txt`.

Part 1 (matcher, same shape as P2 on `path_read` and
`external_directory_read`): identical last-match-wins behavior;
deny-`*`-then-allow-`W/**` is expressible on both read surfaces. Same
symlink-alias bypass.

Part 2 (real `ToolCallGatePipeline` + `GateRunner` + real chain, `read` tool):

| scenario | outcome | chain involvement |
|---|---|---|
| (a) read agentDir/skills/... with `path_read: {"*": "deny"}` | **block, "Denied by policy: 'path_read'"** | 0 - blocked before any ask |
| (b) read W/a.txt, same rules + `W/**` allow + `read` allow | allow | 0 |
| (c) read agentDir/skills/..., no rules, no link | ask escalated, terminal refused (probe terminal) | escalate=1 |
| (d) read agentDir/skills/..., `path_read` deny + `read` allow, no link | **block** (path gate denies first) | 0 |
| (e) read agentDir/skills/..., `external_directory_read: {"*": "deny"}` only | **allow** - infra auto-allow beats a catch-all deny | 0 |

Part 3 (real `computeExtensionPaths` on this host): the infra auto-allow
roots are the agentDir resource entries (`agents`, `extensions`, `git`,
`npm`, `prompts`, `skills`, `themes`, `settings.json`, `SYSTEM.md`,
`APPEND_SYSTEM.md`, `AGENTS.md` - `src/config/extension-paths.ts:33-45`),
the global `node_modules` root
(`/home/ron/.nvm/versions/node/v27.0.0-alpha.0.0.0/lib/node_modules`),
plus `<cwd>/.pi/npm` and `<cwd>/.pi/git`
(`src/path/pi-infrastructure-read.ts:74-81`). A catch-all deny does not
suppress the infra bypass - only a *targeted* deny does
(`src/handlers/gates/external-directory.ts:131-147`, `isTargetedDeny`) -
but that bypass lives on the external_directory gate only; the cross-cutting
path gate (`src/handlers/gates/path.ts:49-56`) has no infra bypass and runs
deny-first (`orderDenyFirst`, `src/handlers/gates/descriptor.ts:164`), so
(a)/(d) hold regardless of `(e)`.

Verdict:
- Expressible: yes. `path_read`/`external_directory_read` accept the same
  catch-all-deny + allowlist; an in-W worker stays fully functional with
  allowlist = `W/**` alone ((b): zero chain involvement, no prompts in W).
- What a real implement worker genuinely needs outside W: the agentDir
  resource entries (skills/extensions/settings are read by the agent's own
  tools in edge cases) and the global node_modules root. The transcript
  dirs (`agentDir/sessions`, `subagent-sessions`) are **not** infra roots
  and an implement worker does not need them.
- Extra consequences (decision 1 trigger): (i) per-session W cannot live in
  global config (decision 5), so the catch-all-deny shape must live in the
  link, and the link's allowlist must include the static infra roots - an
  omission there hard-denies a read with no prompt recovery (P4: a link deny
  is terminal); (ii) a config catch-all deny would additionally block the
  infra auto-allow paths (a, d), so a config-only read jail needs the full
  static allowlist written into the operator's global config; (iii) the
  symlink alias hole is wider for reads (P2 note).

**Recommendation: defer the read jail to a follow-up ticket.** The write
guard is what stops F8; the read jail's allowlist must span link + static
roots, and its failure mode (silent hard-deny of a needed read) is worse
than the write side's (prompt). T1 ships writes; T7 (new) carries the
link-side read allowlist with the Part-3 roots.

### P4 - chain order vs config allow: config allow short-circuits first

`probes/p4-chain-order.mjs`, output `probes/p4-output.txt`. Real gate stack:
`ToolCallGatePipeline` -> `GateRunner` -> `applyPermissionGate` -> a
prompter that composes the real `composeAuthorizerChain(links, terminal)`
per ask, exactly as `AuthorizerSelection.escalate` does
(`src/authority/authorizer-selection.ts:252-266`), with the link wrapped in
the real `encloseInDelegationEnvelope`
(`src/authority/authorizer-selection.ts:284-302`).

| scenario | outcome | escalate | link | terminal |
|---|---|---|---|---|
| S1a config `path_write`/`external_directory_write`/`write` all `*` allow; `write` tool outside W | **allow** | 0 | 0 | 0 |
| S1b same config; `echo x > ../outside.txt` via bash | **allow** | 0 | 0 | 0 |
| S2 no config (default ask); scope link denies outside W | block, link's reason | 1 | 1 | 0 |
| S3 link returns allow on a path-family ask | block - envelope downgraded the allow to defer, terminal decided | 1 | 1 | 1 |
| S4 in-W write, link defers, approving terminal | allow | 1 | 1 | 1 |

Call path: the chain exists only on the ask-escalation seam.
`GateRunner.runDescriptor` resolves the state via the (prompt-free)
`PermissionManager.check` / `buildCheckResult`
(`src/policy/permission-manager.ts:357-407,423-434`) and calls
`applyPermissionGate` (`src/handlers/gates/runner.ts:202`); that function allows
and denies without ever calling `promptForApproval`
(`src/policy/permission-gate.ts:61-102`), and only an `ask` reaches the
escalator (`src/handlers/gates/runner.ts:206`). The
escalator is where the chain is composed
(`src/authority/authorizer-selection.ts:252-266`).

**Verdict: with `path_write: {"*": "allow"}` in config, an outside-W ask
never reaches the link - the config allow short-circuits first.** This
corrects the scope doc's H-c2 claim ("A link deny is non-bypassable by
config allow, because the chain runs before the terminal"): the chain runs
before the terminal only *within the ask path*. Consequences:
- The recommended guard works because it leans on the **default ask**
  (no matching rule -> `ask`, `src/policy/rule.ts:100-114`): the link is
  consulted and its deny is final.
- Any operator config rule that **allows** a covered path
  (`path_write`, `external_directory_write`, bare `path`, or the tool
  surfaces `write`/`edit`) silently disables the link for that path. The
  doctor check (T3) must treat an operator catch-all allow on those
  surfaces as an error for scoped sessions.
- A link allow on path surfaces is downgraded to defer
  (`src/authority/delegation-envelope.ts:53-87`), confirmed live in S3 -
  F2 holds.

### P5 - headless deny, no hang: confirmed

Same script, scenarios S2, S5, S6; the terminal in S5/S6 is the **real
`ParentAuthorizer`** (`src/authority/approval-escalator.ts:182` onward),
built for a UI-less child session.

- S2: subagent, outside-W ask, scope link denies -> block in 1 ms,
  `terminal=0`. The subagent terminal (forwarding machinery) is never
  touched: with the guard, outside-W asks never reach forwarding. The
  refusal text names the link, the surface and the link's reason verbatim
  ("The 'toriel-grants' authorizer denied this 'external_directory_write'
  call for tool 'write' … Reason: scope guard: …").
- S5: subagent, no scope link, no parent session resolvable
  (no `PI_SUBAGENT_PARENT_SESSION` / `PI_AGENT_ROUTER_PARENT_SESSION_ID`,
  no registry; `resolvePermissionForwardingTarget`,
  `src/authority/permission-forwarding.ts:332-373`) -> deny in 0 ms with
  `denialReason` "Could not resolve a parent session to forward this
  permission request to" (`approval-escalator.ts` `abandon()`). Bounded,
  legible.
- S6: parent named but not serving -> deny after ~2005 ms (the 8-tick
  serving grace, `PERMISSION_FORWARDING_SERVING_GRACE_MS`,
  `src/authority/permission-forwarding.ts:13-25`) with "Session 'parent-x'
  is not serving forwarded permission requests".
- If the parent is serving and silent: poll every 250 ms until
  `PERMISSION_FORWARDING_TIMEOUT_MS` (default 10 min,
  `src/authority/permission-forwarding.ts:14`), then abandon with a
  timed-out reason. That is the only slow path, and the scope link removes
  it for outside-W asks.

Note for toriel: children do not currently get
`PI_SUBAGENT_PARENT_SESSION` (`src/child-env.ts:14-27` sets only
`TORIEL_CHILD`/`TORIEL_SOCK`/`TORIEL_SESSION_ID`), so a toriel child today
resolves no forwarding target and its un-granted asks resolve as
S5-style denies. T2 should consider whether scoped children ever need
forwarding (the guard makes it unnecessary for scope asks).

### P6 - fail-closed semantics

Same script, S7. A registered link whose `authorize` throws:
- `composeAuthorizerChain` has no try/catch
  (`src/authority/authorizer-chain.ts:38-52`); the composed authorizer's
  promise rejects, `PermissionPrompter.prompt` does not catch
  (`src/authority/permission-prompter.ts:137-155`), `applyPermissionGate`
  awaits it uncaught (`src/policy/permission-gate.ts:78`), and
  `pipeline.evaluate` **rejects** (S7: `REJECT`, reason "boom: scope link
  crashed").
- The last-mile catch is the tool-call boundary: the SDK awaits the
  registered handler with no try/catch, so `handlers/tool-call-boundary.ts`
  owns `try/catch -> block` and writes a `gate_error` review entry
  (`src/handlers/tool-call-boundary.ts:21-61`). Fail-closed = **block**
  (explicitly not ask, `:34-36`). The model sees a generic error reason,
  not a scope message - so the link must never throw (the shipped
  `pi/extensions/toriel-grants.ts` defers on every error; the comment there
  says exactly this).

`TORIEL_SCOPE_ROOT` contract (the link does not exist yet; this is the spec
T1 must implement, grounded in the above):
- **absent** - no scope configured for this session: the link defers
  everything (today's behavior). The guard is simply off; that is the
  opt-out path, and the doctor (T3) is the only place "scoped session,
  link not registered" is an error.
- **present but not an absolute, existing, canonical directory** - fail
  closed: deny every `path_write`/`external_directory_write` ask with a
  reason naming the env failure ("TORIEL_SCOPE_ROOT … is not an existing
  directory; denying all writes"). Never defer: defer means the subagent
  terminal decides (S5/S6) or the parent prompts, which is fail-soft.
- **present and valid** - deny path-family asks whose canonical
  (`boundaryValue`, `src/handlers/gates/helpers.ts:83-92`) target is
  outside W, naming W; defer otherwise. Use the canonical, never the
  lexical alias (P2/P3 symlink bypass).

## 2. The recommended guard - confirmed, with two revisions

Shipped shape (scope doc section 4), confirmed by P4/P5: the daemon sets
`TORIEL_SCOPE_ROOT=<canonical W>` in the child env for worktree spawns
(default on, `scope:` frontmatter opt-out - T2), and the toriel-grants link
denies `path_write`/`external_directory_write` outside W with a reason,
failing closed on an invalid env (P6 contract). Confirmed pieces:
- F8 stops: S1b shows the leak path (`echo x > ../outside.txt` in a
  permissive config) and S2 shows the same call blocked in 1 ms with a
  legible reason when the guard is active; `write`/`edit` tool calls and the
  bare-`path` fold (`src/policy/permission-resolver.ts:96-118`) are
  covered by the same two-surface deny plus the family fold.
- Headless-safe: outside-W never reaches the forwarding terminal (S2, P5).
- Per-session and uneditable by the worker: env + registered link, no
  config file in the worktree (decision 5 holds).

Revisions:
1. **P4 correction**: the link deny is only reachable on `ask`. A config
   **allow** on the covered surfaces short-circuits it. So T3 (doctor) must
   detect operator catch-all/allowing rules on `path`, `path_write`,
   `external_directory_write`, `write`, `edit` (and on `bash` with command
   patterns that allow writes) for sessions the daemon marks scoped. The
   global baseline "deny `**/.pi/**`" from the scope doc is unnecessary
   under this guard - the worktree-local `.pi` is inside W and allowed; the
   baseline's only job (protect config from the worker) is handled by
   "no config in the worktree" itself.
2. **Canonical matching**: the link must decide on
   `accessIntent.boundaryValue` (canonical), not on the matched pattern -
   the matcher's alias union makes `W/**` allow symlinks that point out
   (P2). For reads (deferred to T7) the same rule applies.

## 3. Unenforced residue, stated plainly

- **Parser misses (P1)**: `dd of=`, variable-expanded redirects,
  command-substitution redirects, `eval` (not fail-closed). T4, one ticket
  each.
- **Program-side effects** (expected, threat-model "mistakes"):
  interpreters (`python -c`, `node -e`), `make`/`npm run`, scripts written
  then run, `find -exec`/`xargs` with generated paths. Phase 5 (bwrap /
  landlock) is what covers these.
- **Git semantics**: the parser models only operand paths, not what `git`
  does. In-cwd `git checkout`/`commit`/`apply` are invisible; worktree
  commits write the shared object store and `.git/worktrees/<name>` outside
  W. Decision 4 (MCP verbs only, no shell git in agent profiles) is the
  mitigation, and the agent audit below shows it is already true for every
  shipped profile.
- **Symlink alias hole**: config matching cannot close it (P2); the link's
  canonical check closes the scope-relevant part. Adversarial use (a
  determined worker planting symlinks, then exploiting a parser miss) is
  out of the phase-1 threat model.
- **Guard depends on the link loading**: `permissions:ready` registration
  is single-shot (`pi/extensions/toriel-grants.ts`); a missing/older
  extension means the guard is off. T3.
- **Reads**: not jailed in phase 1 (P3 verdict).

## 4. Agent-tool audit (decision 4: git via MCP verbs only)

Safe verb subset: `git_status`, `git_diff`, `git_log`, `git_show`,
`git_blame`, `git_grep` (toriel-git-mcp; the profiles use
`mcp__git__git_read*`, which resolves to exactly this read facade -
`test/agents-shipped.test.ts:67` additionally asserts no profile ever
names `git_write`/`git_net`).

| profile | git access today | should have | verdict |
|---|---|---|---|
| `code-review` | `mcp__git__git_read*`, no bash | the six read verbs | OK - keep as is |
| `git-archaeology` | `mcp__git__git_read*`, no bash | the six read verbs | OK - keep as is |
| `advisory-diff` | `mcp__git__git_read*`, no bash | the six read verbs | OK - keep as is |
| `implement` | no git tools; has `bash` | no git tools; **shell git stays out of its prompt** (it never needs to commit - the manager commits) | OK today; T2 must keep git out of worktree-scoped implement prompts, because a scoped `git commit` would write outside W and the guard would deny it mid-task |
| `test-runner` | no git tools; has `bash` | none (prompt: "run a test or build command") | OK; note for T2: if a project check ever needs `git`, that check's own shell git hits the guard - document in the doctor (T3) |
| all others (explore, summarize, plan, triage, design, docs-writer, edit-writing, vuln-hunt, re-*, binary-diff, crash-analysis, debug, research-web) | none | none | OK - read-only or gdb/ghidra/web tools; nothing touches git |

No profile needs a `git_write`/`git_net` verb; the existing test
(`test/agents-shipped.test.ts:67`) enforces that. T5 (audit ticket) reduces
to a no-op confirmation plus the `implement`/`test-runner` prompt notes
above.

## 5. Candidate follow-up tickets (file after Ron confirms)

- **T1 scope deny (link)**: `TORIEL_SCOPE_ROOT` in child env for worktree
  spawns; toriel-grants denies `path_write` +
  `external_directory_write` whose `boundaryValue` is outside W, with a
  reason naming W; fail closed on invalid/missing-but-required env (P6
  contract); tests for `..`, symlink, sibling-prefix `W-evil`, in-cwd
  git-metadata (documented as MCP-only), and a throwing link. Evidence:
  S2/S5/S6/S7.
- **T2 profile `scope` field + default-on**: frontmatter
  `scope: none` opt-out; daemon resolves W canonically from the spawn's
  worktree and sets `TORIEL_SCOPE_ROOT` (`src/child-env.ts:14-27`); keep
  shell git out of scoped implement prompts (audit §4); decide whether
  scoped children ever need `PI_SUBAGENT_PARENT_SESSION` (P5 note).
- **T3 doctor**: scoped session without a registered link = error
  (`permissions:ready` never fired / extension missing); `authorizerChain`
  includes `toriel-grants`; operator config has no allowing rule on
  `path`/`path_write`/`external_directory_write`/`write`/`edit` that a
  scoped session would inherit (P4 revision 1).
- **T4 bash-parser gaps** (upstream or toriel-side
  `commandEffects`/command-effects-config): one ticket each - `dd of=`,
  `d=..; echo x > $d/f`, `echo x > "$(pwd)/../f"`, `eval "echo x > ../f"`
  (P1).
- **T5 agent git-via-MCP audit**: confirmed as a no-op plus the
  `implement`/`test-runner` prompt notes (audit §4); fold into T2 if
  trivial.
- **T6 phase-5 sandbox spike**: bwrap vs landlock, worktree `.git` bind
  (object store + `.git/worktrees`), pi inside or outside; blocked on T1.
- **T7 read jail (deferred per P3)**: link-side `path_read`/
  `external_directory_read` deny with allowlist = W + the P3 Part-3 static
  roots (agentDir resource entries, global node_modules root,
  `<cwd>/.pi/npm|git`); decide the transcript dirs; canonical matching.

## 6. Blocked / not done

- F6 project-scope config (`<cwd>/.pi/extensions/pi-permission-system/config.json`,
  `src/config/config-paths.ts:18-20`) was documented as the fallback
  citation only, per the executable spec's P-list (P1-P6 replaced the
  scope doc's H-a3/H-a4 probes). It remains un-probed live; decision 5
  excludes it from the shipped guard regardless.
- No live end-to-end probe through a real spawned pi child (scratch
  agentDir + `--print`) was run: the P4/P5/P6 harness drives the real gate
  stack and the real `ParentAuthorizer` in-process, which covers the same
  code paths the child would run; a child-process probe is a P5 hardening
  step, not required for the verdicts above.
- H-a5 (the `/tmp/toriel-res-*` resource copy as an injection point) is not
  in the executable spec's P-list and was not probed; out of scope for the
  shipped guard (link + env).
