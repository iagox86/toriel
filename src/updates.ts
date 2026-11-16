// Update awareness (ticket 75): what is installed, what npm has, and a scripted bump. Three kinds of thing can be behind:
//   - pi itself (pi-coding-agent and pi-tui, which move together), the copy in toriel's own node_modules, not a global `pi`;
//   - the bundled packages (bundled-packages.ts), pinned in package.json;
//   - the user's own pi packages (settings.json `packages`), which pi installs and `pi update` updates: reported, never touched here.
// Nothing runs at startup: the registry is asked only when the user asks (`toriel update`), and the answer is cached for a day.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BUNDLED_PACKAGES } from "./bundled-packages.ts";
import { piPackageListed, projectPackageListed } from "./resources.ts";

export const PI_PACKAGES: readonly string[] = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"];

export type ComponentKind = "pi" | "bundled" | "user";

export interface Component {
  kind: ComponentKind;
  /** What the user types: "pi" or the npm name. */
  name: string;
  /** The npm packages that move together (pi is two). */
  packages: readonly string[];
  /** The version in package.json (bundled and pi). */
  pinned?: string;
  /** The version on disk. */
  installed?: string;
  /** Bundled only: the user's own pi settings list the package too, so toriel leaves its copy out and the pin is not what runs (#71). */
  shadowed?: boolean;
  /** Bundled and shadowed: the version of the user's own copy, the one that runs (when it can be found). */
  runs?: string;
  /** User packages only: where pi keeps it, for the user. */
  spec?: string;
  /** What npm says is newest; filled by `withLatest`. */
  latest?: string;
  /** Why latest is unknown. */
  problem?: string;
}

export interface CollectOptions {
  /** toriel's checkout (package.json, node_modules). */
  root: string;
  /** pi's config directory. */
  agentDir: string;
  /** The global node_modules where pi installs the user's packages (`npm root -g`); undefined when unknown. */
  globalRoot?: string;
  cwd?: string;
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function installedVersion(dir: string, name: string): string | undefined {
  return readJson<{ version?: string }>(join(dir, name, "package.json"))?.version;
}

/** The npm package name inside a `packages` entry ("npm:name", "npm:name@1.2.3", an object with `source`), or undefined for a git or path entry. */
export function npmNameOf(entry: unknown): string | undefined {
  const spec = typeof entry === "string" ? entry : typeof (entry as { source?: unknown })?.source === "string" ? (entry as { source: string }).source : undefined;
  if (spec === undefined || !spec.startsWith("npm:")) {
    return undefined;
  }
  const rest = spec.slice(4);
  const at = rest.indexOf("@", 1);
  return at === -1 ? rest : rest.slice(0, at);
}

export function collect(opts: CollectOptions): Component[] {
  const pkg = readJson<{ dependencies?: Record<string, string> }>(join(opts.root, "package.json"));
  const deps = pkg?.dependencies ?? {};
  const modules = join(opts.root, "node_modules");
  const out: Component[] = [
    { kind: "pi", name: "pi", packages: PI_PACKAGES, pinned: deps[PI_PACKAGES[0] as string], installed: installedVersion(modules, PI_PACKAGES[0] as string) },
  ];
  const bundled = new Set<string>();
  for (const b of BUNDLED_PACKAGES) {
    bundled.add(b.name);
    const shadowed = piPackageListed(opts.agentDir, b.name) === true || (opts.cwd !== undefined && projectPackageListed(opts.cwd, b.name));
    out.push({
      kind: "bundled",
      name: b.name,
      packages: [b.name],
      pinned: deps[b.name],
      installed: installedVersion(modules, b.name),
      shadowed,
      runs: shadowed && opts.globalRoot !== undefined ? installedVersion(opts.globalRoot, b.name) : undefined,
    });
  }
  const settings = readJson<{ packages?: unknown }>(join(opts.agentDir, "settings.json"));
  for (const entry of Array.isArray(settings?.packages) ? settings.packages : []) {
    const name = npmNameOf(entry);
    if (name === undefined || bundled.has(name)) {
      continue;
    }
    out.push({
      kind: "user",
      name,
      packages: [name],
      spec: typeof entry === "string" ? entry : JSON.stringify(entry),
      installed: opts.globalRoot === undefined ? undefined : installedVersion(opts.globalRoot, name),
    });
  }
  return out;
}

/** Compare dotted versions numerically; a prerelease sorts below its release. Enough for "is latest newer than installed". */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { nums: number[]; pre: boolean } => {
    const [core = "", pre] = v.replace(/^[v^~=]/, "").split(/[-+]/, 2);
    return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre: pre !== undefined && v.includes("-") };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) {
      return d < 0 ? -1 : 1;
    }
  }
  return x.pre === y.pre ? 0 : x.pre ? -1 : 1;
}

export type Fetcher = (name: string) => Promise<string>;

/** The registry's newest version of a package. */
export const registryLatest: Fetcher = async (name) => {
  const res = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2f")}/latest`, { signal: AbortSignal.timeout(8000), headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`registry answered ${res.status}`);
  }
  const body = (await res.json()) as { version?: unknown };
  if (typeof body.version !== "string") {
    throw new Error("registry answer has no version");
  }
  return body.version;
};

export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface Cache {
  at: number;
  latest: Record<string, string>;
}

export function cacheFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CACHE_HOME ?? join(env.HOME ?? "", ".cache"), "toriel", "updates.json");
}

/** Fill `latest` for every component, from the cache when it is fresh (`refresh` skips it). A failed lookup is a `problem`, not an error. */
export async function withLatest(
  components: readonly Component[],
  opts: { fetcher?: Fetcher; cache?: string; now?: number; refresh?: boolean },
): Promise<Component[]> {
  const fetcher = opts.fetcher ?? registryLatest;
  const now = opts.now ?? Date.now();
  const cached = opts.refresh || opts.cache === undefined ? undefined : readJson<Cache>(opts.cache);
  const fresh = cached !== undefined && now - cached.at < CACHE_TTL_MS ? cached.latest : {};
  const latest: Record<string, string> = { ...fresh };
  const out: Component[] = [];
  for (const c of components) {
    const probe = c.packages[0] as string;
    let problem: string | undefined;
    if (latest[probe] === undefined) {
      try {
        latest[probe] = await fetcher(probe);
      } catch (err) {
        problem = `could not ask npm: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    out.push({ ...c, latest: latest[probe], problem });
  }
  if (opts.cache !== undefined && Object.keys(latest).length > 0) {
    try {
      mkdirSync(dirname(opts.cache), { recursive: true });
      // the answers still fresh keep their age: only a refresh or a fully stale cache restarts the clock
      const at = cached !== undefined && Object.keys(fresh).length > 0 && !opts.refresh ? cached.at : now;
      writeFileSync(opts.cache, JSON.stringify({ at, latest } satisfies Cache));
    } catch {
      // a cache that cannot be written only costs a lookup next time
    }
  }
  return out;
}

export function isBehind(c: Component): boolean {
  return c.latest !== undefined && c.installed !== undefined && compareVersions(c.installed, c.latest) < 0;
}

export function renderReport(components: readonly Component[]): string {
  const rows = components.map((c) => {
    const state = c.problem !== undefined ? c.problem : c.installed === undefined ? (c.kind === "user" ? "installed version unknown" : "not installed (npm install)") : isBehind(c) ? `update available: ${c.latest}` : "up to date";
    return { label: c.name, installed: c.installed ?? "-", latest: c.latest ?? "-", state, c };
  });
  const w = (f: (r: (typeof rows)[number]) => string) => Math.max(...rows.map((r) => f(r).length));
  const lines = ["toriel update status", ""];
  const kinds: Array<[ComponentKind, string]> = [
    ["pi", "pi (toriel's own copy; the global `pi` on PATH is not used)"],
    ["bundled", "bundled packages (pinned in package.json)"],
    ["user", "your own pi packages (settings.json; update them with `pi update`)"],
  ];
  for (const [kind, title] of kinds) {
    const mine = rows.filter((r) => r.c.kind === kind);
    if (mine.length === 0) {
      continue;
    }
    lines.push(title);
    for (const r of mine) {
      const shadow = r.c.shadowed ? `  [SHADOWED: your settings.json lists it, so toriel's copy is not the one that runs${r.c.runs ? `; yours is ${r.c.runs}` : ""}]` : "";
      lines.push(`  ${r.label.padEnd(w((x) => x.label))}  ${r.installed.padEnd(w((x) => x.installed))}  ${r.latest.padEnd(w((x) => x.latest))}  ${r.state}${shadow}`);
    }
    lines.push("");
  }
  const behind = components.filter((c) => isBehind(c) && c.kind !== "user");
  lines.push(behind.length > 0 ? `Update with: toriel update ${behind.map((c) => c.name).join(" ")}   (or: toriel update all)` : "Nothing of toriel's own is behind.");
  return lines.join("\n");
}

export interface Runner {
  /** Run a command in `cwd`; resolves with the exit code and combined output. */
  run(cmd: string, args: readonly string[], cwd: string): Promise<{ code: number; output: string }>;
}

export interface ApplyOptions {
  root: string;
  runner: Runner;
  /** Skip typecheck and tests after the install. */
  noTest?: boolean;
  write(text: string): void;
}

/** The `name@version` arguments npm installs for the chosen components. */
export function installArgs(chosen: readonly Component[]): string[] {
  return chosen.flatMap((c) => c.packages.map((p) => `${p}@${c.latest}`));
}

/**
 * Bump the chosen components to their latest: `npm install --save-exact`, then typecheck and the tests. A failure puts package.json and
 * the lockfile back and reinstalls them, so a bad bump leaves the checkout as it was. Returns the exit code.
 */
export async function applyUpdates(chosen: readonly Component[], opts: ApplyOptions): Promise<number> {
  const files = ["package.json", "package-lock.json"].map((f) => join(opts.root, f));
  const saved = files.map((f) => (existsSync(f) ? readFileSync(f, "utf8") : undefined));
  const rollback = async (why: string): Promise<number> => {
    opts.write(`${why}\nrestoring package.json and the lockfile...\n`);
    for (const [i, f] of files.entries()) {
      const was = saved[i];
      if (was !== undefined) {
        writeFileSync(f, was);
      }
    }
    const back = await opts.runner.run("npm", ["ci"], opts.root);
    opts.write(back.code === 0 ? "restored: nothing changed.\n" : `npm ci failed while restoring (run it yourself):\n${back.output}\n`);
    return 1;
  };
  const targets = installArgs(chosen);
  opts.write(`npm install --save-exact ${targets.join(" ")}\n`);
  const install = await opts.runner.run("npm", ["install", "--save-exact", ...targets], opts.root);
  if (install.code !== 0) {
    return rollback(`npm install failed:\n${install.output}`);
  }
  if (!opts.noTest) {
    for (const script of ["typecheck", "test"]) {
      opts.write(`npm run ${script}\n`);
      const r = await opts.runner.run("npm", ["run", script], opts.root);
      if (r.code !== 0) {
        return rollback(`npm run ${script} failed after the bump:\n${r.output.split("\n").slice(-40).join("\n")}`);
      }
    }
  }
  opts.write(`\nUpdated ${chosen.map((c) => `${c.name} ${c.installed ?? "?"} -> ${c.latest}`).join(", ")}.\nRunning sessions keep the old code until they are reloaded: run \`toriel kill-server\` and restart toriel to pick this up. Review and commit package.json and the lockfile.\n`);
  return 0;
}
