# toriel

A daemon-backed controller that hosts multiple live pi sessions in one
terminal. Pick a session from a grouped switcher, keep agents running in the
background, switch between them without aborting anything, and never lose work
to a crashed UI. Think "tmux for pi sessions": the daemon owns the pi
processes, controllers (the terminal UI) come and go.

pi runs one agent per process, and switching sessions inside one pi aborts
the run in flight. toriel keeps each session's pi process in a daemon, so
closing or crashing the UI never touches a running agent.

## Install

Requirements:

- Node v26.12.0 or newer (the code is TypeScript run directly by node; the
  `.nvmrc` pins it). With nvm: `nvm install 26.12.0`. The `toriel` launcher
  (below) finds it even when your default node is older; `npm test` and the
  other commands need it on your PATH.
- pi installed globally under that node (`npm install -g @earendil-works/pi-coding-agent`)
  and logged in to at least one provider
- A truecolor terminal; one with the kitty keyboard protocol (kitty, ghostty, wezterm, ...) gives the best key handling
- Optional, for clipboard and image paste: `wl-clipboard` (Wayland) or `xclip` (X11).
  toriel checks at startup and says so in the switcher if they are missing.

```fish
git clone <this repo> ~/projects/toriel
cd ~/projects/toriel
npm install
```

There is no install step for pi: the daemon loads toriel's extensions and skill
into every session it starts, by path from this checkout (`-e` / `--skill`
flags), so moving or updating the repo needs nothing else. toriel never writes
into `~/.pi/agent`; your pi settings, models, MCP servers and packages there
are used as they are. [pi-permission-system](https://www.npmjs.com/package/@gotgenes/pi-permission-system)
is a good package to have in pi's `packages`: it asks before the tools your
rules mark `ask`, and toriel shows those prompts. toriel does not install or
manage it; it only warns in the notice line when it is missing (turn that off
with `warnNoPermissionSystem: false`).

At startup toriel checks its setup and says what is wrong instead of failing
later: node too old, `npm install` not run, no `XDG_RUNTIME_DIR`, pi never set
up or a `settings.json` pi cannot read, files missing from the checkout, old
toriel links in `~/.pi/agent`.

Agent profiles (`/agents`, `/new --agent explore`) are described in [agents/README.md](agents/README.md).

## Run

```fish
ln -s ~/projects/toriel/bin/toriel ~/.local/bin/toriel   # once, so `toriel` works from anywhere
toriel              # starts the daemon if needed, opens the switcher
toriel kill-server  # stop the daemon and every session it owns
```

`bin/toriel` finds the node version in `.nvmrc` even when your default node is
older (it looks in `~/.nvm`), and starts new sessions in the directory you ran
it from. Without the link, `node toriel.ts` in the checkout does the same.

Quitting toriel (`/exit`) leaves the daemon and all running sessions alone;
starting it again reattaches to everything.

## Using it

The switcher lists every pi session, live or not, in groups. Start typing to
begin a new session, or use the keys below.

| Key | Where | Does |
| --- | --- | --- |
| up / down, enter or right | switcher | select, open |
| shift+up / shift+down | switcher | move a session or group (crossing a header changes group) |
| ctrl-n | switcher | new session |
| ctrl-k | switcher | stop the session's process (file kept) |
| ctrl-x (twice) | switcher | delete (to trash, recoverable with `/restore`) |
| ctrl-r or f2 | switcher | rename |
| ctrl-g, ctrl-f | switcher | group, filter |
| left / right / enter on a group | switcher | fold or unfold |
| left / right on a parent session | switcher | fold / unfold its subagents (left on a subagent jumps up to the parent) |
| left on an empty editor | session | back to the switcher |
| esc | session | abort the running agent |
| esc esc | session | rewind to an earlier message |
| ctrl-o, ctrl-t | session | expand tool output, show thinking |
| ctrl-r | session | search prompt history |
| ctrl-v, middle click | both | paste clipboard (text or image), paste selection |

Type `/` for commands; tab completes them and their arguments, `/help` lists them, and
`/<command> --help` explains one (what it does, every option, examples). Commands toriel handles itself:

- Switcher: `/new [-a agent]`, `/init`, `/agents`, `/detach`, `/stop`, `/delete`, `/rename`, `/group`, `/ungroup`, `/park`,
  `/filter`, `/comment`, `/summarize`, `/restore`, `/adopt`, `/feedback`, `/kill-daemon`, `/help`, `/exit`
- In a session: `/help`, `/in`, `/at`, `/every`, `/loop`, `/cron` (timed prompts; `/schedules` lists them), `/btw`, `/comment`, `/model`, `/think`, `/compact`, `/clear`, `/fork`, `/park`, `/rename`, `/reload`,
  `/mcp` (`list`, `status`, `explore`, `add`, `remove`, `reconnect`, `login`, `logout`), `/init`, `/why`, `/abort`,
  `/feedback`, `/parent` (jump to the agent that started this subagent), `/detach` (cut that link), `/quit` (back to the switcher), `/exit`

`/comment <text>` keeps a longer note to yourself about a session (why it exists, where it stands). It is not drawn in the list, but `/filter` and `ctrl-f` search it. With no text the switcher puts the current comment in the box to edit; `-c` removes it.

`/btw <question>` asks a copy of the session (it has read the whole conversation, but has no tools) a side question in the background while you keep working. The answer opens in a panel: `c` copies it, `s` saves it to `~/.local/share/toriel/btw/`, any other key closes. The session never sees the question or the answer.

Clicking the transcript only toggles a thinking block or tool output on a double click (a single click is just for focusing or dropping a text selection); `TORIEL_CLICK=single` brings back one-click toggling.

Anything else starting with `/` goes to pi (its skills and prompt templates).

`!command` in a session (the chat box border turns yellow while you type it) runs a shell command in the session's directory and shows the output. The agent gets the command and output immediately, as a message wrapped in `<local-command>` tags with a note that you ran it yourself, so it reacts right away (or queues it behind its current turn). `esc` stops a running command; a command is stopped after 10 minutes; very long output is cut to its start and end. It needs a running session. `!!` is not supported.

Sessions can message each other: ask an agent to "tell the session called Mealie that the schema changed" and it uses the `toriel_message` tool (loaded into every session by toriel, along with a short `messaging` skill). The text arrives in the other session labelled `[from <name> (<id>)]` and shown as "from <name>" in the transcript; an idle session is started to read it. Delivered messages ride toriel's session bridge when the receiving session has it (see `docs/reference.md`), so they cannot strand in pi's steering queue; otherwise they fall back to plain steering. Agents are told to do this only when you ask. If the daemon goes away the controller keeps its screen and your typed text, reconnects on its own and redraws every session from the daemon; the notice line warns if toriel's own files are missing from the checkout or old toriel links are left in `~/.pi/agent`. `/name` with no argument shows the session's name and id.

Sessions opened in plain pi appear in the list too. To have them marked as live
in pi, add `/path/to/toriel/pi/extensions/toriel-presence.ts` to the `extensions`
list in pi's own `settings.json` (toriel does not load it itself: it is only for
pi processes toriel did not start); continuing one in toriel forks it.

## Settings

`~/.config/toriel/settings.json` (all keys optional): `steeringMode`, `provider`,
`model`, `thinking`, `piCli`, `warnNoPermissionSystem`. Environment variables (`TORIEL_*`) override it.
Full list and semantics: [docs/reference.md](docs/reference.md).

## Upgrading from ronpi

toriel was called ronpi until 2026-10-30. To move over: stop the old daemon,
update, remove the old links the installer made in pi's agent dir (the notice
line prints the exact `rm` command; `ronpi-*`, `toriel-*` and `messaging`
entries under `~/.pi/agent/extensions` and `skills`), start `toriel`, and `/reload` running sessions. On first start the
`~/.config/ronpi` and `~/.local/share/ronpi` directories are renamed to
`toriel` (nothing is merged; if both exist you get a warning). Every `RONPI_*`
environment variable is now `TORIEL_*` with the same suffix, with no fallback
to the old names. The daemon log moved to `~/.local/state/toriel/daemon.log`.
The agent tools are `toriel_message` and `toriel_usage`;
sessions recorded before the rename still display their injected messages.

## Development

```fish
npm test            # unit and daemon tests (no network, no model; uses a fake pi)
npm run typecheck   # tsc --noEmit
npm run lint        # biome
```

Layout:

- `toriel.ts` - entry point (runs the startup checks, then loads everything else); `bin/toriel` - the launcher
- `src/` - daemon and controller source (see "Code layout" in docs/reference.md)
- `test/` - tests and the fake-pi fixture
- `pi/` - what toriel loads into the pi sessions it starts (extensions: session bridge, messaging tool, usage, cache warning; the messaging skill) plus the theme and the opt-in presence extension
- `docs/` - `reference.md` (keys, semantics, env), `design.md` (architecture, findings, backlog),
  `updates.md` (updating pi and its packages),
  `requirements.md`, `permission-dialogs.md`
- `AGENTS.md` - instructions for coding agents working in this repo
