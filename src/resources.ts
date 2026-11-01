// The pi resources toriel ships (repo pi/extensions, pi/skills) and how they
// reach a session: the daemon passes each one to its pi child as `-e` /
// `--skill`, so nothing is installed into pi's own config directory and a child
// always runs the same version as the daemon. `TORIEL_TOOLS` is the matching
// `--tools` list.
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { PERMISSIONS_FILE } from "./config.ts";
import { errText } from "./util.ts";

export const PI_RESOURCES_DIR = join(import.meta.dirname, "..", "pi");

/**
 * How much a problem matters. required: toriel will not work. recommended: it works but sessions run
 * unguarded or ask about everything. feature: only matters if you use that feature. hardening: makes
 * tampering harder; no feature needs it. The start-up notice shows the first two; `toriel doctor` shows all.
 */
export type Level = "required" | "recommended" | "feature" | "hardening";

/** An edit `doctor --fix` can make to a JSON config file. Pure, so it can be previewed before it is written. */
export interface Fix {
  file: string;
  summary: string;
  edit(config: Record<string, unknown>): Record<string, unknown>;
}

/** One thing wrong with the setup. `id` names a check in the doctor catalog (src/doctor.ts); `message` says how to fix it. */
export interface Finding {
  id: string;
  level: Level;
  message: string;
  fix?: Fix;
}

export interface Resource {
  kind: "extension" | "skill";
  /** Path under pi/ (a file for an extension, a directory for a skill). */
  path: string;
  /** What breaks without it. */
  why: string;
  /** Tools the resource registers, if any. */
  tools?: readonly string[];
}

// A resource that needs setup beyond shipping (a config line, a package) also needs a doctor check: see src/doctor.ts.
export const RESOURCES: readonly Resource[] = [
  { kind: "extension", path: "extensions/toriel-session-bridge.ts", why: "messages from other sessions fall back to pi's lossy steering queue" },
  { kind: "extension", path: "extensions/toriel-agents.ts", why: "the toriel_message and toriel_schedule_* tools (messaging other sessions, scheduling prompts) are missing", tools: ["toriel_message", "toriel_schedule_create", "toriel_schedule_list", "toriel_schedule_cancel"] },
  { kind: "extension", path: "extensions/toriel-grants.ts", why: "permission grants (/permissions) have no effect: every ask opens its dialog" },
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

/** The `path` rules of the permission package's config, in file order, with `~` expanded. */
function pathRules(config: unknown): Array<[string, string]> {
  const path = (config as { permission?: { path?: unknown } } | null)?.permission?.path;
  if (typeof path !== "object" || path === null || Array.isArray(path)) {
    return [];
  }
  return Object.entries(path as Record<string, unknown>).flatMap(([pattern, rule]) => {
    const action = typeof rule === "string" ? rule : (rule as { action?: unknown } | null)?.action;
    return typeof action === "string" ? [[pattern.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"), action] as [string, string]] : [];
  });
}

/** What the package's `path` rules (last match wins, `*` crosses directories) say about `file`; undefined when none matches. */
export function pathAction(config: unknown, file: string): string | undefined {
  let action: string | undefined;
  for (const [pattern, a] of pathRules(config)) {
    const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
    if (re.test(file)) {
      action = a;
    }
  }
  return action;
}

const GRANTS_LINK = "toriel-grants";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The grants file as a config rule names it: `~/...` under the home directory (pathAction expands it), else absolute. */
export function shownPath(file: string): string {
  const home = process.env.HOME;
  return home && file.startsWith(`${home}/`) ? `~${file.slice(home.length)}` : file;
}

/**
 * toriel's permission grants (docs/permissions.md) need two lines in the permission package's
 * config: the chain names the toriel-grants link (without it every ask still opens its dialog),
 * and a `path` rule makes writes to the grants file ask, since the file is a stored "yes". Each
 * finding carries a fix `toriel doctor --fix` can apply when the config has the usual shape.
 */
function grantsFindings(agentDir: string, grantsFile: string): Finding[] {
  const file = join(agentDir, "extensions", PERMISSION_PACKAGE, "config.json");
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return []; // missing or broken: permissionSystemProblem says so
  }
  if (!isObject(json)) {
    return [];
  }
  const findings: Finding[] = [];
  const chain = json.authorizerChain;
  if (!(Array.isArray(chain) && chain.includes(GRANTS_LINK))) {
    findings.push({
      id: "grants-chain",
      level: "feature",
      message: `permission grants are inactive: add "${GRANTS_LINK}" to "authorizerChain" in ${file} (for example "authorizerChain": ["${GRANTS_LINK}"])`,
      fix:
        chain === undefined || Array.isArray(chain)
          ? { file, summary: `add "${GRANTS_LINK}" to "authorizerChain"`, edit: (c) => ({ ...c, authorizerChain: [...(Array.isArray(c.authorizerChain) ? c.authorizerChain : []), GRANTS_LINK] }) }
          : undefined,
    });
  }
  const action = pathAction(json, grantsFile);
  if (action !== "ask" && action !== "deny") {
    const shown = shownPath(grantsFile);
    const permission = json.permission;
    const fixable = (permission === undefined || isObject(permission)) && (!isObject(permission) || permission.path === undefined || isObject(permission.path));
    findings.push({
      id: "grants-path-rule",
      level: "hardening",
      message: `nothing stops an agent editing the permission grants file: add "${shown}": "ask" to the "permission" > "path" rules in ${file}, after a "*": "allow" entry (it matches later rules last)`,
      fix: fixable
        ? {
            file,
            summary: `make writes to ${shown} ask first`,
            edit: (c) => {
              const perm = isObject(c.permission) ? c.permission : {};
              const path = isObject(perm.path) ? perm.path : { "*": "allow" };
              const others = Object.entries(path).filter(([key]) => key !== shown && key !== grantsFile);
              return { ...c, permission: { ...perm, path: { ...Object.fromEntries(others), [shown]: "ask" } } };
            },
          }
        : undefined,
    });
  }
  return findings;
}

export interface AuditOptions {
  /** Check for pi-permission-system (default true; the `warnNoPermissionSystem` setting turns it off at start-up). */
  permissionSystem?: boolean;
  /** Where toriel keeps permission grants (default PERMISSIONS_FILE). */
  grantsFile?: string;
}

/** Everything wrong with the setup that the resource audit can see, graded. `toriel doctor` adds what needs the settings and the environment. */
export function auditFindings(agentDir: string, root = PI_RESOURCES_DIR, opts: AuditOptions = {}): Finding[] {
  const out: Finding[] = [];
  const setup = piSetupProblem(agentDir);
  if (setup) {
    out.push({ id: "pi-setup", level: "required", message: setup });
  }
  const missing = missingResources(root);
  if (missing.length > 0) {
    out.push({ id: "toriel-files", level: "required", message: `toriel files missing from ${root}: ${missing.map((r) => r.path).join(", ")} - the checkout is incomplete` });
  }
  const stale = staleInstalls(agentDir, root);
  if (stale.length > 0) {
    out.push({ id: "stale-links", level: "required", message: `old toriel links in the pi agent dir load twice: remove them with rm ${stale.map((f) => f.replace(/ /g, "\\ ")).join(" ")}` });
  }
  if (opts.permissionSystem !== false) {
    const permission = permissionSystemProblem(agentDir);
    if (permission) {
      out.push({ id: "permission-package", level: "recommended", message: permission });
    } else {
      out.push(...grantsFindings(agentDir, opts.grantsFile ?? PERMISSIONS_FILE));
    }
  }
  return out;
}

/**
 * One line for the start-up notice: the required and recommended problems in full, then how many
 * lesser ones `/doctor` lists. Undefined when there is nothing to say.
 */
export function summarizeFindings(findings: readonly Finding[]): string | undefined {
  const shown = findings.filter((f) => f.level === "required" || f.level === "recommended");
  const more = findings.length - shown.length;
  const parts = shown.map((f) => f.message);
  if (more > 0) {
    parts.push(`${more} suggestion${more === 1 ? "" : "s"}: /doctor lists them`);
  }
  return parts.length > 0 ? parts.join("; ") : undefined;
}

/** The audit as a start-up notice line (see summarizeFindings). */
export function describeResourceProblems(agentDir: string, root = PI_RESOURCES_DIR, opts: AuditOptions = {}): string | undefined {
  return summarizeFindings(auditFindings(agentDir, root, opts));
}
