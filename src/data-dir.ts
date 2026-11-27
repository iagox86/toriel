// The root toriel's data lives under, read from the environment at call time and free of side effects, so a module
// that saves files (btw, info cards, performance reports, groups) needs no import of config.ts (which creates the
// profile directory and needs a socket path) and a test can pass its own env.
import * as path from "node:path";

/**
 * $XDG_DATA_HOME (or ~/.local/share), or, in an isolated instance (TORIEL_PROFILE, `toriel --isolated`), the profile's
 * own data directory: the same rule as config.ts DATA_DIR, so an isolated run never writes into the real one (ticket 343).
 */
export function dataRoot(env: NodeJS.ProcessEnv = process.env): string {
  const profile = env.TORIEL_PROFILE;
  if (profile && env.XDG_RUNTIME_DIR) {
    return path.join(env.XDG_RUNTIME_DIR, `toriel-${profile}`, "data");
  }
  return env.XDG_DATA_HOME ?? path.join(env.HOME ?? "", ".local", "share");
}

/** A directory under toriel's data: `<dataRoot>/toriel/<name>`. */
export function torielDataDir(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(dataRoot(env), "toriel", name);
}
