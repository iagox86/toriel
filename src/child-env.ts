// The environment of a session's commands. A pi child gets the toriel variables
// (so an agent and its extensions can find the daemon and tell which session they
// are); a `!command` runs in the daemon, not in pi, so it must be given the same
// ones or it would see the daemon's environment instead (#100).
import { delimiter, join } from "node:path";
import { piAgentDir } from "./pi-dir.ts";

export interface EnvSession {
  sessionId?: string;
  sessionFile?: string;
}

/** What the pi child process is started with. */
export function childEnv(s: EnvSession, sock: string, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env.TORIEL_CHILD = "1";
  env.TORIEL_SOCK = sock;
  if (s.sessionId) {
    env.TORIEL_SESSION_ID = s.sessionId;
  }
  return env;
}

/**
 * What a `!command` runs with: the child's variables, plus what pi's own bash tool
 * adds for a command (pi's bin directory first on PATH, PI_SESSION_ID and
 * PI_SESSION_FILE). PI_PROVIDER, PI_MODEL and PI_REASONING_LEVEL are left out: the
 * daemon holds a display name for the model, not pi's ids, and they would be stale
 * after a /model anyway.
 */
export function bangEnv(s: EnvSession, sock: string, base: NodeJS.ProcessEnv = process.env, binDir: string = join(piAgentDir(base), "bin")): Record<string, string> {
  const env = childEnv(s, sock, base);
  for (const key of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) {
    delete env[key];
  }
  if (s.sessionId) {
    env.PI_SESSION_ID = s.sessionId;
  }
  if (s.sessionFile) {
    env.PI_SESSION_FILE = s.sessionFile;
  }
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const entries = (env[pathKey] ?? "").split(delimiter).filter(Boolean);
  if (!entries.includes(binDir)) {
    env[pathKey] = [binDir, ...entries].join(delimiter);
  }
  return env;
}
