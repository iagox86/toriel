# Agent profiles

A profile is a markdown file: frontmatter that decides how a session launches, then the system prompt. Start one with `/new --agent <name>` (tab completes names), list them with `/agents`. Same shape as Claude Code's agent files, so those can be pasted in; toriel does not read Claude's own folders.

## Shipped types

| name | for | tools |
|---|---|---|
| `explore` | where is X, how does Y work (file:line answers) | read, grep, find, ls |
| `summarize` | digest a log, diff or long file | read, grep, find, ls |
| `code-review` | bugs, risky changes and missing tests in a diff or files | read, grep, find, ls, `mcp__git__git_read*` (extensions on: MCP is an extension) |
| `plan` | an ordered implementation plan after reading the code | read, grep, find, ls |
| `git-archaeology` | why code is the way it is: the commits and messages behind it | read, grep, find, ls, `mcp__git__git_read*` (extensions on) |
| `test-runner` | run a test or build command, report only the failures | read, grep, find, ls, bash, toriel_job (keeps extensions, so the permission system still guards bash) |

None sets a model: they use your settings' default; to pin one (say a small local model for `summarize`) copy the file into `~/.config/toriel/agents/` and add `model:`. The `git` types need the git MCP server named `git` in pi's `mcp.json` (toriel-git-mcp, started without `--repository`, so every call passes `repo:`; the prompts say to use the working directory). `test/agents-shipped.test.ts` holds every shipped profile to the same limits: a description of at most 160 characters (it is shown in each parent's `toriel_agent` description), a prompt of at most 1500, an explicit tool list of known names, no `canSpawn`, no model, no `git_write`/`git_net`, and `bash`/`edit`/`write` only with extensions on.

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
extensions: false               # default true; false drops pi extensions: the permission system, memory tools AND pi's MCP support (so not with mcp__ tools)
minimal: true                   # default true; skips AGENTS.md/CLAUDE.md, skills, prompt templates
maxTurns: 25                    # turns a subagent may take before it is cut off (toriel_agent runs)
budget: 150000                  # fresh tokens (input + output, not cache reads) a subagent may use; default 150000, capped by its parent's remainder
canSpawn: false                 # may this agent start subagents of its own (also needs depth left; default false)
---
The system prompt, appended to pi's own.
```

What the launch does:

- `tools` becomes `--tools`. pi keeps MCP tools unless an entry starts with `mcp__`, so a profile with no `mcp__` entry also gets `--no-mcp`. **An explicit `tools` list owns the loadout**: tools that extensions add are only kept if named (measured on the pinned pi 1.4.0 - a `-e` extension's tools are filtered out unless listed; pi's own agent-dir extension tools survive, so do not rely on that either). To keep messaging under `extensions: false`, name them: `tools: read, grep, toriel_message, toriel_usage`. A profile with no `tools` entry keeps toriel's tools (the daemon adds them additively); `extensions: false` alone makes a bare agent. A profile with `canSpawn: true` that lists `tools` must name `toriel_agent` and `toriel_agents` to use them. A profile that names `bash` should also name `toriel_job`: `bash` accepts `run_in_background` in every toriel session, but without `toriel_job` the agent cannot list, read or stop what it starts (it still gets the exit notice).
- **MCP tool names need a `*`**: pi's `--tools` never matches an exact `mcp__server__tool` name (measured on pi 1.4.0), so the loader appends one (`mcp__git__git_read` becomes `mcp__git__git_read*`); write `mcp__server__*` for a whole server. **A profile that names MCP tools must keep `extensions` on**: pi's MCP support is a built-in extension, so `extensions: false` removes every MCP tool; the loader refuses that combination with a message (the permission system, also an extension, then guards the MCP tools). Without `*` or with extensions off the agent silently gets no tool and improvises - that is how `code-review` first ran with no git access.
- A profile with `mcp__server__*` tools only sees that server's tools, but pi still connects every enabled server in `mcp.json` when the session starts. There is no per-run server choice in pi. The loader warns when a pattern names a server that is not configured.
- `model` and `thinking` apply when a session is created; a resumed session keeps its own. The prompt, tools and flags are re-applied on every respawn (the profile is saved per session in `~/.local/share/toriel/session-agents.json`, so editing the file later does not change existing sessions).
