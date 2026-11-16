// `toriel update [status|all|<name>...] [--refresh] [--no-test]` (ticket 75): the report, and the scripted bump.
import { execFile } from "node:child_process";
import { join } from "node:path";
import { piAgentDir } from "./pi-dir.ts";
import { type Component, type Fetcher, type Runner, applyUpdates, cacheFile, collect, isBehind, renderReport, withLatest } from "./updates.ts";

export const UPDATE_USAGE = `usage: toriel update [status | all | <name>...] [--refresh] [--no-test]

  status (default)  what is installed and what npm has: pi, the bundled packages, your own pi packages
  all               bump everything of toriel's own that is behind
  <name>...         bump those (\`pi\`, or a bundled package's npm name)
  --refresh         ask npm again instead of using the answer cached for a day
  --no-test         skip typecheck and the tests after a bump (they are what catch a bad one)

A bump is \`npm install --save-exact\` in toriel's checkout, then typecheck and the tests; if either fails,
package.json and the lockfile are put back. It never touches your own pi packages (\`pi update\` does that)
and never changes a running session: restart toriel (\`toriel kill-server\`) to pick the new code up.`;

export interface UpdateIo {
  write(text: string): void;
}

export interface UpdateEnv {
  root: string;
  agentDir: string;
  globalRoot?: string;
  fetcher?: Fetcher;
  cache?: string;
  runner: Runner;
  cwd?: string;
}

/** Run a command, capturing the combined output. */
export const realRunner: Runner = {
  run: (cmd, args, cwd) =>
    new Promise((resolve) => {
      execFile(cmd, [...args], { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        const code = err === null ? 0 : typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1;
        resolve({ code, output: `${stdout}${stderr}` });
      });
    }),
};

export async function realEnv(): Promise<UpdateEnv> {
  const root = join(import.meta.dirname, "..");
  const globalRoot = (await realRunner.run("npm", ["root", "-g"], root)).output.trim();
  return { root, agentDir: piAgentDir(), globalRoot: globalRoot === "" ? undefined : globalRoot, cache: cacheFile(), runner: realRunner, cwd: process.cwd() };
}

export async function updateMain(args: readonly string[], io: UpdateIo, env: UpdateEnv): Promise<number> {
  const flags = new Set(args.filter((a) => a.startsWith("-")));
  const words = args.filter((a) => !a.startsWith("-"));
  const bad = [...flags].find((f) => !["--refresh", "--no-test", "--help", "-h"].includes(f));
  if (bad !== undefined) {
    io.write(`toriel update: unknown option "${bad}"\n${UPDATE_USAGE}\n`);
    return 2;
  }
  if (flags.has("--help") || flags.has("-h")) {
    io.write(`${UPDATE_USAGE}\n`);
    return 0;
  }
  const components = await withLatest(collect({ root: env.root, agentDir: env.agentDir, globalRoot: env.globalRoot, cwd: env.cwd }), {
    fetcher: env.fetcher,
    cache: env.cache,
    refresh: flags.has("--refresh"),
  });
  if (words.length === 0 || (words.length === 1 && words[0] === "status")) {
    io.write(`${renderReport(components)}\n`);
    return 0;
  }
  const own = components.filter((c) => c.kind !== "user");
  let chosen: Component[];
  if (words.length === 1 && words[0] === "all") {
    chosen = own.filter(isBehind);
  } else {
    const unknown = words.filter((w) => !own.some((c) => c.name === w));
    if (unknown.length > 0) {
      const user = components.find((c) => c.kind === "user" && unknown.includes(c.name));
      io.write(user ? `toriel update: ${user.name} is your own pi package: update it with \`pi update\`\n` : `toriel update: no such component "${unknown.join('", "')}" (try \`toriel update status\`)\n`);
      return 2;
    }
    chosen = own.filter((c) => words.includes(c.name));
    const unknownLatest = chosen.find((c) => c.latest === undefined);
    if (unknownLatest !== undefined) {
      io.write(`toriel update: ${unknownLatest.name}: ${unknownLatest.problem ?? "npm's latest version is unknown"}\n`);
      return 1;
    }
    const current = chosen.filter((c) => !isBehind(c));
    if (current.length > 0) {
      io.write(`${current.map((c) => c.name).join(", ")}: already up to date\n`);
    }
    chosen = chosen.filter(isBehind);
  }
  if (chosen.length === 0) {
    io.write("nothing to update\n");
    return 0;
  }
  return applyUpdates(chosen, { root: env.root, runner: env.runner, noTest: flags.has("--no-test"), write: io.write });
}
