// `npm test [-- node --test args]`: node --test over every test file (or the files and flags given), with the variables a
// surrounding toriel session hands down removed first (ticket 339). Output streams as node prints it; `npm run check` is the
// quiet form with a summary.
import { spawn } from "node:child_process";
import { allTestFiles, REPO_ROOT, withoutSessionEnv } from "./test-env.ts";

const args = process.argv.slice(2);
// flags alone (e.g. --test-name-pattern x) still run every file; any test file argument replaces the full list
const files = args.some((a) => /\.(test\.)?[cm]?[jt]s$/.test(a)) ? [] : allTestFiles();
const child = spawn(process.execPath, ["--test", ...args, ...files], { cwd: REPO_ROOT, env: withoutSessionEnv(process.env), stdio: "inherit" });
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
