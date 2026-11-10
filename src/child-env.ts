// The environment of a session's commands. A pi child gets the toriel variables
// (so an agent and its extensions can find the daemon and tell which session they
// are); a `!command` runs in the daemon, not in pi, so it must be given the same
// ones or it would see the daemon's environment instead (#100).
import { delimiter, join } from "node:path";
import { piAgentDir } from "./pi-dir.ts";
import type { ScopeAssignment } from "./scope-root.ts";

export interface EnvSession {
  sessionId?: string;
  sessionFile?: string;
}

/**
 * What the pi child process is started with. `scope` (optional) becomes
 * TORIEL_SCOPE_ROOT + TORIEL_SCOPE_MODE, the write scope pair for the scope link;
 * both are daemon-owned. A `!command` runs in the daemon, not in pi, so it must
 * never receive either variable: `bangEnv` calls this without a scope, and a
 * TORIEL_SCOPE_ROOT or TORIEL_SCOPE_MODE already in `base` is dropped (a daemon
 * started inside a scoped session must not leak its own scope into every child).
 */
export function childEnv(s: EnvSession, sock: string, base: NodeJS.ProcessEnv = process.env, scope?: ScopeAssignment): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (key === "TORIEL_SCOPE_ROOT" || key === "TORIEL_SCOPE_MODE") {
      continue;
    }
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env.TORIEL_CHILD = "1";
  env.TORIEL_SOCK = sock;
  if (s.sessionId) {
    env.TORIEL_SESSION_ID = s.sessionId;
  }
  if (scope !== undefined) {
    env.TORIEL_SCOPE_ROOT = scope.root;
    env.TORIEL_SCOPE_MODE = scope.mode;
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
