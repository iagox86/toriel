# SPEC: batch 18 - tickets 245 + 246

Branch: t245-246, worktree ~/projects/toriel-worktrees/batch-18, based on main 4d6b8e4.
Worker: all writes in this worktree only. Reads from /home/ron/projects/toriel are fine; writes or commands outside the worktree are not. Do not run git (the manager commits). Report format is at the end.

## Ticket 246: let sessions edit the Hermes memory store (~/.pi/agent)

### Verified facts
- `src/daemon-permissions.ts:65` `protectedPaths()` = `[PERMISSIONS_FILE, piAgentDir(), mcpYamlFile()]`.
- `touchesProtected()` (same file, ~line 98) builds needles from each protected path: whitespace-squashed absolute, `~`-form, and tail-2-segments. For `piAgentDir()` (`~/.pi/agent`) the tail-2 needle is `.pi/agent`, which substring-matches EVERY path under `~/.pi/agent`, including the agent-maintained memory store.
- Consequence: grants never cover `~/.pi/agent/pi-hermes-memory/skills/**` or `~/.pi/agent/projects-memory/**` (answerablePrompt returns undefined), auto mode's floor stands aside with "it names the permission grants file or pi's own configuration" (`src/auto-mode.ts:223`), and `checkPromptFor` (daemon-permissions.ts:115) refuses a grant for them. Sessions legitimately write there constantly (Hermes skills + project memory via the skill/memory extensions).
- Hermes layout (verified): global skills `~/.pi/agent/pi-hermes-memory/skills/<slug>/SKILL.md` (pi-hermes-memory skill-store.ts:166); project-scoped skills and memory `~/.pi/agent/projects-memory/<project>/...`. Also under pi-hermes-memory: MEMORY.md, USER.md, sessions.db, a standing-instructions file, a migration sentinel - NOT hand-edited content, keep those protected.
- Every consumer of touchesProtected: `answerablePrompt` (daemon-permissions.ts:80, capped file-path surfaces only), `checkPromptFor` (:115, same), the `protectedAsk` UI hint path (`src/daemon-children.ts:704` region), `floorReason` (`src/auto-mode.ts:222`, sees every ask incl. bash), and a display-text line in `src/dialogs.ts:261` (no functional change needed).

### Design (decided - Sonnet consulted, 2026-11-19)
Whole-tree protection STAYS (fails closed). Add an explicit carve-out for the two agent-maintained content subtrees only:

- New `exemptPaths(): readonly string[]` next to `protectedPaths()` in daemon-permissions.ts, derived from `piAgentDir()` (so `PI_CODING_AGENT_DIR` moves it): `<agentDir>/pi-hermes-memory/skills` and `<agentDir>/projects-memory`. Deliberately narrow: sessions.db, MEMORY.md, USER.md, the standing-instructions file, user `skills/`, `extensions/`, `bin/`, everything else stays protected.
- `touchesProtected(text, protectedFiles = protectedPaths(), exempt: readonly string[] = [])` - the exemption is OPT-IN per caller.
- Matching rule: instead of a single `includes`, loop `indexOf` over every occurrence of every needle in each haystack (raw squashed and collapsed). For each occurrence, take `rest = haystack.slice(index + needle.length)`; the occurrence is EXEMPT only if `rest` begins with `/<sub>` for one of the exempt sub-path spellings (squashed absolute form and tail forms derived from exemptPaths, e.g. `/pi-hermes-memory/skills` and `/projects-memory`) followed by `/` or end-of-text. Return true if ANY occurrence in ANY haystack is not exempt.
  - Traversal fails closed: `.../pi-hermes-memory/skills/x/../../../settings.json` looks exempt in the raw haystack but its collapsed form `.pi/agent/settings.json` is not - each haystack is judged independently, never short-circuit on the raw one.
  - `.../skills/..` collapses to `.../pi-hermes-memory` whose suffix is not an exempt sub-path -> protected.
  - Boundary: `pi-hermes-memory/skills-evil/...` and `projects-memory2` must NOT match (the `/`-or-end check).
  - A mixed text naming two paths (`cp <exempt> <settings.json>`) protects because each occurrence is judged by its own suffix.
- Callers passing `exempt`: `answerablePrompt`, `checkPromptFor` (both capped file-path surfaces), the `protectedAsk` dialog hint (only when the dialog's surfaces are non-bash; when no surface info is available, stay strict - if it disagrees with the grant gates the dialog offers rows that get refused, the bug it exists to prevent). `floorReason` in auto-mode passes `exempt` ONLY when the ask is not a bash/command surface (check how it reads surfaces/command there); bash keeps the strict check because a command like `cd ~/.pi/agent/projects-memory/p && cat ../../settings.json` has a `..` run the collapse cannot resolve across squashed `&&` tokens. `CREDENTIAL_FILES` and every other floor arm are unchanged.
- Update doc comments: the `protectedPaths` docblock, `floorReason`'s ("pi's configuration" wording), `docs/permissions.md`, and the `docs/reference.md` layout entry if daemon-permissions is listed.

### Tests (extend test/permissions.test.ts; the file has touchesProtected coverage around lines 337-392)
Pin, for BOTH strict (no exempt arg) and exempt behavior:
- Exempt: absolute, `~`-form and repo-relative spellings of `.../pi-hermes-memory/skills/x/SKILL.md` and `.../projects-memory/p/skills/y/SKILL.md`.
- Still protected: `settings.json`, `auth.json`, `extensions/`, user `skills/`, `pi-hermes-memory/sessions.db`, `pi-hermes-memory/MEMORY.md`.
- Traversal both directions: `skills/x/../../../settings.json`, `skills/..`, `projects-memory/../auth.json`.
- Boundary: `skills-evil`, `projects-memory2`.
- Mixed two-path text in both orders; whitespace-wrapped exempt path.
- `PI_CODING_AGENT_DIR` override moves the exempt set with it.
- `answerablePrompt` returns covering grants for a hermes skill path (grant exists) and undefined for `settings.json`.
- `checkPromptFor` accepts a grant for a hermes path, refuses one for `settings.json`.
- `floorReason`: a `path_write` ask on a skill file no longer hits the protected-config arm (falls through to later arms); a bash ask naming it still does.
- daemon integration (test/daemon-permissions.test.ts or wherever protectedAsk is covered, ~lines 239-264): no protectedAsk for the carved path on a non-bash dialog.

## Ticket 245: ask_user_question double numbering

### Verified facts
- Bundled `@juicesharp/rpiv-ask-user-question` 2.15.0 numbers option rows itself in the dialog renderer (node_modules/@juicesharp/rpiv-ask-user-question view/components/wrapping-select.ts, multi-select-view.ts) - numbering belongs to the UI, not the labels.
- Its `DEFAULT_PROMPT_GUIDELINES` (ask-user-question.ts:446-451) never tell the model not to number labels, so a model that emits "1. Solarized" labels double-numbers. That is the bug Ron saw on another machine.
- pi extension hooks (node_modules docs/extensions.md): `before_agent_start` exposes `event.systemPromptOptions` with a mutable `promptGuidelines` collection - the PREFERRED way to add a line (structured, Pi diffs sections and patches only the change; extensions.md:657). `tool_call` handlers may mutate `event.input` in place (extensions.md:419).
- Toriel extensions live in `pi/extensions/*.ts`, each passed to children as `-e` flags by `src/resources.ts` (children only, guard with `if (!process.env.TORIEL_CHILD) return;`). Look at `pi/extensions/toriel-files.ts` for the register/handler idioms and `src/resources.ts` + `test/resources.test.ts` for how the extension list is asserted - a NEW file changes those lists (test/resources.test.ts, test/daemon-lifecycle-3.test.ts style).

### Design (decided)
New `pi/extensions/toriel-qa.ts` (children only):
1. `before_agent_start`: append ONE guideline to `event.systemPromptOptions.promptGuidelines` (mutate the collection, do not replace the prompt): "When using ask_user_question, never include numbering (\"1. \", \"1)\", bullets) in option labels - the dialog numbers the rows itself; numbering in labels shows doubled."
2. `tool_call` handler on `ask_user_question` (defence in depth, fixes the symptom whatever the model does): mutate `event.input` in place, stripping a leading `^\s*(\d+[.)]|[-*+])\s+` from every `questions[].options[].label` (check the real input shape in the package's tool/types.ts before coding). Only strip when there is whitespace after the marker, so a label like "1.5 release" (no space) survives. Never throw - wrap in try/catch like the other extensions.

No config-file writing (Sonnet: it would freeze our copy of upstream defaults and hide upstream improvements). No doctor entry (the extension needs no user setup). The typing-affordance half of the ticket (no on-screen hint for the "Type something." row) is upstream UI code - out of scope here; the manager files it upstream.

### Tests
- test/qa-extension.test.ts (fake pi harness like test/grants-extension.test.ts): the guideline line is appended to promptGuidelines without disturbing existing entries; option labels with "1. ", "1)", "- " prefixes are stripped; "1.5 release" and "10) x" behaviors; labels without numbering untouched; a throwing handler never breaks the call; nothing happens without TORIEL_CHILD.
- Update the extension-list assertions (grep test/resources.test.ts and test/daemon-lifecycle-3.test.ts for how existing files are listed).

## Docs
- docs/permissions.md: the carve-out (what is now editable and why it fails closed).
- docs/reference.md: the new extension in the layout list + code layout entry, and the permissions change if it lives there.

## Out of scope
- The upstream "Type something." hint (manager files upstream).
- MEMORY.md/USER.md/sessions.db carve-outs; memoryDir override support.
- pi-permission-system changes; 237/236/240/241.

## Report format
End your final message with: files changed (+lines/-lines), what you changed per file, test names added, gates output (typecheck + lint + npm test pass/fail counts), anything you could not verify, and any deviation from this spec with the reason.
