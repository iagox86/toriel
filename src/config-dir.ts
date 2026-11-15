// Where toriel's own config files live. A leaf module (it imports nothing of toriel's), so settings, agents and the MCP code can all
// ask without importing each other.
import * as path from "node:path";

/** ~/.config/toriel (or under XDG_CONFIG_HOME). */
export function configDir(env: NodeJS.ProcessEnv): string {
  return path.join(env.XDG_CONFIG_HOME ?? path.join(env.HOME ?? "", ".config"), "toriel");
}

/** Where the settings file lives (settings.yaml), whether or not it exists yet. TORIEL_SETTINGS names a file of any name. */
export function yamlSettingsFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.TORIEL_SETTINGS || path.join(configDir(env), "settings.yaml");
}

/** Where the MCP servers are configured (ticket 216): mcp.yaml beside the toriel settings file; TORIEL_MCP overrides it (tests). */
export function mcpYamlFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.TORIEL_MCP || path.join(path.dirname(yamlSettingsFile(env)), "mcp.yaml");
}
