# Ticket 189: layer on pi-permission-system, or own the permission gate?

Investigation only; no code. Written 2026-11-15, against `@gotgenes/pi-permission-system` 42.0.0 (about 31.8k lines of source, tests excluded) and pi's `tool_call` hook (`docs/extensions.md`: handlers run in order, later ones see earlier mutations, the only return value is `{ block: true, reason? }`).

## Recommendation (short)

**Keep the package for the policy it is good at; do not build an owned gate. Add one small toriel-owned `tool_call` veto for the boundary checks only.** Concretely:

1. Move the scope guard (218), the write-target checks and the protected-file check out of the "authorizer link, sees only asks" position and into a toriel `tool_call` handler that can only block. It then sees every call, including ones a rule allows outright, and it no longer depends on the chain's allow-to-defer cap or on package config layering.
2. Retire the local patch (`pi/patches/scope-config-patch.md`) once step 1 covers scoped sessions: with a veto that always runs, a project config that re-allows `external_directory_write` can no longer open the boundary, so withholding the project layer is not needed for safety.
3. Treat the OS sandbox as the boundary (it already is for bash when `sandbox: bwrap`), and keep the package's matching as the day-to-day ask/allow/deny UX. Policy that is advice (auto mode's floor, deny-after) stays where it is, in the daemon.

Not recommended: a full owned gate. It rebuilds about 25k lines of matching, parsing and presentation to remove four irritations, none of which is a defect in the matching itself.

## 1. Inventory

### What we get from the package (and would have to rebuild)

| Area | Package size (non-test lines) | Rebuild cost |
|---|---|---|
| Bash parsing and effect extraction (`access-intent/`, with `bash/`) | 9.6k | High. Quoting, subshells, heredocs, pipelines, "parser could not resolve, so ask". Our own `shellCommands` / `writeTargets` are a few hundred lines because they are advisory. A gate needs the full thing. |
| Rule matching, normalisation, `PermissionManager` (`policy/`) | 1.8k | Moderate. Wildcards, specificity, surfaces. |
| Config layering global, project, per-agent (`config/`) | 2.9k | Moderate. Toriel would replace a JSON format users already hold. |
| Path canonicalisation and containment (`path/`) | 1.0k | Low. We already have `file-scope.ts` and `scope-root.ts`. |
| Authority: dialog queue, forwarding of subagent prompts, escalation (`authority/`) | 6.6k | High, and much of it duplicates the daemon, which already owns dialogs, grants and the subagent seam. |
| Presentation: dialog UI, review log (`presentation/`, `logging/`) | 3.3k | Low to moderate. Toriel already draws its own dialogs (`docs/permission-dialogs.md`). |
| MCP, tool, skill surfaces and tool hiding (`exposure/`, `handlers/`) | 3.9k | Moderate. Hiding disallowed tools before the agent starts is a real feature. |

### What we fight today

- **The cap.** A link's `allow` on `path` / `external_directory` families is downgraded to `defer` (`delegation-envelope.ts`). Toriel works around it by answering file-path dialogs from the daemon (ticket 194), which is allowed to go around the cap only because it writes pi's plain "Yes".
- **Project-config precedence.** The project layer outranks global and lives inside the scope root the agent can write. Fixed by a local patch, re-applied after package updates (the `permission-package-scope-patch` doctor finding).
- **Grants invisible to us.** pi's "for this session" rules cannot be listed or edited; toriel hides that option unless it has no grant to offer.
- **Title scraping.** `withSuggestion` and `touchesProtected` read dialog titles, whitespace-squashed. Brittle, and the package may reword them.
- **Asks only.** The chain runs only when a rule says `ask`. An `allow` rule skips the scope guard entirely (doctor catalogue entry `scope-guard-short-circuit` exists to catch the config forms of this, but cannot catch a user later adding an allow).

## 2. Owned gate via `tool_call`

A toriel-owned gate would be a `tool_call` handler holding rules in toriel's own state, with grants and dialogs already in the daemon and the scope guard native. Looks attractive, but:

- `tool_call` only blocks; it cannot hide tools, prompt, or rewrite. Asking means calling the daemon for a dialog from inside the handler, so toriel would reimplement the package's ask path (queueing, subagent forwarding, answer windows).
- The package's gate would still be installed (or removed, and then `/permissions`, tool hiding and bash effect parsing all go with it). Two gates is worse than one: two answers to explain.
- File-handling proposal phase 2 (owned read/write/edit with a realpath jail) is compatible with either path and is justified by the efficiency findings, not by this decision. It makes the file tools a hard wall; it does not remove the need to gate bash.
- "Deny bash globally and force side effects through ask-rules or MCP" is the cleanest endgame for a hostile model, but unusable for a coding agent whose job is `npm test`. The sandbox gives the same guarantee without taking bash away.

## 3. Hybrid: what I recommend

Keep, unchanged: rule matching, config layering for ordinary sessions, bash parsing, MCP/tool/skill surfaces, tool hiding, the prompter, subagent forwarding.

Own, as a veto that never prompts:

- scope-root deny for covered writes (today `scopeVerdict` in `toriel-grants.ts`), the interpreter-payload check (218), and the protected-file check;
- registered as its own pi extension with a `tool_call` handler, so it runs for allowed calls too and does not rely on the chain.

What this buys: the "only sees asks" gap closes; the `scope-guard-short-circuit` doctor entry and the config-layering patch become unnecessary for safety (keep the entry as advice for a while); `scopeVerdict` shares one code path with the sandbox policy builder instead of two.

Risks to verify before building: the order of our handler relative to the package's (we only need ours to run, not to run first, since a block from either wins); pi's parallel preflight (siblings are preflighted sequentially, so a veto is not raced); that the handler receives bash `command` and path-bearing tool inputs in the same shapes the link sees; and fail-closed behaviour if the extension fails to load (the daemon already refuses to start a scoped child without its extensions, ticket 163).

## 4. How the OS sandbox changes the answer

With `sandbox: bwrap` the kernel enforces writes for bash commands, so the lexical parts (payload check, write-target floor) are defence in depth and UX (a clear reason beats `EROFS`). What the sandbox does not cover is pi's own `write`/`edit`/MCP file tools, which run in the pi process: those still need the realpath jail, which is the veto above or phase 2's owned tools. So the permission layer shrinks to three jobs: ordinary ask/allow/deny UX, a jail for the file tools, and refusing in advance what the sandbox would refuse anyway. The read jail (167) is a sandbox feature (bind only what may be read), not a permission-layer one.

## 5. Cost, risk, migration

| Option | Cost | Risk | Doctor catalogue |
|---|---|---|---|
| A. Status quo (layer, bend) | none | each package update may break the patch, the cap or title heuristics; allow-rule bypass of the guard stays | unchanged |
| B. Hybrid veto (recommended) | about 1 batch: new extension, move `scopeVerdict`/`payloadEscape`, tests, doc | low; a veto can only add denials, and the package is untouched | drops `permission-package-scope-patch`, shrinks `scope-guard-short-circuit` to advice; adds one entry (veto extension loaded) |
| C. Own the whole gate | many batches; rebuild parsing, matching, config, dialogs | high; a new bash parser is a security-critical component to write and keep right; regression in the day-to-day UX | drops `permission-package`, `grants-chain`, `grants-path-rule`, `permission-package-scope-patch`, `scope-guard-short-circuit`; adds an equal number of toriel-specific ones |

Migration for B: add the extension with `tool_call` next to the link and make it deny in the same cases; run both for a release (the link remains as a second opinion); then delete the patch and its doctor entry. Standing rule respected: nothing here needs an upstream post from Ron's account.

## Follow-up tickets (concrete work only)

1. Build the toriel `tool_call` veto (scope guard, payload check, protected files), with the verification list above as acceptance.
2. After it ships and one package update has passed without trouble: retire the scope patch and its doctor entry.

Not filed: a full owned gate (rejected above) and a new parser (not needed).
