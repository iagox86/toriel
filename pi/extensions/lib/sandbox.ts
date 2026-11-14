// The per-command bash sandbox (board 190; findings: docs/sandbox-spike.md). Every command the
// agent runs through toriel's bash tool is wrapped in bubblewrap: the whole filesystem is
// read-only except the session's scope root and a short, explicit list of other places. The
// policy is recomputed at each launch, so a path approved later applies to the NEXT command with
// nothing restarted (a running process's sandbox can never be widened: landlock and bwrap both
// fix it at creation).
//
// This module is pure apart from reading the filesystem layout (git files, a node_modules
// symlink). It never throws; a policy that cannot be derived is reported, and the caller refuses
// to run the command rather than running it unsandboxed.
import * as fs from "node:fs";
import * as path from "node:path";
import { readScope } from "./scope-root.ts";

/** "bwrap" switches the sandbox on; absent is off (the default). Set by the daemon, only for scoped children. */
export const SANDBOX_ENV = "TORIEL_SANDBOX";
/** A directory every sandboxed command may write: the stable place to hand files to other agents or to you. */
export const SHARED_DIR_ENV = "TORIEL_SHARED_DIR";
/** The persistent directory bound over /tmp, shared by all sandboxed sessions (ticket 204); the daemon owns and creates it. */
export const SANDBOX_TMP_ENV = "TORIEL_SANDBOX_TMP";
/** Extra always-writable roots (caches), joined with the path delimiter; the daemon fills it from the toriel settings. */
export const SANDBOX_RW_ENV = "TORIEL_SANDBOX_RW";

export type SandboxConfig =
  | { kind: "off" }
  | { kind: "bwrap"; root: string; shared?: string; staticRw: string[]; sock?: string; tmp?: string }
  | { kind: "invalid"; why: string };

type FsApi = {
  lstatSync: (p: string) => { isFile: () => boolean; isDirectory: () => boolean; isSymbolicLink: () => boolean };
  statSync: (p: string) => { isDirectory: () => boolean };
  realpathSync: (p: string) => string;
  readFileSync: (p: string, encoding: "utf8") => string;
  existsSync: (p: string) => boolean;
};

const defaultFs: FsApi = {
  lstatSync: fs.lstatSync,
  statSync: fs.statSync,
  realpathSync: fs.realpathSync,
  readFileSync: (p) => fs.readFileSync(p, "utf8"),
  existsSync: fs.existsSync,
};

/**
 * The sandbox settings of a child's environment. Absent TORIEL_SANDBOX is the only "off"; anything
 * present that is not exactly "bwrap", or "bwrap" without a usable scope root, is "invalid" so the
 * caller fails closed (a typo must not silently mean unsandboxed). Never throws.
 */
export function readSandbox(env: Record<string, string | undefined>, fsApi: Pick<FsApi, "statSync" | "realpathSync"> = defaultFs): SandboxConfig {
  const mode = env[SANDBOX_ENV];
  if (mode === undefined) {
    return { kind: "off" };
  }
  if (mode !== "bwrap") {
    return { kind: "invalid", why: `${SANDBOX_ENV} is ${JSON.stringify(mode)}; only "bwrap" is understood` };
  }
  const scope = readScope(env, fsApi);
  if (scope.kind !== "root") {
    return { kind: "invalid", why: `the sandbox needs a usable TORIEL_SCOPE_ROOT (${scope.kind === "invalid" ? scope.why : "it is not set"})` };
  }
  if (scope.root === "/tmp" || scope.root.startsWith("/tmp/")) {
    return { kind: "invalid", why: `the scope root ${scope.root} is under /tmp, which every sandboxed command sees as the sandbox's own /tmp (not the real one); work from a directory elsewhere` };
  }
  const shared = env[SHARED_DIR_ENV];
  const rw = env[SANDBOX_RW_ENV];
  const sock = env.TORIEL_SOCK;
  const tmp = env[SANDBOX_TMP_ENV];
  return {
    kind: "bwrap",
    root: scope.root,
    shared: shared !== undefined && path.isAbsolute(shared) ? shared : undefined,
    staticRw: rw ? rw.split(path.delimiter).filter((p) => path.isAbsolute(p)) : [],
    sock: sock !== undefined && path.isAbsolute(sock) ? sock : undefined,
    tmp: tmp !== undefined && path.isAbsolute(tmp) ? tmp : undefined,
  };
}

/** What a command may write, and which spots inside those areas stay read-only. */
export interface SandboxPolicy {
  /** Bound read-write, broad to specific. */
  writable: string[];
  /** Bound read-only AFTER the writable binds, to carve exceptions out of them (a missing path is skipped). */
  readOnly: string[];
  /** Directories replaced by an empty tmpfs: the places live unix sockets sit (see `MASKED_DIRS`). */
  masked: string[];
  /** Socket files replaced by /dev/null, so connecting fails (the daemon's own socket, wherever it is). */
  hidden: string[];
  /** The directory bound over /tmp so scratch files persist; absent (or missing on disk) = an empty tmpfs per command. */
  tmp?: string;
}

/**
 * Where live unix sockets are on a typical Linux desktop: the per-user runtime directory (the
 * session D-Bus, the toriel daemon's own socket, wayland, pipewire, ...) and the system D-Bus. A
 * read-only bind does NOT stop a command connecting to a socket there, and a connection is as good
 * as a write: through D-Bus a command can start anything outside the sandbox, and through the
 * daemon socket it can talk to toriel itself. Network namespaces do not help (these are
 * filesystem sockets). Abstract-namespace sockets (X11, D-Bus) are only hidden by cutting the
 * network namespace, which this sandbox does not do yet.
 */
export const MASKED_DIRS: readonly string[] = ["/run/user", "/run/dbus"];

function isDir(fsApi: FsApi, p: string): boolean {
  try {
    return fsApi.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function realOrUndefined(fsApi: FsApi, p: string): string | undefined {
  try {
    return fsApi.realpathSync(p);
  } catch {
    return undefined;
  }
}

/**
 * The git directories a command in `root` needs, and the files inside them that must stay out of
 * reach. A host-side `git` later trusts whatever it finds in these places, so a writable `hooks/`,
 * `config`, or a rewritten pointer file is a way out of the sandbox:
 *
 *  - an ordinary checkout (`root/.git` is a directory) is already inside the root, so only
 *    `hooks` and `config` are carved out read-only;
 *  - a linked worktree (`root/.git` is a file) needs the worktree's own git dir, the shared
 *    `objects/`, `refs/heads/` and `logs/` writable (the minimal set `git commit` needs), and keeps
 *    the `.git` pointer file and the git dir's `commondir`/`gitdir` pointers read-only: rewriting
 *    one would aim the host's git at a directory the agent controls.
 *
 * Anything it cannot work out yields no git paths (git then fails read-only inside the sandbox:
 * more refusing, never less).
 */
export function gitPolicy(root: string, fsApi: FsApi = defaultFs): Pick<SandboxPolicy, "writable" | "readOnly"> {
  const none: Pick<SandboxPolicy, "writable" | "readOnly"> = { writable: [], readOnly: [] };
  try {
    const dotGit = path.join(root, ".git");
    const st = fsApi.lstatSync(dotGit);
    if (st.isDirectory()) {
      return { writable: [], readOnly: [path.join(dotGit, "hooks"), path.join(dotGit, "config")] };
    }
    if (!st.isFile()) {
      return none;
    }
    const first = fsApi.readFileSync(dotGit, "utf8").split("\n")[0];
    const match = /^gitdir: (.+?)[\\/]*$/.exec(first);
    if (!match) {
      return none;
    }
    const gitdir = realOrUndefined(fsApi, path.resolve(root, match[1]));
    if (gitdir === undefined) {
      return none;
    }
    let common = gitdir;
    try {
      common = path.resolve(gitdir, fsApi.readFileSync(path.join(gitdir, "commondir"), "utf8").trim());
    } catch {
      // no commondir file: a plain git dir
    }
    const commonReal = realOrUndefined(fsApi, common);
    if (commonReal === undefined) {
      return none;
    }
    return {
      writable: [gitdir, path.join(commonReal, "objects"), path.join(commonReal, "refs", "heads"), path.join(commonReal, "logs")].filter((p) => isDir(fsApi, p)),
      readOnly: [dotGit, path.join(gitdir, "commondir"), path.join(gitdir, "gitdir"), path.join(gitdir, "config.worktree"), path.join(commonReal, "hooks"), path.join(commonReal, "config")],
    };
  } catch {
    return none;
  }
}

/**
 * Everything a command in `cfg.root` may write: the root, the resolved target of a `node_modules`
 * symlink that leaves it (the worktree layout points it at the main checkout, and writes through a
 * symlink land on the target), the git paths above, the shared directory, the static roots (caches)
 * and any `extra` paths approved for this session. Paths that do not exist are left out (bwrap
 * cannot bind them). Never throws.
 */
export function derivePolicy(cfg: Extract<SandboxConfig, { kind: "bwrap" }>, extra: readonly string[] = [], fsApi: FsApi = defaultFs): SandboxPolicy {
  const writable: string[] = [cfg.root];
  const readOnly: string[] = [];
  try {
    const nm = path.join(cfg.root, "node_modules");
    if (fsApi.lstatSync(nm).isSymbolicLink()) {
      const target = realOrUndefined(fsApi, nm);
      if (target !== undefined && isDir(fsApi, target)) {
        writable.push(target);
      }
    }
  } catch {
    // no node_modules
  }
  const git = gitPolicy(cfg.root, fsApi);
  writable.push(...git.writable);
  readOnly.push(...git.readOnly);
  for (const p of [cfg.shared, ...cfg.staticRw, ...extra]) {
    const real = p === undefined ? undefined : realOrUndefined(fsApi, p);
    if (real !== undefined && isDir(fsApi, real)) {
      writable.push(real);
    }
  }
  const masked = MASKED_DIRS.filter((d) => isDir(fsApi, d));
  // the daemon's own socket, wherever it is; a socket inside a masked directory is already gone
  const hidden = cfg.sock !== undefined && fsApi.existsSync(cfg.sock) && !masked.some((d) => cfg.sock === d || cfg.sock?.startsWith(`${d}/`)) ? [cfg.sock] : [];
  const tmp = cfg.tmp !== undefined ? realOrUndefined(fsApi, cfg.tmp) : undefined;
  return { writable: [...new Set(writable)], readOnly: [...new Set(readOnly)], masked, hidden, tmp: tmp !== undefined && isDir(fsApi, tmp) ? tmp : undefined };
}

/**
 * The bwrap arguments (before the command) for a policy: read-only view of the whole filesystem, a
 * private /dev and /proc, and a /tmp that is NOT the real one (it holds live sockets such as tmux and X11,
 * which would be a way out - board 190): the persistent daemon-owned `policy.tmp` when there is one, so files
 * survive between commands (ticket 204), else an empty tmpfs, empty tmpfs over the socket directories (`MASKED_DIRS`), the writable
 * areas, the read-only carve-outs on top, and /dev/null over the daemon's socket. No
 * --new-session or --unshare-pid: toriel kills a command through its process group and neither was
 * probed. `--die-with-parent` ends the command if the daemon-owned child goes away.
 */
export function bwrapArgs(policy: SandboxPolicy, cwd: string): string[] {
  const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", ...(policy.tmp !== undefined ? ["--bind", policy.tmp, "/tmp"] : ["--tmpfs", "/tmp"]), "--die-with-parent"];
  for (const p of policy.masked) {
    args.push("--tmpfs", p);
  }
  for (const p of policy.writable) {
    args.push("--bind", p, p);
  }
  for (const p of policy.readOnly) {
    args.push("--ro-bind-try", p, p);
  }
  for (const p of policy.hidden) {
    args.push("--ro-bind", "/dev/null", p);
  }
  args.push("--chdir", cwd);
  return args;
}

/** What to spawn for a command: `bwrap <args> bash -c <command>`. */
export interface Spawnable {
  file: string;
  args: string[];
}

/**
 * The wrapper for a child's sandbox config, or undefined when the sandbox is off. An invalid config
 * returns a wrapper that throws, so every command is refused with the reason instead of running
 * unsandboxed. The policy is derived again for each command.
 */
export function makeWrap(cfg: SandboxConfig, extra: () => readonly string[] = () => [], fsApi: FsApi = defaultFs): ((command: string, cwd: string) => Spawnable) | undefined {
  if (cfg.kind === "off") {
    return undefined;
  }
  if (cfg.kind === "invalid") {
    return () => {
      throw new Error(`sandbox: ${cfg.why}; the command was not run (it would have been unsandboxed). Fix the toriel settings or set "sandbox": "off".`);
    };
  }
  return (command, cwd) => ({ file: "bwrap", args: [...bwrapArgs(derivePolicy(cfg, extra(), fsApi), cwd), "bash", "-c", command] });
}

/** The sentence added to the bash tool's description when the sandbox is on, so the agent knows its limits. */
export function sandboxNote(cfg: SandboxConfig): string {
  if (cfg.kind !== "bwrap") {
    return "";
  }
  const shared = cfg.shared ? ` Files meant for other agents or the user go in ${cfg.shared} (also $${SHARED_DIR_ENV}).` : "";
  return `\n\nCommands run in a sandbox: the filesystem is read-only except ${cfg.root} (the working tree), the places it links to, and a few cache directories; /tmp is a scratch directory of its own, not the host's: it keeps its files between commands and is shared with the other sandboxed sessions, so name your files distinctively and put work you may need to resume there.${shared} A write elsewhere fails with "Read-only file system" - do not try to work around it, ask the user.`;
}
