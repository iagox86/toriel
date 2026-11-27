// /mcp explore: the prompt asking the agent to introspect one MCP server and
// write a skill for it. Kept in its own module so the wording has a unit test
// without pulling in the TUI.
import { mcpExploreAllFirstLine } from "../pi/extensions/lib/mcp-config.ts";

export function mcpExplorePrompt(server: string): string {
  return [
    `Write a skill for the MCP server "${server}" so that future agents can use it without rediscovering its shape.`,
    "If a SKILL.md for this server already exists, read it first and update it rather than overwriting it.",
    "Introspect the server first, using your own MCP inspection tools: its tools are in your MCP tool namespace, where you can list and describe them to get their full parameter schemas (and see its resources if it has any), and call a minimal one if describing is still not enough.",
    "Then write the skill: if you have a skill-management tool of your own, use it and let it place the skill; otherwise write it under the memory extension's skills directory when that exists (~/.pi/agent/pi-hermes-memory/skills, or $PI_CODING_AGENT_DIR/pi-hermes-memory/skills), falling back to the pi agent directory's own skills/ folder (~/.pi/agent/skills, or $PI_CODING_AGENT_DIR/skills). Either way use a subdirectory named after the server or its topic with a filesystem-safe name derived from the server name (lowercase, a-z, 0-9, - and _ only) so it is a valid path: <skills dir>/<server or topic name>/SKILL.md.",
    "Follow pi's skill format: a frontmatter with name and description; the description is what surfaces the skill to future agents, so make it say what the server is for and the phrases an agent would actually use.",
    "Keep the skill short, about 4 KB at most, since an agent reads all of it into its context: what the server is for, which tool to use for each common task, gotchas (quirks, required sign-in, anything easy to get wrong), and one example call per important tool. Do not copy every tool's parameters: an agent gets a tool's full schema when it loads the tool.",
    'Right after the frontmatter, give one line with the exact tool_search call that loads the tools most tasks need in one go (for example: tool_search query "<the tool names>" limit <how many>), because each separate load makes the next request re-send the whole conversation without the prompt cache.',
    "Verify what you wrote by reading it back with your read tool - do not shell out to grep/head/wc for checks like existence or ASCII-cleanliness; shell commands may trigger permission prompts for no good reason.",
    "Be factual: write only what the introspection shows, not what you guess.",
  ].join(" ");
}

/**
 * Bare /mcp explore: one prompt for several servers. Its first line is exactly what the toriel-mcp extension
 * stamps the explore records from, so it must start with `mcpExploreAllFirstLine` verbatim. The body leans on
 * the single-server prompt (the same placement, cap and verification rules) rather than restating it at length.
 */
export function mcpExploreAllPrompt(servers: readonly string[]): string {
  return [
    mcpExploreAllFirstLine(servers),
    "Introspect each of the servers named above with your own MCP inspection tools: list and describe its tools to get their full parameter schemas (and see its resources if it has any), and call a minimal one if describing is still not enough.",
    "Then write or update a skill for each, following exactly the rules of the single-server prompt: update a server's existing SKILL.md rather than overwrite it; place the skills the same way (a skill-management tool of your own if you have one, otherwise the memory extension's skills directory when it exists (~/.pi/agent/pi-hermes-memory/skills, or $PI_CODING_AGENT_DIR/pi-hermes-memory/skills), falling back to the pi agent directory's own skills/ folder, in a subdirectory named after the server or its topic with a filesystem-safe name derived from the server name); keep each skill short, about 4 KB at most, with a frontmatter carrying name and description; and right after the frontmatter give one line with the exact tool_search call that loads that server's most-needed tools in one go.",
    "After writing each skill, verify it by reading it back with your read tool. Be factual: write only what the introspection shows, not what you guess.",
    "If one of the listed servers turns out not to be configured or is not connected, say so and continue with the rest.",
  ].join("\n");
}
