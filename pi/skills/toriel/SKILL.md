---
name: toriel
description: How this session is hosted by toriel and which commands the user can type. Use when the user asks how to do something in the session itself, or when you are about to tell them to use the pi CLI, `pi mcp`, restart or reload the session, add or sign in to an MCP server, change the model or thinking level, rename, fork, clear or compact the session, schedule a follow-up, or check permissions or setup.
---

# Working under toriel

This session runs under **toriel**, a terminal controller that hosts many pi sessions. The user types `/commands` into the input box; toriel handles those itself and never sends them to you. You cannot run them. When one is the answer, **name it and ask the user to type it**. Never tell them to use the pi CLI (`pi mcp ...`, `pi update`, editing `mcp.json` by hand) when a command below does it.

## Commands the user has in a session

Configuration and setup
- `/mcp` - `list` (servers, state, matching skill), `status [server]` (why one is failing), `add <name> <url | command args>`, `remove <server>`, `reconnect [server]`, `login` / `logout [server]` (OAuth), `explore <server>` (you introspect it and write a skill for it). A new MCP server needs the session reloaded; `add` does that.
- `/model` and `/think` - pick the model or thinking level from a list, or name one.
- `/reload` - restart pi on this session to pick up new extensions, skills, settings or MCP config. The conversation is kept.
- `/doctor` - check toriel's setup and say how to fix each problem (`--fix` applies the safe ones). Suggest it when a toriel tool or feature seems missing.
- `/permissions` - list, add and revoke this session's permission grants (what you may run without asking).
- `/cd [dir]` - move the session to another directory (not while you are working).
- `/mouse` - mouse handling on, off or toggle.

The conversation
- `/compact [focus]` - summarize older context to free the window. `/clear` - wipe the conversation, keep name and model. `/fork` - continue in a copy. `/continue` - tell you an interruption was an accident so you carry on. `/init` - have you write or update AGENTS.md.
- `/name` (also `/rename`) - rename the session. `/comment` - a private note on it. `/park` - set it aside until used again.
- `/abort` - interrupt you. `/background` - move the command you are waiting for to the background.
- `/btw` - a side question whose answer pops up and never reaches you. `/why` - a short explanation of your last thinking block. `/performance` - analyze this session's transcript for bloat. `/feedback` - record a note about a harness problem.

Timed work (you can also do this yourself with the schedule tools, see the `scheduling` skill)
- `/in`, `/at`, `/every`, `/loop`, `/cron` - send a prompt to this session later or repeatedly. `/watch <path>` - when a file or directory changes. `/schedules` lists them; `/cancel`, `/pause`, `/resume`, `/fire` manage them.

Subagents
- `/parent` jumps to the session that started a subagent; `/detach` cuts a subagent loose from it.

Leaving: `/exit` and `/quit`. `/help` lists everything with options. A `!command` typed by the user runs a shell command in the session's directory.

In the session list (not inside a session) the user also has `/new` (start a session; `--agent <profile>`), `/agents`, `/stop`, `/delete`, `/restore`, `/group`, `/ungroup`, `/summarize`, `/filter`, `/external`, `/adopt` and `/kill-daemon`.

## What you can do yourself

- `toriel_message` - tell another session something (only when the user asks; see `messaging`).
- `toriel_schedule_create`, `toriel_schedule_list`, `toriel_schedule_cancel` - follow-ups for yourself (see `scheduling`).
- `toriel_agent`, `toriel_agents` - hand a bounded task to a subagent (see `delegating`), where your profile allows it.
- `toriel_usage` - the model provider's quota and spend, when asked.
- `toriel_job` - read or stop a command you started with `run_in_background`.

## How to ask

Say what and why in one line, with the exact command: "Run `/mcp add docs https://example.com/mcp`, then `/reload`." If a command needs a value only the user has (a token, a URL), ask for it or give the command with a placeholder. Do not paste secrets into a command suggestion.
