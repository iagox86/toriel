// `toriel doctor [--fix] [--yes]`: the setup report on the command line. It has to work when node
// or the dependencies are missing, so it imports only node modules and preflight.ts statically and
// loads doctor.ts (which needs the dependencies) once the preflight checks have passed.
import { createInterface } from "node:readline/promises";
import type { DoctorOptions } from "./doctor.ts";
import { startupProblems } from "./preflight.ts";

export const DOCTOR_USAGE = `usage: toriel doctor [--fix] [--yes]

Checks what toriel needs and prints what is wrong, with the fix for each.
  --fix        apply the fixes that are safe to automate: edits to pi-permission-system's
               config.json, shown as a diff first, the original kept as config.json.bak-<time>
  -y, --yes    with --fix: apply without asking
Exits 1 when something required is wrong (toriel will not work), else 0. Inside toriel, /doctor
shows the same report. It never installs packages and never writes a policy of its own.`;

export interface DoctorIo {
  write(text: string): void;
  /** Ask a yes/no question; false when nobody can answer. */
  confirm(question: string): Promise<boolean>;
  /** Whether a person is at the terminal (otherwise --fix needs --yes). */
  interactive: boolean;
}

/** The terminal as the real command uses it. */
export function realIo(): DoctorIo {
  return {
    write: (text) => void process.stdout.write(text),
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    confirm: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return /^y(es)?$/i.test((await rl.question(question)).trim());
      } finally {
        rl.close();
      }
    },
  };
}

/** Run the command; returns the exit code. `opts` lets tests point it at a temporary setup. */
export async function doctorMain(args: readonly string[], io: DoctorIo, opts: DoctorOptions = {}): Promise<number> {
  const known = new Set(["--fix", "--yes", "-y", "--help", "-h"]);
  const unknown = args.find((a) => !known.has(a));
  if (unknown !== undefined) {
    io.write(`toriel doctor: unknown argument "${unknown}"\n${DOCTOR_USAGE}\n`);
    return 2;
  }
  if (args.includes("--help") || args.includes("-h")) {
    io.write(`${DOCTOR_USAGE}\n`);
    return 0;
  }
  const early = opts.startup ?? startupProblems();
  if (early.length > 0) {
    io.write(`toriel doctor\n\nRequired (toriel does not work without these)\n${early.map((p) => `  PROBLEM  ${p}`).join("\n")}\n\nFix these first; the other checks need them.\n`);
    return 1;
  }
  const doctor = await import("./doctor.ts");
  const options = { ...opts, startup: [] };
  const checks = doctor.runDoctor(options);
  io.write(`${doctor.renderDoctor(checks)}\n`);
  if (!args.includes("--fix")) {
    return doctor.exitCode(checks);
  }
  const plan = doctor.plannedFixes(checks);
  if (plan.length === 0) {
    io.write("\nNothing here can be fixed automatically.\n");
    return doctor.exitCode(checks);
  }
  const yes = args.includes("--yes") || args.includes("-y");
  for (const { file, fixes } of plan) {
    io.write(`\n${file}\n${fixes.map((f) => `  - ${f.summary}`).join("\n")}\n`);
    try {
      io.write(`${doctor.previewFixes(file, fixes)}\n`);
    } catch (err) {
      io.write(`  cannot change this file: ${err instanceof Error ? err.message : err}\n`);
      continue;
    }
    if (!yes && !io.interactive) {
      io.write("Not applied: nobody is at the terminal to confirm (pass --yes to apply).\n");
      continue;
    }
    if (!yes && !(await io.confirm(`Apply this to ${file}? The original is kept. [y/N] `))) {
      io.write("Not applied.\n");
      continue;
    }
    io.write(`Applied. The original is at ${doctor.applyFixes(file, fixes)}\n`);
  }
  const after = doctor.runDoctor(options);
  io.write(`\nAfter fixing:\n\n${doctor.renderDoctor(after)}\n`);
  return doctor.exitCode(after);
}
