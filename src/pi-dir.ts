// Where pi keeps its own configuration (settings.json, auth, models.json,
// mcp.json, packages, sessions). That directory is the user's: toriel reads it
// but never installs anything into it (its own extensions and skill are passed
// to each pi child as flags, see resources.ts).
import { homedir } from "node:os";
import { join } from "node:path";

export function piAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}
