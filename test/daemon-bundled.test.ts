import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { BUNDLED_NAMES } from "../src/bundled-packages.ts";
import { type Harness, startDaemon } from "./helpers.ts";

let harness: Harness | undefined;
const temp: string[] = [];
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
  for (const d of temp.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

/** A stand-in node_modules holding every bundled package, and a pi config directory whose settings.json lists `userPackages`. */
function world(userPackages: string[] = []): { bundledRoot: string; agentDir: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-daemon-bundled-"));
  temp.push(base);
  const bundledRoot = path.join(base, "node_modules");
  for (const name of BUNDLED_NAMES) {
    fs.mkdirSync(path.join(bundledRoot, name), { recursive: true });
  }
  const agentDir = path.join(base, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: userPackages.map((n) => `npm:${n}`) }));
  return { bundledRoot, agentDir };
}

const argvOf = async (h: Harness, agent?: string): Promise<string[]> => {
  const c = await h.connect();
  const r = await c.request({ type: "spawn", cwd: h.dir, ...(agent ? { agent } : {}) });
  await c.waitFor((m) => m.type === "history" && m.session === r.sessionId);
  const f = c.sessions().find((x) => x.id === r.sessionId)?.sessionFile;
  return JSON.parse(fs.readFileSync(`${f}.argv.json`, "utf8")) as string[];
};
const flagged = (argv: string[], flag: string): string[] => argv.flatMap((a, i) => (a === flag ? [argv[i + 1] as string] : []));

describe("daemon: bundled pi packages (ticket 230)", () => {
  it("loads each package by flag into a plain session, and offers its tools to a resumed one", async () => {
    const w = world();
    harness = await startDaemon({ TORIEL_BUNDLED_ROOT: w.bundledRoot, PI_CODING_AGENT_DIR: w.agentDir });
    const argv = await argvOf(harness);
    const packages = flagged(argv, "-e").filter((p) => p.startsWith(w.bundledRoot));
    assert.deepEqual(packages, BUNDLED_NAMES.map((n) => path.join(w.bundledRoot, n)));
    const tools = flagged(argv, "--tools")[0] ?? "";
    assert.ok(tools.includes("+ask_user_question") && tools.includes("+web_search") && tools.includes("+memory_add"), tools);
  });

  it("leaves out a package the user installed themselves, so pi never loads it twice", async () => {
    const w = world(["pi-web-access"]);
    harness = await startDaemon({ TORIEL_BUNDLED_ROOT: w.bundledRoot, PI_CODING_AGENT_DIR: w.agentDir });
    const argv = await argvOf(harness);
    const packages = flagged(argv, "-e").filter((p) => p.startsWith(w.bundledRoot));
    assert.equal(packages.some((p) => p.endsWith("pi-web-access")), false);
    assert.equal(packages.length, BUNDLED_NAMES.length - 1);
    assert.equal((flagged(argv, "--tools")[0] ?? "").includes("+web_search"), false, "its tools are the user's package's to offer");
  });

  it("leaves out a package the project's own pi settings list", async () => {
    const w = world();
    harness = await startDaemon({ TORIEL_BUNDLED_ROOT: w.bundledRoot, PI_CODING_AGENT_DIR: w.agentDir });
    fs.mkdirSync(path.join(harness.dir, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(harness.dir, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:pi-hermes-memory"] }));
    const argv = await argvOf(harness);
    const packages = flagged(argv, "-e").filter((p) => p.startsWith(w.bundledRoot));
    assert.equal(packages.some((p) => p.endsWith("pi-hermes-memory")), false);
    assert.equal(packages.length, BUNDLED_NAMES.length - 1);
  });

  it("gives a minimal profile only the permission gate", async () => {
    const w = world();
    harness = await startDaemon({ TORIEL_BUNDLED_ROOT: w.bundledRoot, PI_CODING_AGENT_DIR: w.agentDir, TORIEL_AGENTS_DIR: path.join(os.tmpdir(), "toriel-no-user-agents") });
    const argv = await argvOf(harness, "explore");
    assert.deepEqual(flagged(argv, "-e").filter((p) => p.startsWith(w.bundledRoot)), [path.join(w.bundledRoot, "@gotgenes", "pi-permission-system")]);
  });
});

describe("daemon: MCP tools through tool_search (ticket 298)", () => {
  it("gives a plain session tool_search and leaves codemode out, unless the codemode setting is on", async () => {
    harness = await startDaemon();
    const argv = await argvOf(harness);
    assert.ok((flagged(argv, "--tools")[0] ?? "").split(",").includes("+tool_search"), "tool_search loads deferred MCP tools");
    assert.deepEqual(flagged(argv, "--exclude-tools"), ["codemode"]);
    await harness.stop();
    const config = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-codemode-"));
    temp.push(config);
    fs.mkdirSync(path.join(config, "toriel"), { recursive: true });
    fs.writeFileSync(path.join(config, "toriel", "settings.yaml"), "codemode: true\n");
    harness = await startDaemon({ XDG_CONFIG_HOME: config });
    assert.deepEqual(flagged(await argvOf(harness), "--exclude-tools"), [], "the setting brings codemode back");
  });
});
