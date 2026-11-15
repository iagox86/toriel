// The pi packages toriel carries (ticket 230): third-party packages every environment wants, pinned in package.json and loaded into
// each pi child by flag (`-e <package directory>`, which also loads under --no-extensions), so there is nothing to `pi install` per
// machine. A package's own configuration and state stay where it keeps them in pi's config directory.
//
// Loading a package twice is a hard error in pi ("Tool ... conflicts with ..."): the session does not start. So a package the user
// installed themselves (listed in pi's settings.json `packages`) always wins and toriel's copy is left out; the setting
// `bundledPackagesOff` turns a bundled one off for every session.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { piPackageListed, projectPackageListed } from "./resources.ts";

/** The directory the dependencies are installed in (toriel's own node_modules; `TORIEL_BUNDLED_ROOT` points tests elsewhere). */
export const NODE_MODULES_DIR = process.env.TORIEL_BUNDLED_ROOT ?? join(import.meta.dirname, "..", "node_modules");

export interface BundledPackage {
  /** The npm name, as in package.json and as `packages` in pi's settings.json names it. */
  name: string;
  /** What the package gives agents, for the doctor and the docs. */
  gives: string;
  /** The tools it registers: a resumed session only gets a tool that is named in `--tools`, and a profile that owns its tool list loads the package when it names one. */
  tools: readonly string[];
  /** Only sessions without an agent profile get it (it holds the user's own state), unless a profile names one of its tools. */
  plainOnly?: boolean;
}

export const BUNDLED_PACKAGES: readonly BundledPackage[] = [
  { name: "@juicesharp/rpiv-ask-user-question", gives: "the ask_user_question tool (an agent puts you a multiple-choice question instead of guessing)", tools: ["ask_user_question"] },
  { name: "pi-web-access", gives: "web_search, fetch_content and related tools (the research-web and advisory-diff agents need them)", tools: ["web_search", "fetch_content", "get_search_content", "source_check", "web_enable"] },
  { name: "pi-hermes-memory", gives: "persistent memory tools and past-session search", tools: ["memory_add", "memory_replace", "memory_remove", "memory_search", "session_search", "skill_manage"], plainOnly: true },
];

export const BUNDLED_NAMES: readonly string[] = BUNDLED_PACKAGES.map((p) => p.name);

/** The slice of an agent profile that decides which packages it loads. */
export interface ProfileLike {
  tools?: readonly string[];
  minimal?: boolean;
}

export type PackageState =
  | "bundled" // toriel loads its own copy
  | "user" // the user installed it (pi's settings.json); toriel's copy is left out
  | "off" // switched off in the toriel settings (bundledPackagesOff)
  | "missing"; // not in node_modules: npm install has not run

export interface BundleOptions {
  /** Pi's config directory, where settings.json lists the user's own packages. */
  agentDir: string;
  /** The session's working directory: pi also reads `<cwd>/.pi/settings.json` for packages installed with `pi install -l`, and a package listed there is loaded too. */
  cwd?: string;
  /** Names switched off in the toriel settings. */
  off?: readonly string[];
  root?: string;
}

/** Whether the package is bundled for sessions in general: bundled, the user's own, switched off, or missing. */
export function packageState(pkg: BundledPackage, opts: BundleOptions): PackageState {
  if (opts.off?.includes(pkg.name)) {
    return "off";
  }
  if (piPackageListed(opts.agentDir, pkg.name) === true || (opts.cwd !== undefined && projectPackageListed(opts.cwd, pkg.name))) {
    return "user";
  }
  return existsSync(join(opts.root ?? NODE_MODULES_DIR, pkg.name)) ? "bundled" : "missing";
}

/** Whether a session with `agent` (undefined = a plain session) loads the package. */
export function loadsFor(pkg: BundledPackage, agent: ProfileLike | undefined): boolean {
  if (agent === undefined) {
    return true;
  }
  if (agent.tools !== undefined) {
    // the profile owns its tool list: the package is worth loading only when it names one of its tools
    return agent.tools.some((t) => pkg.tools.includes(t));
  }
  return !agent.minimal && pkg.plainOnly !== true;
}

/** The packages a session starts with: bundled, enabled and wanted by its profile. */
export function packagesFor(agent: ProfileLike | undefined, opts: BundleOptions): BundledPackage[] {
  return BUNDLED_PACKAGES.filter((p) => packageState(p, opts) === "bundled" && loadsFor(p, agent));
}

/** The pi arguments that load them (`-e <directory>`). */
export function bundledArgs(agent: ProfileLike | undefined, opts: BundleOptions): string[] {
  return packagesFor(agent, opts).flatMap((p) => ["-e", join(opts.root ?? NODE_MODULES_DIR, p.name)]);
}

/** The `--tools` entries (`+name`) for what the loaded packages register, so a resumed session offers them too. */
export function bundledTools(agent: ProfileLike | undefined, opts: BundleOptions): string[] {
  return packagesFor(agent, opts).flatMap((p) => p.tools.map((t) => `+${t}`));
}
