// `npm test [-- node --test args]`: node --test over every test file (or the files and flags given), with the variables a
// surrounding toriel session hands down removed first (ticket 339). Output streams as node prints it; `npm run check` is the
// quiet form with a summary.
import { spawn } from "node:child_process";
import { allTestFiles, fileArgFrom, isTestFileArg, REPO_ROOT, resolveFileArg, withoutSessionEnv } from "./test-env.ts";

const args = process.argv.slice(2);
// npm runs scripts from the package root; INIT_CWD is where the user (or agent) was: resolve file arguments like scripts/check.ts does
const from = fileArgFrom(process.env, process.cwd());
// flags alone (e.g. --test-name-pattern x) still run every file; any test file argument replaces the full list. A flag's value is
// not a file argument: it starts with its dash (--test-name-pattern=foo.ts), or follows a flag that consumes it (--test-name-pattern foo.ts).
const isFile = (a: string, i: number): boolean => isTestFileArg(a, args[i - 1]);
const files = args.some(isFile) ? [] : allTestFiles();
const child = spawn(
  process.execPath,
  ["--test", ...args.map((a, i) => (isFile(a, i) ? resolveFileArg(a, from) : a)), ...files],
  { cwd: REPO_ROOT, env: withoutSessionEnv(process.env), stdio: "inherit" },
);
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
