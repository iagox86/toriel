// The pi resources toriel ships (repo pi/extensions, pi/skills) and how they
// reach a session: the daemon passes each one to its pi child as `-e` /
// `--skill`, so nothing is installed into pi's own config directory and a child
// always runs the same version as the daemon. `TORIEL_TOOLS` is the matching
// `--tools` list.
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { errText } from "./util.ts";

export const PI_RESOURCES_DIR = join(import.meta.dirname, "..", "pi");

export interface Resource {
  kind: "extension" | "skill";
  /** Path under pi/ (a file for an extension, a directory for a skill). */
  path: string;
  /** What breaks without it. */
  why: string;
  /** Tools the resource registers, if any. */
  tools?: readonly string[];
}

export const RESOURCES: readonly Resource[] = [
  { kind: "extension", path: "extensions/toriel-session-bridge.ts", why: "messages from other sessions fall back to pi's lossy steering queue" },
  { kind: "extension", path: "extensions/toriel-agents.ts", why: "the toriel_message and toriel_schedule_* tools (messaging other sessions, scheduling prompts) are missing", tools: ["toriel_message", "toriel_schedule_create", "toriel_schedule_list", "toriel_schedule_cancel"] },
  { kind: "extension", path: "extensions/toriel-usage.ts", why: "the toriel_usage tool and usage reporting are missing", tools: ["toriel_usage"] },
  { kind: "extension", path: "extensions/toriel-cache-warn.ts", why: "no warning before a prompt hits an expired prompt cache" },
  { kind: "skill", path: "skills/messaging", why: "agents are not told how to use toriel_message" },
  { kind: "skill", path: "skills/scheduling", why: "agents are not told how to use toriel_schedule_create" },
];

/** `--tools` modifiers that add toriel's tools to whatever loadout a session has or restores. */
export const TORIEL_TOOLS: readonly string[] = RESOURCES.flatMap((r) => (r.tools ?? []).map((t) => `+${t}`));

/**
 * The pi arguments that load toriel's resources. Explicit `-e` / `--skill`
 * paths still load under `--no-extensions` / `--no-skills`, so a profile that
 * switches discovery off keeps toriel's own plumbing; `skills: false` leaves
 * the skill out for a profile that wants none.
 */
export function resourceArgs(opts: { skills?: boolean } = {}, root = PI_RESOURCES_DIR): string[] {
  const args: string[] = [];
  for (const r of RESOURCES) {
    if (r.kind === "skill" && opts.skills === false) {
      continue;
    }
    args.push(r.kind === "extension" ? "-e" : "--skill", join(root, r.path));
  }
  return args;
}

/** Shipped resources missing from the repo checkout (an incomplete update). */
export function missingResources(root = PI_RESOURCES_DIR): Resource[] {
  return RESOURCES.filter((r) => !existsSync(join(root, r.path)));
}

/**
 * Leftovers of the old symlink installer in pi's agent dir: links named like our
 * resources, or pointing into the repo. pi would load them next to the flags and
 * register everything twice.
 */
export function staleInstalls(agentDir: string, root = PI_RESOURCES_DIR): string[] {
  const ours = new Set(RESOURCES.map((r) => r.path.split("/")[1]));
  const found: string[] = [];
  for (const dir of ["extensions", "skills", "themes"]) {
    let names: string[];
    try {
      names = readdirSync(join(agentDir, dir));
    } catch {
      continue;
    }
    for (const name of names) {
      const file = join(agentDir, dir, name);
      let target: string;
      try {
        if (!lstatSync(file).isSymbolicLink()) {
          continue;
        }
        target = readlinkSync(file);
      } catch {
        continue;
      }
      if (ours.has(name) || /^(toriel|ronpi)-/.test(name) || target.startsWith(root)) {
        found.push(file);
      }
    }
  }
  return found;
}

/** pi itself not being set up: no config dir (never run), or a settings.json pi would reject. */
function piSetupProblem(agentDir: string): string | undefined {
  if (!existsSync(agentDir)) {
    return `pi has no config at ${agentDir}: run pi once and log in to a provider`;
  }
  const settings = join(agentDir, "settings.json");
  if (existsSync(settings)) {
    try {
      JSON.parse(readFileSync(settings, "utf8"));
    } catch (err) {
      return `${settings} is not valid JSON (${errText(err)}); pi falls back to defaults`;
    }
  }
  return undefined;
}

const PERMISSION_PACKAGE = "pi-permission-system";

/**
 * pi-permission-system gates the tools its rules mark `ask`, and toriel shows its dialogs, but
 * it is the user's own pi package (settings.json `packages`), not something toriel ships. Without
 * it nothing asks; with it but without a readable config, it asks about everything.
 */
function permissionSystemProblem(agentDir: string): string | undefined {
  let packages: unknown[] = [];
  const file = join(agentDir, "settings.json");
  if (existsSync(file)) {
    try {
      const settings = JSON.parse(readFileSync(file, "utf8")) as { packages?: unknown };
      packages = Array.isArray(settings.packages) ? settings.packages : [];
    } catch {
      return undefined; // unreadable: piSetupProblem says so
    }
  }
  if (!packages.some((p) => JSON.stringify(p).includes(PERMISSION_PACKAGE))) {
    return `${PERMISSION_PACKAGE} is not in pi's packages (settings.json): sessions run without permission prompts`;
  }
  const config = join(agentDir, "extensions", PERMISSION_PACKAGE, "config.json");
  let why = "";
  if (!existsSync(config)) {
    why = "missing";
  } else {
    try {
      JSON.parse(readFileSync(config, "utf8"));
    } catch (err) {
      why = errText(err);
    }
  }
  return why ? `${PERMISSION_PACKAGE} has no usable config at ${config} (${why}): every tool will ask for permission` : undefined;
}

export interface AuditOptions {
  /** Check for pi-permission-system (default true; the `warnNoPermissionSystem` setting turns it off). */
  permissionSystem?: boolean;
}

/** Everything wrong with the setup, in one line for the log and the switcher notice; undefined when nothing is. */
export function describeResourceProblems(agentDir: string, root = PI_RESOURCES_DIR, opts: AuditOptions = {}): string | undefined {
  const problems: string[] = [];
  const setup = piSetupProblem(agentDir);
  if (setup) {
    problems.push(setup);
  }
  const missing = missingResources(root);
  if (missing.length > 0) {
    problems.push(`toriel files missing from ${root}: ${missing.map((r) => r.path).join(", ")} - the checkout is incomplete`);
  }
  const stale = staleInstalls(agentDir, root);
  if (stale.length > 0) {
    problems.push(`old toriel links in the pi agent dir load twice: remove them with rm ${stale.map((f) => f.replace(/ /g, "\\ ")).join(" ")}`);
  }
  const permission = opts.permissionSystem === false ? undefined : permissionSystemProblem(agentDir);
  if (permission) {
    problems.push(permission);
  }
  return problems.length > 0 ? problems.join("; ") : undefined;
}
