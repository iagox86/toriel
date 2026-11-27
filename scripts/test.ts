// `npm test [-- node --test args]`: node --test over every test file (or the files and flags given), with the variables a
// surrounding toriel session hands down removed first (ticket 339). Output streams as node prints it; `npm run check` is the
// quiet form with a summary.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { allTestFiles, isTestFileArg, REPO_ROOT, withoutSessionEnv } from "./test-env.ts";

const args = process.argv.slice(2);
// npm runs scripts from the package root; INIT_CWD is where the user (or agent) was: resolve file arguments like scripts/check.ts does
const from = process.env.INIT_CWD ?? process.cwd();
const resolveFile = (a: string): string => {
  const own = path.resolve(from, a);
  return path.relative(REPO_ROOT, fs.existsSync(own) ? own : path.resolve(REPO_ROOT, a));
};
// flags alone (e.g. --test-name-pattern x) still run every file; any test file argument replaces the full list. A flag's value
// (--test-name-pattern=foo.ts) is not a file argument: it starts with its flag's dash.
const files = args.some(isTestFileArg) ? [] : allTestFiles();
const child = spawn(
  process.execPath,
  ["--test", ...args.map((a) => (isTestFileArg(a) ? resolveFile(a) : a)), ...files],
  { cwd: REPO_ROOT, env: withoutSessionEnv(process.env), stdio: "inherit" },
);
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
