import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { BUNDLED_NAMES, BUNDLED_PACKAGES, bundledArgs, bundledTools, loadsFor, packageState, packagesFor } from "../src/bundled-packages.ts";
import { loadSettings } from "../src/settings.ts";

const ASK = "@juicesharp/rpiv-ask-user-question";
const WEB = "pi-web-access";
const MEMORY = "pi-hermes-memory";
const pkg = (name: string) => BUNDLED_PACKAGES.find((p) => p.name === name) as (typeof BUNDLED_PACKAGES)[number];

let dir: string;
let root: string;
let agentDir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-bundled-"));
  root = path.join(dir, "node_modules");
  agentDir = path.join(dir, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  for (const name of BUNDLED_NAMES) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
  }
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const listed = (...names: string[]) => fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: names.map((n) => `npm:${n}`) }));

describe("packageState", () => {
  it("is bundled when it is installed and nothing says otherwise", () => {
    assert.equal(packageState(pkg(WEB), { agentDir, root }), "bundled");
  });

  it("is missing when npm install did not leave it", () => {
    fs.rmSync(path.join(root, WEB), { recursive: true });
    assert.equal(packageState(pkg(WEB), { agentDir, root }), "missing");
  });

  it("is the user's when pi's settings.json lists it: their copy wins, so it is never loaded twice", () => {
    listed(WEB);
    assert.equal(packageState(pkg(WEB), { agentDir, root }), "user");
    assert.equal(packageState(pkg(ASK), { agentDir, root }), "bundled", "only the one that is listed");
    fs.rmSync(path.join(root, WEB), { recursive: true });
    assert.equal(packageState(pkg(WEB), { agentDir, root }), "user", "even with toriel's copy gone");
  });

  it("is off when the setting says so, and that outranks everything", () => {
    listed(WEB);
    assert.equal(packageState(pkg(WEB), { agentDir, root, off: [WEB] }), "off");
    assert.equal(packageState(pkg(MEMORY), { agentDir, root, off: [WEB] }), "bundled");
  });
});

describe("which sessions load which package", () => {
  it("a plain session loads them all", () => {
    assert.deepEqual(packagesFor(undefined, { agentDir, root }).map((p) => p.name), BUNDLED_NAMES);
  });

  it("a profile without a tool list gets the packages that are not the user's own state, unless it is minimal", () => {
    assert.deepEqual(packagesFor({}, { agentDir, root }).map((p) => p.name), [ASK, WEB], "no memory for a subagent");
    assert.deepEqual(packagesFor({ minimal: true }, { agentDir, root }), []);
  });

  it("a profile that owns its tool list loads a package only when it names one of its tools", () => {
    assert.deepEqual(packagesFor({ tools: ["read", "web_search", "fetch_content"] }, { agentDir, root }).map((p) => p.name), [WEB]);
    assert.deepEqual(packagesFor({ tools: ["read", "grep"] }, { agentDir, root }), []);
    assert.equal(loadsFor(pkg(MEMORY), { tools: ["memory_search"] }), true, "naming a tool is asking for the package");
  });

  it("leaves out what is the user's, off or missing", () => {
    listed(WEB);
    fs.rmSync(path.join(root, ASK), { recursive: true });
    assert.deepEqual(packagesFor(undefined, { agentDir, root, off: [MEMORY] }), []);
  });
});

describe("the pi arguments", () => {
  it("are -e <package directory> for each, which pi loads even with extension discovery off", () => {
    assert.deepEqual(bundledArgs(undefined, { agentDir, root }), BUNDLED_NAMES.flatMap((n) => ["-e", path.join(root, n)]));
    assert.deepEqual(bundledArgs({ minimal: true }, { agentDir, root }), []);
  });

  it("name the tools to add for a resumed session, only for what is loaded", () => {
    const tools = bundledTools(undefined, { agentDir, root });
    assert.ok(tools.includes("+ask_user_question") && tools.includes("+web_search") && tools.includes("+memory_add"));
    assert.deepEqual(bundledTools(undefined, { agentDir, root, off: [WEB, MEMORY] }), ["+ask_user_question"]);
  });
});

describe("bundledPackagesOff setting", () => {
  it("takes known package names and names the valid ones when it is wrong", () => {
    const file = path.join(dir, "settings.yaml");
    fs.writeFileSync(file, `bundledPackagesOff:\n  - ${MEMORY}\n`);
    assert.deepEqual(loadSettings(file).settings.bundledPackagesOff, [MEMORY]);
    fs.writeFileSync(file, "bundledPackagesOff:\n  - not-a-package\n");
    const bad = loadSettings(file);
    assert.equal(bad.settings.bundledPackagesOff, undefined);
    assert.match(bad.problems.join("\n"), /bundledPackagesOff must be a list of bundled package names \(@juicesharp\/rpiv-ask-user-question, pi-web-access, pi-hermes-memory\)/);
  });
});
