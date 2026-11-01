# AGENTS.md

toriel is a daemon plus a terminal controller that host several pi (coding
agent) sessions at once. The daemon (`src/daemon.ts`) owns the pi child
processes; the controller (`src/controller.ts`, started via `toriel.ts`) is a
pi-tui app that talks to it over a unix socket. User docs: `README.md`.
Everything else (keys, env, code layout, design, backlog): `docs/`.

## Job board

Work is tracked on the Vikunja board (projects "Toriel - base" and
"Toriel - Subagents"), not in this repo's issues. When assigned a ticket: work it
per this file, then leave the task open with the `needs verification` label and
a `Done (agent, <date>)` comment with validation steps - only Ron marks tasks
done. Full workflow: the `toriel-job-board-workflow` skill; API details: the
`vikunja-mcp` skill.

## Commands

Use node v26 (`~/.nvm/versions/node/v26.12.0/bin`); the default node is too old. (`bin/toriel`, the launcher, finds it on its own; these commands do not.)

- `npm test` - all tests, no network or model
- `npm run typecheck` - tsc (node strips types at runtime and never checks them)
- `npm run lint` - biome, lint only (the formatter is disabled; formatting is not enforced)
- `toriel doctor` - the setup report (`/doctor` inside toriel); run it after changing anything a user has to set up

Run all three before calling work done. Restarting the real daemon is fine,
but never kill other live pi sessions.

## Layout

- `toriel.ts` - entry point: statically imports only `src/preflight.ts` (startup checks that must run before a missing dependency can fail the module link), then imports the controller dynamically. `bin/toriel` - sh launcher that picks the node in `.nvmrc`.
- `src/` TypeScript source, run directly by node (no build step). `daemon-*.ts` is the daemon side; `controller.ts`, `switcher*.ts`, `session-*.ts`, `transcript.ts` the UI. `docs/reference.md` "Code layout" lists every file.
- `test/` node:test files, one per module; `test/daemon.test.ts` and the other integration tests run a real daemon against `test/fixtures/fake-pi.mjs` via the harness in `test/helpers.ts`, which isolates everything in a temp dir (`TORIEL_SOCK`, `TORIEL_LOG`, `TORIEL_TRASH`), so tests never touch real sessions.
- `agents/` - shipped agent profiles (markdown + frontmatter); format in `agents/README.md`.
- `pi/extensions`, `pi/skills` - run inside pi, not inside toriel. The daemon passes them to every child as `-e` / `--skill` flags (`src/resources.ts`); nothing is installed into `~/.pi/agent`, which is the user's own pi config (`src/pi-dir.ts`). `pi/themes` is read by toriel itself. `toriel-presence.ts` is the one extension toriel does not load: plain pi opts in through its `settings.json`.
- `docs/design.md` - architecture, validated pi findings, parked work. Read the relevant part before changing protocol or lifecycle behavior.

## Conventions

- Node type stripping: no enums, namespaces or constructor parameter properties; use `import type` for types; import with the `.ts` extension.
- 2-space indent, no tabs (see `.editorconfig`). Block statements always (`if (x) { ... }`, never one-line).
- Pure logic goes in small modules with a unit test beside it in `test/`; classes take their collaborators explicitly. No module-level mutable state in the daemon (handlers get a `DaemonContext`).
- A /command is declared once in `src/commands.ts` (name, description, commander `build`, optional `complete`); parsing, `--help` and autocomplete derive from it, and a handler table keyed by name must cover it (tsc enforces that). Give commands likely options, tab completion and help: every option and argument needs a description, and every command a `help:` text (what it does, examples), which `--help` prints after the options; `test/commands.test.ts` fails when one is missing.
- The daemon<->controller protocol is typed in `src/shared.ts` (JSONL over a unix socket, LF-only framing - never readline). `daemon-dispatch.ts` switches exhaustively over `ClientCommand`, so a new message type is a compile error until both ends handle it. Read `docs/design.md` "Protocol gotchas" before changing protocol or lifecycle behavior.
- A session command that needs a running pi child (anything that calls the daemon about the session: model, compact, clear, mcp list, `!command`) must start a sleeping session first with `await this.liveMeta()` in `session-commands.ts` (it returns undefined after telling the user why it could not), never fail with "send a message first". Commands that only read the file, edit toriel's own state, or send a prompt (the prompt path wakes the session itself) do not wake it. State which kind a new command is in its handler's doc comment.
- One daemon per state directory: it holds `daemon.pid` (`src/daemon-lock.ts`) and a second refuses to start. Tests isolate with `XDG_DATA_HOME` (the harness does), so a test daemon never meets the real one.
- Shared helpers live in `src/util.ts` (`errText`, atomic writes, `readJsonOr`, `rotateLog`); use them instead of copying `err instanceof Error ? ...` or the tmp-file-and-rename dance.
- Prefer explicit error handling; report failures to the user (notice/panel) rather than swallowing them.
- Never print or commit secrets: `~/.pi/agent/models.json` and `auth.json` hold API keys.
- Setup requirements live in the doctor. Anything a user must install, configure or set for a feature to work (a package, a line in pi's or toriel's config, an env var, a binary on PATH) needs: an entry in `CATALOG` in `src/doctor.ts` with a level (required / recommended / feature / hardening), a finding for it (from `collectFindings` there or `auditFindings` in `src/resources.ts`, with a `fix` only when a safe automatic edit exists), a test, and a line in `docs/reference.md` "Doctor". Change or remove the check when the requirement changes or goes away; `test/doctor.test.ts` fails on a finding the catalog lacks and on a catalog entry nothing reports. Do not add a requirement that the doctor cannot see.
- Update `README.md` (user-facing) and `docs/reference.md` (details) when behavior changes; park follow-ups in `docs/design.md`.
