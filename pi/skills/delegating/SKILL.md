---
name: delegating
description: Hand a self-contained task to a subagent with the toriel_agent tool. Use it for read-only research, reviews and test runs that would bloat your context, for implementing an approved change, or for independent jobs that can run in parallel - not for steps whose answer you need to think with.
---

# Delegating to subagents

`toriel_agent` starts a separate session that runs one agent type on one task and returns its final message. Its description lists the agent types you can use right now; `toriel_agents` lists, waits for, stops and reads back the ones you started.

When to delegate:
- The job is a search, a review, a summary or a test run, and you only need its conclusion. The subagent reads the files, so your context does not fill with them.
- The job is implementing a change the user asked for: hand it to `implement` once it is triaged or planned, with the task, the files involved and the acceptance check in the brief.
- Several jobs do not depend on each other. Start them in the same turn and they run in parallel.

When not to:
- The job is a few tool calls you can do yourself, or the answer feeds straight into your next thought.
- You would have to explain half the conversation to brief it. Either fork (`context: "fork"` copies this conversation, and costs tokens), or do it yourself.
- The user is following your reasoning step by step.

Delegating never widens what you may do. A subagent that edits files asks for permission like you would, and you should only start one that edits (`implement` and `docs-writer` are the shipped ones) when the user asked for that change.

Write the task as a complete brief. The subagent sees nothing else:
- the goal, and what you already know or ruled out;
- paths, names and commands it needs;
- what to return and how long, for example "five bullets, each with file:line";
- whether it may change anything (default: it may not).

How to run it:
- Foreground (the default) blocks your turn until the subagent finishes, so the user cannot steer you meanwhile: use it for a short job whose answer you need right now. Use `background: true` for anything likely to take more than about a minute (a big review, a test run, a wide search): you get a handle at once, the user can keep talking to you, the result arrives later as a message, and `toriel_agents` can wait for it. Say that you started it in the background.
- At most 3 run at once and each has a token budget (150k by default). Check `toriel_usage` before a big fan-out. A refusal comes back as text: do the work yourself.
- A subagent stopped by its limits returns what it had so far, with the reason. Say so in your answer instead of presenting it as complete.

After it returns, treat the result as a claim, not a fact. Spot-check the file:line references that matter before you build on them. Tell the user what you delegated and what came back. A permission question from a subagent appears in your view, labelled with its name; the user answers it.

Do not message other sessions from here: `toriel_message` is only for when the user asks.
