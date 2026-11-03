# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

AGENTS.md (imported above) holds the commands, layout, conventions and job-board workflow. Read it first; the notes below add what it leaves out.

## Running a single test

Node v26 is required and is not the default (`~/.nvm/versions/node/v26.12.0/bin`). In fish:

```fish
set -x PATH ~/.nvm/versions/node/v26.12.0/bin $PATH
node --test test/commands.test.ts
node --test --test-name-pattern="some behavior" test/daemon.test.ts
```

Run `npm test`, `npm run typecheck` and `npm run lint` before calling work done (typecheck matters: node strips types and never checks them).

## Architecture in brief

Two processes joined by a typed JSONL protocol over a unix socket:

- Daemon (`src/daemon.ts`, `daemon-*.ts`): owns the `pi --mode rpc` child processes (one per live session, via `RpcClient`), fans events out to attached controllers, routes permission dialogs to the driving controller, and persists group/state under `~/.local/share/toriel/`. Handlers receive a `DaemonContext`; there is no module-level mutable state. A crash of the daemon kills its children.
- Controller (`src/controller.ts`, started by `toriel.ts`): a pi-tui app that renders everything. Children render nothing. Controllers are stateless views; a crash loses nothing.
- Inactive sessions have no process, only a session file. Transcripts must go through one renderer for both live event streams and file replays, or the two views drift.
- Protocol types live in `src/shared.ts`; `daemon-dispatch.ts` switches exhaustively over `ClientCommand`. Bump `PROTOCOL` when a message shape changes. Framing is LF-only JSONL (never readline: it also splits on U+2028/U+2029).
- Spawn requests carry an explicit cwd; never rely on the daemon's inherited cwd.
- `pi/extensions` and `pi/skills` run inside the pi children and are injected as `-e` / `--skill` flags (`src/resources.ts`); toriel never writes into `~/.pi/agent`, which is the user's own pi config.

`docs/design.md` is the long-form record (architecture, protocol gotchas, validated pi findings, parked work); read the relevant section before changing protocol or lifecycle behavior. `docs/reference.md` has keys, env vars, code layout and the doctor catalog.

## Working here

- Use `toriel --isolated` to try a branch by hand without touching the real daemon. Never kill other live pi sessions.
- Do not run git commands that mutate the repo; Ron commits and pushes.
- Tickets live on the Vikunja board, not repo issues; leave finished tasks open with the `needs verification` label.
