// Checks that run before toriel loads anything else, so a bad setup stops with
// one clear line instead of a stack trace (a missing dependency fails while
// modules are linked, before any code of ours runs). Imports only node: modules
// for that reason; toriel.ts imports this statically and the rest dynamically.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const DEPENDENCIES = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "commander"];

/** What is wrong with the environment toriel is about to start in; empty when it is fine. */
export function startupProblems(env: NodeJS.ProcessEnv = process.env, nodeVersion = process.versions.node, root = ROOT): string[] {
  const problems: string[] = [];
  let want = "";
  try {
    want = readFileSync(join(root, ".nvmrc"), "utf8").trim().replace(/^v/, "");
  } catch {
    // no pin: nothing to compare
  }
  if (want && Number(nodeVersion.split(".")[0]) < Number(want.split(".")[0])) {
    problems.push(`node ${nodeVersion} is too old: toriel needs node ${want.split(".")[0]} or newer (nvm install ${want.split(".")[0]}, or start it with bin/toriel, which finds it)`);
  }
  const missing = DEPENDENCIES.filter((d) => !existsSync(join(root, "node_modules", d)));
  if (missing.length > 0) {
    problems.push(`dependencies are not installed (${missing.join(", ")}): run npm install in ${root}`);
  }
  if (!env.TORIEL_SOCK && !env.XDG_RUNTIME_DIR) {
    problems.push("XDG_RUNTIME_DIR is not set, so there is no private directory for the daemon socket: set it, or set TORIEL_SOCK to a path in a private (0700) directory");
  }
  return problems;
}

const USAGE = `usage: toriel              open the switcher (starts the daemon if needed)
       toriel kill-server  stop the daemon and every session it owns`;

/** Exit with a message when the setup or the arguments are wrong. */
export function preflight(argv: readonly string[] = process.argv): void {
  const arg = argv[2];
  if (arg === "--help" || arg === "-h") {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  if (arg !== undefined && arg !== "kill-server") {
    process.stderr.write(`toriel: unknown argument "${arg}"\n${USAGE}\n`);
    process.exit(2);
  }
  if (arg === "kill-server") {
    return;
  }
  const problems = startupProblems();
  if (problems.length > 0) {
    process.stderr.write(`${problems.map((p) => `toriel: ${p}`).join("\n")}\n`);
    process.exit(1);
  }
}
