// The environment of a session's commands. A pi child gets the toriel variables
// (so an agent and its extensions can find the daemon and tell which session they
// are); a `!command` runs in the daemon, not in pi, so it must be given the same
// ones or it would see the daemon's environment instead (#100).
import { delimiter, join } from "node:path";
import { FILE_HISTORY_ENV } from "../pi/extensions/lib/file-history.ts";
import { FRESHNESS_ENV } from "../pi/extensions/lib/freshness.ts";
import { PLAN_DIR_ENV } from "../pi/extensions/lib/plan-mode.ts";
import { MCP_DIRECT_ENV, MCP_FILE_ENV, MCP_RECORDS_ENV, MCP_SUMMARIES_ENV } from "../pi/extensions/lib/mcp-config.ts";
import { SCOPE_ENV, SCOPE_MODE_ENV } from "../pi/extensions/lib/scope-root.ts";
import { piAgentDir } from "./pi-dir.ts";
import type { ScopeAssignment } from "./scope-root.ts";
import { DEFAULT_SANDBOX_WRITABLE, type TorielSettings } from "./settings.ts";

/** The daemon-owned variables that must never come from the daemon's own environment. */
const OWNED_KEYS = [SCOPE_ENV, SCOPE_MODE_ENV, "TORIEL_SANDBOX", "TORIEL_SANDBOX_RW", "TORIEL_SHARED_DIR", "TORIEL_SANDBOX_TMP", MCP_FILE_ENV, MCP_DIRECT_ENV, MCP_SUMMARIES_ENV, MCP_RECORDS_ENV, FILE_HISTORY_ENV, PLAN_DIR_ENV, FRESHNESS_ENV];

/**
 * Every variable the daemon sets on a pi child: the owned ones above, the identity ones `childEnv` adds, and the
 * delegation pair from `delegationEnv` in daemon-children.ts. The test runner drops all of them, so tests run inside a
 * toriel session behave as in a plain shell (ticket 339); test/child-env.test.ts fails when `childEnv` sets one not listed.
 */
export const CHILD_ENV_KEYS: readonly string[] = [...OWNED_KEYS, "TORIEL_CHILD", "TORIEL_SOCK", "TORIEL_SESSION_ID", "TORIEL_CAN_SPAWN", "TORIEL_AGENT_TYPES"];

/** What a child gets beyond its scope: the shared directory, and (only when set) the sandbox switch with its extra writable roots. */
export interface ChildExtras {
  sharedDir?: string;
  /** The directory a sandboxed child sees as /tmp (persistent, shared by all sandboxed sessions). */
  tmpDir?: string;
  /** Present = run the child's bash commands in the sandbox; the list is the extra writable roots (caches). */
  sandboxWritable?: string[];
  /** Where mcp.yaml is, for the toriel-mcp extension to read (a path, not the contents: an entry's env may hold a secret); only for a session that has MCP support (tickets 209, 216). */
  mcpFile?: string;
  /** The MCP servers whose tools the session's agent profile lists: the toriel-mcp extension declares them at once (ticket 298). */
  mcpDirect?: readonly string[];
  /** The file of remembered MCP server summaries (ticket 303), with mcpFile: the toriel-mcp extension reads and updates it. */
  mcpSummaries?: string;
  /** The file of /mcp explore records (ticket 308), with mcpFile: the toriel-mcp extension reads and updates it. */
  mcpRecords?: string;
  /** Where sessions keep their file history (ticket 11): the toriel-filehistory extension writes a journal per session under it. */
  fileHistoryDir?: string;
  /** Where the per-session plan-mode markers are (ticket 229); the toriel-plan extension and the plan-mode bash wrapper read them. */
  planDir?: string;
  /** False turns the toriel-files extension's read-before-edit check off (the fileFreshness setting); anything else leaves it on. */
  freshness?: boolean;
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
  if (extras.mcpFile !== undefined) {
    env[MCP_FILE_ENV] = extras.mcpFile;
  }
  if (extras.mcpDirect !== undefined && extras.mcpDirect.length > 0) {
    env[MCP_DIRECT_ENV] = extras.mcpDirect.join(",");
  }
  if (extras.mcpSummaries !== undefined) {
    env[MCP_SUMMARIES_ENV] = extras.mcpSummaries;
  }
  if (extras.mcpRecords !== undefined) {
    env[MCP_RECORDS_ENV] = extras.mcpRecords;
  }
  if (extras.fileHistoryDir !== undefined) {
    env[FILE_HISTORY_ENV] = extras.fileHistoryDir;
  }
  if (extras.freshness === false) {
    env[FRESHNESS_ENV] = "off";
  }
  if (extras.planDir !== undefined) {
    env[PLAN_DIR_ENV] = extras.planDir;
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
