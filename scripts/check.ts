// `npm run check [-- options] [test files...]` (ticket 340): typecheck, lint and the tests in one command, so agents need one
// permission grant and no wrappers. It runs from the repo it lives in (no cd needed), drops the variables a surrounding toriel
// session hands down (no env -u needed), serializes test runs across worktrees with its own lock (no flock needed), writes
// everything to .toriel-check.log in the repo root, and prints only a summary. Exit status: 0 when every step passed.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { chooseSteps, type LockOwner, lockIsStale, pickLines, type Step, type TestSummary, testSummaryLines } from "./check-lib.ts";
import { allTestFiles, REPO_ROOT, withoutSessionEnv } from "./test-env.ts";

const HELP = `usage: npm run check [-- [--typecheck] [--lint] [--tests] [--name <pattern>] [test files...]]

  no arguments       typecheck, lint and every test
  test files         only those tests (paths relative to where you ran npm, or to the repo)
  --name <pattern>   only the tests whose name matches (node --test --test-name-pattern)
  --typecheck/--lint/--tests   only the steps named

The full output goes to .toriel-check.log in the repo root; the summary names failures and the log path.
Test runs from different worktrees take turns (a lock in ~/.cache/toriel), so no flock is needed.`;

const LOG = path.join(REPO_ROOT, ".toriel-check.log");
const SUMMARY = path.join(REPO_ROOT, ".toriel-check-summary.log");
const LOCK = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "toriel", "check.lock");

function parse(): { steps: Step[]; files: string[]; name?: string } | undefined {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { typecheck: { type: "boolean" }, lint: { type: "boolean" }, tests: { type: "boolean" }, name: { type: "string" }, help: { type: "boolean", short: "h" } },
  });
  if (values.help) {
    console.log(HELP);
    return undefined;
  }
  // npm runs scripts from the package root; INIT_CWD is where the user (or agent) was
  const from = process.env.INIT_CWD ?? process.cwd();
  const files = positionals.map((f) => {
    const own = path.resolve(from, f);
    return path.relative(REPO_ROOT, fs.existsSync(own) ? own : path.resolve(REPO_ROOT, f));
  });
  for (const f of files) {
    if (!fs.existsSync(path.join(REPO_ROOT, f))) {
      throw new Error(`no such test file: ${f}`);
    }
  }
  return { steps: chooseSteps(values, files, values.name), files, name: values.name };
}

/** Run `cmd` in the repo with the clean env, appending its output to the log; resolves with the exit code and the output. */
function run(cmd: string, args: string[], log: fs.WriteStream): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    log.write(`\n$ ${[cmd, ...args].join(" ")}\n`);
    const child = spawn(cmd, args, { cwd: REPO_ROOT, env: withoutSessionEnv(process.env) });
    let output = "";
    const take = (chunk: Buffer): void => {
      output += chunk.toString();
      log.write(chunk);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (err) => {
      take(Buffer.from(`${err.message}\n`));
      resolve({ code: 1, output });
    });
    child.on("close", (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), output }));
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readOwner(): LockOwner | undefined {
  try {
    return JSON.parse(fs.readFileSync(LOCK, "utf8")) as LockOwner;
  } catch {
    return undefined;
  }
}

/** Take the machine-wide test lock, waiting (and saying so once) while another run holds it. */
async function lock(): Promise<() => void> {
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  let told = false;
  for (;;) {
    try {
      fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, root: REPO_ROOT, startedAt: Date.now() } satisfies LockOwner), { flag: "wx" });
      const release = (): void => {
        if (readOwner()?.pid === process.pid) {
          fs.rmSync(LOCK, { force: true });
        }
      };
      process.on("exit", release);
      for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
        process.on(sig, () => {
          release();
          process.exit(130);
        });
      }
      return release;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
    }
    const owner = readOwner();
    if (lockIsStale(owner, alive, Date.now())) {
      fs.rmSync(LOCK, { force: true });
      continue;
    }
    if (!told && owner) {
      console.log(`waiting for another test run to finish (pid ${owner.pid}, ${owner.root})`);
      told = true;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function tests(args: { files: string[]; name?: string }, log: fs.WriteStream): Promise<boolean> {
  const release = await lock();
  const started = Date.now();
  fs.rmSync(SUMMARY, { force: true });
  const files = args.files.length > 0 ? args.files : allTestFiles();
  const nodeArgs = [
    "--test",
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    `--test-reporter=${path.join(REPO_ROOT, "scripts", "check-reporter.ts")}`,
    `--test-reporter-destination=${SUMMARY}`,
    ...(args.name !== undefined ? ["--test-name-pattern", args.name] : []),
    ...files,
  ];
  const { code } = await run(process.execPath, nodeArgs, log);
  release();
  let summary: TestSummary = { passed: 0, failed: 0, skipped: 0, failures: [] };
  try {
    summary = JSON.parse(fs.readFileSync(SUMMARY, "utf8")) as TestSummary;
  } catch {
    // no summary: the runner died before its end; the exit code and the log say what happened
  }
  fs.rmSync(SUMMARY, { force: true });
  const lines = testSummaryLines(summary, code, Math.round((Date.now() - started) / 1000));
  console.log(lines.join("\n"));
  return code === 0 && summary.failed === 0;
}

async function main(): Promise<number> {
  const args = parse();
  if (!args) {
    return 0;
  }
  const log = fs.createWriteStream(LOG);
  log.write(`npm run check: ${args.steps.join(", ")} in ${REPO_ROOT} at ${new Date().toISOString()}\n`);
  let ok = true;
  const bin = (name: string): string => path.join(REPO_ROOT, "node_modules", ".bin", name);
  for (const step of args.steps) {
    if (step === "typecheck") {
      const r = await run(bin("tsc"), ["-p", "."], log);
      console.log(`typecheck: ${r.code === 0 ? "ok" : "FAILED"}`);
      if (r.code !== 0) {
        ok = false;
        for (const l of pickLines(r.output, /error TS\d+/)) {
          console.log(`  ${l}`);
        }
      }
    } else if (step === "lint") {
      const r = await run(bin("biome"), ["lint", "--colors=off", "."], log);
      console.log(`lint: ${r.code === 0 ? "ok" : "FAILED"}`);
      if (r.code !== 0) {
        ok = false;
        for (const l of pickLines(r.output, /^\S+:\d+:\d+ /)) {
          console.log(`  ${l}`);
        }
      }
    } else if (!(await tests(args, log))) {
      ok = false;
    }
  }
  await new Promise<void>((r) => log.end(r));
  console.log(`log: ${LOG}`);
  return ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`npm run check: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  },
);
