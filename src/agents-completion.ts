// Tab completion and listing for agent profiles.
import type { AgentProfile } from "./agents.ts";
import type { Choice } from "./cli.ts";
import { flagValueAt } from "./completion.ts";

/**
 * After "/new ... -a " or "--agent ": the agent names that start with what was
 * typed, each with its description. The value replaces the whole line typed
 * after the command, like the other completers.
 */
export function agentCompletions(typed: string, agents: ReadonlyArray<{ name: string; description: string }>): Choice[] {
  const at = flagValueAt(typed, "a", "agent");
  if (!at) {
    return [];
  }
  return agents
    .filter((a) => a.name.startsWith(at.prefix.toLowerCase()))
    .map((a) => ({ value: `${at.head}${a.name}`, description: a.description }));
}

/** The /agents panel. */
export function agentListing(agents: readonly AgentProfile[], problems: readonly string[]): string {
  if (agents.length === 0 && problems.length === 0) {
    return "No agent profiles found.\n\nPut *.md files in agents/ (toriel repo), ~/.config/toriel/agents/ or <project>/.toriel/agents/.";
  }
  // One block per agent (name, description, details) with a blank line between:
  // the panel wraps long lines without a hanging indent, so a column layout
  // turns into a wall of text.
  const rows = agents.map((a) => {
    const bits = [a.model ?? "default model", a.tools ? `tools: ${a.tools.join(",")}` : "default tools", a.source];
    return `${a.name}\n  ${a.description}\n  ${bits.join(" | ")}`;
  });
  const issues = problems.length > 0 ? `\n\nProblems:\n${problems.map((p) => `  ${p}`).join("\n")}` : "";
  return `Agent profiles (/new --agent <name>)\n\n${rows.join("\n\n")}${issues}`;
}
