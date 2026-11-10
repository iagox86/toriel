// Checks that run before toriel loads anything else, so a bad setup stops with
// one clear line instead of a stack trace (a missing dependency fails while
// modules are linked, before any code of ours runs). Imports only node: modules
// for that reason; toriel.ts imports this statically and the rest dynamically.
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const DEPENDENCIES = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "commander"];

/** True when dotted version a is older than dotted version b, compared element-wise. */
function versionLess(a: string, b: string): boolean {
  const av = a.split(".").map(Number);
  const bv = b.split(".").map(Number);
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    const x = av[i] ?? 0;
    const y = bv[i] ?? 0;
    if (x !== y) {
      return x < y;
    }
  }
  return false;
}

/** What is wrong with the environment toriel is about to start in; empty when it is fine. */
export function startupProblems(env: NodeJS.ProcessEnv = process.env, nodeVersion = process.versions.node, root = ROOT): string[] {
  const problems: string[] = [];
  let want = "";
  try {
    want = readFileSync(join(root, ".nvmrc"), "utf8").trim().replace(/^v/, "");
  } catch {
    // no pin: nothing to compare
  }
  if (want && versionLess(nodeVersion, want)) {
    problems.push(`node ${nodeVersion} is too old: toriel needs node ${want} or newer (nvm install ${want.split(".")[0]}, or start it with bin/toriel, which finds it)`);
  }
  const missing = DEPENDENCIES.filter((d) => !existsSync(join(root, "node_modules", d)));
  if (missing.length > 0) {
    problems.push(`dependencies are not installed (${missing.join(", ")}): run npm install in ${root}`);
  }
  if (!env.TORIEL_SOCK && !env.XDG_RUNTIME_DIR) {
    problems.push("XDG_RUNTIME_DIR is not set, so there is no private directory for the daemon socket: set it, or set TORIEL_SOCK to a path in a private (0700) directory");
  }
  if (env.TORIEL_PROFILE && !/^[A-Za-z0-9._-]+$/.test(env.TORIEL_PROFILE)) {
    problems.push(`TORIEL_PROFILE "${env.TORIEL_PROFILE}" is not a usable name: use letters, digits, dot, dash and underscore`);
  }
  return problems;
}

const USAGE = `usage: toriel              open the switcher (starts the daemon if needed)
       toriel doctor       check the setup and say how to fix what is wrong (--fix applies the safe fixes)
       toriel kill-server  stop the daemon and every session it owns

       toriel --isolated [name] [doctor|kill-server]
                           run a separate instance (own daemon, socket, data and log) for trying out
                           a branch without touching the real one; the name defaults to the checkout's folder name`;

/**
 * Take `--isolated [name]` off the arguments and turn it into TORIEL_PROFILE, which config.ts reads. Done here, before
 * anything imports config.ts, so the daemon it starts inherits it too. The name is optional: the next argument is one
 * unless it is a subcommand or another option.
 */
export function applyIsolated(argv: string[], env: NodeJS.ProcessEnv = process.env, root = ROOT): void {
  const at = argv.indexOf("--isolated", 2);
  if (at === -1) {
    return;
  }
  const next = argv[at + 1];
  const named = next !== undefined && !next.startsWith("-") && next !== "doctor" && next !== "kill-server";
  argv.splice(at, named ? 2 : 1);
  env.TORIEL_PROFILE = named ? next : basename(root).replace(/[^A-Za-z0-9._-]/g, "-");
}

/** Exit with a message when the setup or the arguments are wrong. */
export function preflight(argv: string[] = process.argv): void {
  applyIsolated(argv);
  const arg = argv[2];
  if (arg === "--help" || arg === "-h") {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  if (arg !== undefined && arg !== "kill-server" && arg !== "doctor") {
    process.stderr.write(`toriel: unknown argument "${arg}"\n${USAGE}\n`);
    process.exit(2);
  }
  if (arg === "kill-server" || arg === "doctor") {
    return; // doctor runs its own checks, so it can say what is wrong instead of stopping at the first thing
  }
  const problems = startupProblems();
  if (problems.length > 0) {
    process.stderr.write(`${problems.map((p) => `toriel: ${p}`).join("\n")}\n`);
    process.exit(1);
  }
}
