# Agent profiles

A profile is a markdown file: frontmatter that decides how a session launches, then the system prompt. Start one with `/new --agent <name>` (tab completes names), list them with `/agents`. Same shape as Claude Code's agent files, so those can be pasted in; toriel does not read Claude's own folders.

Searched in order, a later folder replacing an earlier agent of the same name:

1. `agents/` in the toriel repo (shipped)
2. `~/.config/toriel/agents/` (yours)
3. `<project>/.toriel/agents/` (this project only)

```
---
name: reverse-engineer          # required: lowercase letters, digits, - and _
description: What it is for.    # required: what picks the agent
tools: read, grep, bash, mcp__ghidra__*   # allowlist; patterns allowed; Claude names (Read, Glob) are mapped
model: litellm/gemma4:12b       # provider/id; default = your settings
thinking: low                   # off, minimal, low, medium, high, xhigh, max
extensions: false               # default true; false drops pi extensions (permission system, memory tools)
minimal: true                   # default true; skips AGENTS.md/CLAUDE.md, skills, prompt templates
maxTurns: 25                    # parsed now, enforced once subagents exist
budget: 150000                  # tokens; same
canSpawn: false                 # same
---
The system prompt, appended to pi's own.
```

What the launch does:

- `tools` becomes `--tools`. pi keeps MCP tools unless an entry starts with `mcp__`, so a profile with no `mcp__` entry also gets `--no-mcp`. **An explicit `tools` list owns the loadout**: tools that extensions add are only kept if named (measured on the pinned pi 1.4.0 - a `-e` extension's tools are filtered out unless listed; pi's own agent-dir extension tools survive, so do not rely on that either). To keep messaging under `extensions: false`, name them: `tools: read, grep, toriel_message, toriel_usage`. A profile with no `tools` entry keeps toriel's tools (the daemon adds them additively); `extensions: false` alone makes a bare agent.
- A profile with `mcp__server__*` tools only sees that server's tools, but pi still connects every enabled server in `mcp.json` when the session starts. There is no per-run server choice in pi. The loader warns when a pattern names a server that is not configured.
- `model` and `thinking` apply when a session is created; a resumed session keeps its own. The prompt, tools and flags are re-applied on every respawn (the profile is saved per session in `~/.local/share/toriel/session-agents.json`, so editing the file later does not change existing sessions).
