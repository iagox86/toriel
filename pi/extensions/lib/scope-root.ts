import * as fs from "node:fs";
import * as path from "node:path";

export const SCOPE_ENV = "TORIEL_SCOPE_ROOT";
export const SCOPE_MODE_ENV = "TORIEL_SCOPE_MODE";

/** What the scope link does with a covered write outside the root (decision 1 of SPEC-172-T8). */
export type ScopeMode = "deny" | "ask";

export type Scope =
  | { kind: "off" }
  | { kind: "root"; root: string; mode: ScopeMode }
  | { kind: "invalid"; why: string; mode: ScopeMode };

type FsApi = {
  realpathSync: (p: string) => string;
  statSync: (p: string) => { isDirectory: () => boolean };
};

/**
 * Resolve TORIEL_SCOPE_ROOT (and its TORIEL_SCOPE_MODE companion) from a child's
 * env into a Scope.
 *
 * Absent (undefined) is the only "off". Every present value that fails
 * validation is "invalid", never trimmed or repaired. The mode defaults to
 * deny: a root without a mode (older daemon, hand-set env) behaves as T1
 * shipped (decision 4 of SPEC-172-T8); only the exact string "ask" reads as
 * ask. Never throws: an fs error while probing yields "invalid".
 */
export function readScope(env: Record<string, string | undefined>, fsApi: FsApi = { realpathSync: fs.realpathSync, statSync: fs.statSync }): Scope {
  const mode: ScopeMode = env[SCOPE_MODE_ENV] === "ask" ? "ask" : "deny";
  try {
    const value = env[SCOPE_ENV];
    if (value === undefined) {
      return { kind: "off" };
    }
    if (!path.isAbsolute(value)) {
      return { kind: "invalid", why: "not an absolute path", mode };
    }
    if (value === path.parse(value).root) {
      return { kind: "invalid", why: "is the filesystem root, which would allow everything", mode };
    }
    if (!fsApi.statSync(value).isDirectory()) {
      return { kind: "invalid", why: "is not a directory", mode };
    }
    const real = fsApi.realpathSync(value);
    if (real !== value) {
      return { kind: "invalid", why: `is not canonical (resolves to ${real})`, mode };
    }
    return { kind: "root", root: value, mode };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { kind: "invalid", why: `does not exist or cannot be stat'd (${detail})`, mode };
  }
}

/**
 * Lexical containment for canonical paths.
 *
 * true iff target === root or target starts with root + separator (the
 * separator defeats the sibling-prefix trap: /x/W-evil is not inside /x/W).
 * Non-absolute targets, and targets containing a ".." segment (non-canonical
 * text that is not provably inside), are outside. Callers pass the gate's
 * canonical boundaryValue; we do not resolve here, because a not-yet-existing
 * target has nothing to resolve to and re-resolving would lose the gate's
 * canonicalisation.
 */
export function isInside(root: string, target: string): boolean {
  if (!path.isAbsolute(target)) {
    return false;
  }
  if (target.split(path.sep).includes("..")) {
    return false;
  }
  if (target === root) {
    return true;
  }
  return target.startsWith(root + path.sep);
}

/** Interpreters that run code given on their command line (`python3 -c`, `node -e`, `sh -c`, `perl -e`), where the code hides what it touches. */
const PAYLOAD_RUNNER = /(?<![\w.-])(?:sh|bash|zsh|dash|ksh|fish|python[\d.]*|node|nodejs|perl|ruby|php|deno|bun|lua)\s+(?:-[A-Za-z]*[ce]|--eval|--command|--exec)(?![\w-])/;

/** Absolute paths, `~` and `$VAR` paths in a text; a `//` of a URL or a word-internal slash does not start one. */
const PATH_LIKE = /(?<![\w/.:$~{}-])(?:(?:~|\$\{?\w+\}?)(?:\/[^\s"'`,;)\]}]*)?|\/[\w.~-][^\s"'`,;)\]}]*)/g;

/** A path that walks up out of the cwd (`../x`, `sub/../../x`): not caught by PATH_LIKE (no leading `/`, `~` or `$`), but the bash session's cwd is the scope root, so it leaves it. */
const RELATIVE_UP = /(?<![\w.])\.\.\/[^\s"'`,;)\]}]*/;

/** Where scratch files are fine in every scope (the sandbox gives a session its own /tmp). */
const SCRATCH = /^(?:\/tmp|\/var\/tmp)(?:\/|$)|^\/dev\/(?:null|stdout|stderr|stdin|tty)$/;

/**
 * Ticket 218: the first path in an interpreter payload (`python3 -c "open('/etc/x','w')"`) that is not provably inside the scope root,
 * or undefined when the command has no such payload or every path in it is inside. The package's bash parser sees `rm ~/x` but not a
 * path inside a string handed to an interpreter, so deny mode checks the text itself. `~` and `$HOME` expand to the home directory; any
 * other `$VAR` cannot be resolved, so it counts as outside. Lexical, like the rest of the guard: it closes the plain form, and a payload
 * that builds the path at run time (`'/ho'+'me'`) is the sandbox's job.
 */
export function payloadEscape(command: string, root: string, home: string = process.env.HOME ?? ""): string | undefined {
  const at = command.search(PAYLOAD_RUNNER);
  if (at < 0) {
    return undefined;
  }
  const rest = command.slice(at);
  const up = RELATIVE_UP.exec(rest);
  if (up !== null) {
    return up[0]; // `python3 -c "open('../evil','w')"` resolves against the session cwd, which is the root
  }
  for (const m of rest.matchAll(PATH_LIKE)) {
    const raw = m[0];
    const expanded = /^(?:~|\$\{?HOME\}?)(?=\/|$)/.test(raw) ? raw.replace(/^(?:~|\$\{?HOME\}?)/, home) : raw;
    if (expanded.startsWith("$") || (expanded.startsWith("~") && !expanded.startsWith("~/"))) {
      return raw; // a variable (or another user's home) cannot be resolved here
    }
    const norm = path.normalize(expanded);
    if (SCRATCH.test(norm) && !SCRATCH.test(root)) {
      continue; // scratch is exempt unless the scope itself lives there (then a sibling in /tmp is outside it)
    }
    if (!isInside(root, norm)) {
      return raw;
    }
  }
  return undefined;
}

/** Resolve a write target the way the file would be reached: `~` expanded, relative to `cwd`, symlinks followed through the nearest existing ancestor (the file itself may not exist yet). */
export function resolveTarget(raw: string, cwd: string, home: string = process.env.HOME ?? "", realpath: (p: string) => string = fs.realpathSync): string {
  const expanded = raw === "~" || raw.startsWith("~/") ? home + raw.slice(1) : raw;
  let abs = path.resolve(cwd, expanded);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(realpath(abs), ...tail.reverse());
    } catch {
      const parent = path.dirname(abs);
      if (parent === abs) {
        return path.join(abs, ...tail.reverse());
      }
      tail.push(path.basename(abs));
      abs = parent;
    }
  }
}

/** Ticket 219: the resolved path of a write/edit target that is not inside the scope root (undefined when it is inside, or is scratch). */
export function writeEscape(root: string, raw: string, cwd: string, home: string = process.env.HOME ?? "", realpath: (p: string) => string = fs.realpathSync): string | undefined {
  const target = resolveTarget(raw, cwd, home, realpath);
  if (SCRATCH.test(target) && !SCRATCH.test(root)) {
    return undefined;
  }
  return isInside(root, target) ? undefined : target;
}

/**
 * Ticket 219: the scope boundary as a veto on a tool call, whatever the permission rules say (the authorizer link only sees asks, so an
 * allow rule skipped it). Deny mode only; ask mode leaves the decision to the dialog. Returns a reason to block, or undefined to let the
 * call go on to the permission system. Total: never throws; an unexpected error in deny mode blocks a write rather than letting it by.
 */
export function vetoVerdict(scope: Scope, toolName: string, input: unknown, cwd: string): string | undefined {
  if (scope.kind === "off" || scope.mode !== "deny") {
    return undefined;
  }
  const writes = toolName === "write" || toolName === "edit";
  try {
    if (scope.kind === "invalid") {
      return writes ? `scope guard: TORIEL_SCOPE_ROOT is set but unusable (${scope.why}); denying all writes. Fix the environment the daemon starts this session with.` : undefined;
    }
    const args = (input ?? {}) as { path?: unknown; command?: unknown };
    if (toolName === "bash" && typeof args.command === "string") {
      const escaped = payloadEscape(args.command, scope.root);
      return escaped === undefined ? undefined : `scope guard: this command hands code to an interpreter that names ${escaped}, which is not inside this session's write scope ${scope.root} (TORIEL_SCOPE_ROOT). Put the code in a script file under ${scope.root} and run that, and keep what it writes under ${scope.root}.`;
    }
    if (writes) {
      if (typeof args.path !== "string" || args.path === "") {
        return `scope guard: cannot resolve a target for this ${toolName}; denying (scope root ${scope.root})`;
      }
      const escaped = writeEscape(scope.root, args.path, cwd);
      return escaped === undefined ? undefined : `scope guard: ${escaped} is outside this session's write scope ${scope.root} (TORIEL_SCOPE_ROOT). Write only under ${scope.root}.`;
    }
    return undefined;
  } catch {
    return writes ? "scope guard: internal error evaluating this write; denying" : undefined;
  }
}
