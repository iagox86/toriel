// The environment of a session's commands. A pi child gets the toriel variables
// (so an agent and its extensions can find the daemon and tell which session they
// are); a `!command` runs in the daemon, not in pi, so it must be given the same
// ones or it would see the daemon's environment instead (#100).
import { delimiter, join } from "node:path";
import { SCOPE_ENV, SCOPE_MODE_ENV } from "../pi/extensions/lib/scope-root.ts";
import { piAgentDir } from "./pi-dir.ts";
import type { ScopeAssignment } from "./scope-root.ts";
import { DEFAULT_SANDBOX_WRITABLE, type TorielSettings } from "./settings.ts";

/** The daemon-owned variables that must never come from the daemon's own environment. */
const OWNED_KEYS = [SCOPE_ENV, SCOPE_MODE_ENV, "TORIEL_SANDBOX", "TORIEL_SANDBOX_RW", "TORIEL_SHARED_DIR", "TORIEL_SANDBOX_TMP"];

/** What a child gets beyond its scope: the shared directory, and (only when set) the sandbox switch with its extra writable roots. */
export interface ChildExtras {
  sharedDir?: string;
  /** The directory a sandboxed child sees as /tmp (persistent, shared by all sandboxed sessions). */
  tmpDir?: string;
  /** Present = run the child's bash commands in the sandbox; the list is the extra writable roots (caches). */
  sandboxWritable?: string[];
}

/**
 * The extra writable roots for a sandboxed child: the sandboxWritable setting (or its default),
 * `~/` expanded against `home`. Only meaningful with a scope, so the caller passes it only then.
 */
export function sandboxWritableRoots(settings: Pick<TorielSettings, "sandboxWritable">, home: string): string[] {
  return (settings.sandboxWritable ?? [...DEFAULT_SANDBOX_WRITABLE]).map((p) => (p.startsWith("~/") ? join(home, p.slice(2)) : p));
}

export interface EnvSession {
  sessionId?: string;
  sessionFile?: string;
}

/**
 * What the pi child process is started with. `scope` (optional) becomes
 * TORIEL_SCOPE_ROOT + TORIEL_SCOPE_MODE, the write scope pair for the scope link;
 * both are daemon-owned. `extras` adds TORIEL_SHARED_DIR and, for a sandboxed child, TORIEL_SANDBOX
 * and TORIEL_SANDBOX_RW. A `!command` runs in the daemon, not in pi, so it must never receive any
 * of them: `bangEnv` calls this without a scope, and any of these already in `base` is dropped (a
 * daemon started inside a scoped session must not leak its own scope or sandbox into every child -
 * an invalid sandbox would refuse every command).
 */
export function childEnv(s: EnvSession, sock: string, base: NodeJS.ProcessEnv = process.env, scope?: ScopeAssignment, extras: ChildExtras = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (OWNED_KEYS.includes(key)) {
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
    env[SCOPE_ENV] = scope.root;
    env[SCOPE_MODE_ENV] = scope.mode;
  }
  if (extras.sharedDir !== undefined) {
    env.TORIEL_SHARED_DIR = extras.sharedDir;
  }
  if (scope !== undefined && extras.sandboxWritable !== undefined) {
    env.TORIEL_SANDBOX = "bwrap";
    env.TORIEL_SANDBOX_RW = extras.sandboxWritable.join(delimiter);
    if (extras.tmpDir !== undefined) {
      env.TORIEL_SANDBOX_TMP = extras.tmpDir;
    }
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
