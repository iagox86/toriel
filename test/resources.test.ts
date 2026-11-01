import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { PERMISSIONS_FILE } from "../src/config.ts";
import { auditFindings, describeResourceProblems, type Finding, missingResources, pathAction, PI_RESOURCES_DIR, RESOURCES, resourceArgs, staleInstalls, summarizeFindings, TORIEL_TOOLS } from "../src/resources.ts";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "toriel-res-"));
}

/** A fake pi/ tree holding every shipped resource. */
function repoTree(): string {
  const root = tmp();
  for (const r of RESOURCES) {
    fs.mkdirSync(path.dirname(path.join(root, r.path)), { recursive: true });
    fs.writeFileSync(path.join(root, r.path), "");
  }
  return root;
}

describe("shipped resources", () => {
  it("all exist in this checkout", () => {
    assert.deepEqual(missingResources(), []);
  });

  it("covers every extension file in pi/extensions except presence, which is only for plain pi", () => {
    const shipped = RESOURCES.filter((r) => r.kind === "extension").map((r) => path.basename(r.path));
    const onDisk = fs.readdirSync(path.join(PI_RESOURCES_DIR, "extensions")).filter((n) => n !== "toriel-presence.ts");
    assert.deepEqual([...shipped].sort(), onDisk.sort());
  });
});

describe("resourceArgs", () => {
  it("passes every extension with -e and the skill with --skill, as absolute paths", () => {
    const args = resourceArgs({}, "/r/pi");
    assert.deepEqual(args.filter((_, i) => i % 2 === 0), RESOURCES.map((r) => (r.kind === "extension" ? "-e" : "--skill")));
    assert.ok(args.includes("/r/pi/extensions/toriel-agents.ts"));
    assert.ok(args.includes("/r/pi/skills/messaging"));
  });

  it("leaves the skill out when a profile wants no skills, but keeps the extensions", () => {
    const args = resourceArgs({ skills: false }, "/r/pi");
    assert.ok(!args.includes("--skill"));
    assert.ok(args.includes("-e"));
  });

  it("follows the repo location, so moving the checkout needs no reinstall", () => {
    assert.ok(resourceArgs().every((a) => a === "-e" || a === "--skill" || a.startsWith(PI_RESOURCES_DIR)));
  });
});

describe("TORIEL_TOOLS", () => {
  it("is the + modifier of every tool a shipped extension registers", () => {
    assert.deepEqual([...TORIEL_TOOLS], ["+toriel_message", "+toriel_schedule_create", "+toriel_schedule_list", "+toriel_schedule_cancel", "+toriel_usage"]);
  });
});

describe("staleInstalls", () => {
  it("finds links the old installer left, whatever they point at, and ignores the user's own files", () => {
    const agent = tmp();
    const root = repoTree();
    fs.mkdirSync(path.join(agent, "extensions"));
    fs.mkdirSync(path.join(agent, "skills"));
    const moved = path.join(agent, "extensions", "toriel-usage.ts");
    const old = path.join(agent, "extensions", "ronpi-usage.ts");
    const skill = path.join(agent, "skills", "messaging");
    const intoRepo = path.join(agent, "extensions", "renamed.ts");
    fs.symlinkSync("/gone/elsewhere.ts", moved);
    fs.symlinkSync("/gone/elsewhere.ts", old);
    fs.symlinkSync(path.join(root, "skills", "messaging"), skill);
    fs.symlinkSync(path.join(root, "extensions", "toriel-agents.ts"), intoRepo);
    fs.mkdirSync(path.join(agent, "themes"));
    const theme = path.join(agent, "themes", "solarized-dark.json");
    fs.symlinkSync(path.join(root, "themes", "solarized-dark.json"), theme);
    fs.writeFileSync(path.join(agent, "extensions", "status-bar.ts"), "");
    fs.symlinkSync("/x/mine.ts", path.join(agent, "extensions", "mine.ts"));
    assert.deepEqual(staleInstalls(agent, root).sort(), [intoRepo, moved, old, skill, theme].sort());
  });

  it("is empty when the agent dir has no extensions or skills", () => {
    assert.deepEqual(staleInstalls(tmp(), repoTree()), []);
  });
});

/** A pi agent dir the way a working setup has it: the permission package listed, with a config. */
/** The permission package's config as toriel wants it: the grants link in the chain, and the grants file asking. */
const GOOD_CONFIG = { authorizerChain: ["toriel-grants"], permission: { "*": "allow", path: { "*": "allow", [PERMISSIONS_FILE]: "ask" } } };

function agentDirWithPermissions(config: unknown = GOOD_CONFIG): string {
  const agent = tmp();
  fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ packages: ["npm:pi-web-access", "npm:@gotgenes/pi-permission-system"] }));
  fs.mkdirSync(path.join(agent, "extensions", "pi-permission-system"), { recursive: true });
  fs.writeFileSync(path.join(agent, "extensions", "pi-permission-system", "config.json"), JSON.stringify(config));
  return agent;
}

describe("describeResourceProblems", () => {
  it("says nothing when the checkout is complete, nothing stale is installed and permissions are set up", () => {
    assert.equal(describeResourceProblems(agentDirWithPermissions(), repoTree()), undefined);
  });

  it("says to run pi once when it has no config directory", () => {
    assert.match(describeResourceProblems(path.join(tmp(), "nope"), repoTree()) ?? "", /run pi once and log in/);
  });

  it("names a settings.json that is not valid JSON", () => {
    const agent = tmp();
    fs.writeFileSync(path.join(agent, "settings.json"), "{ nope");
    const text = describeResourceProblems(agent, repoTree()) ?? "";
    assert.match(text, /settings\.json is not valid JSON/);
    assert.doesNotMatch(text, /permission/, "cannot tell whether the package is listed in a file pi cannot read");
  });

  it("names a missing shipped file", () => {
    const root = repoTree();
    fs.rmSync(path.join(root, "extensions", "toriel-usage.ts"));
    assert.match(describeResourceProblems(agentDirWithPermissions(), root) ?? "", /extensions\/toriel-usage\.ts/);
  });

  it("tells the user how to remove stale links", () => {
    const agent = agentDirWithPermissions();
    fs.symlinkSync("/x", path.join(agent, "extensions", "toriel-usage.ts"));
    assert.match(describeResourceProblems(agent, repoTree()) ?? "", /load twice: remove them with rm .*toriel-usage\.ts/);
  });

  it("reports every problem at once, not just the first", () => {
    const agent = tmp();
    fs.mkdirSync(path.join(agent, "extensions"));
    fs.symlinkSync("/x", path.join(agent, "extensions", "toriel-usage.ts"));
    const text = describeResourceProblems(agent, repoTree()) ?? "";
    assert.match(text, /load twice/);
    assert.match(text, /not in pi's packages/);
  });
});

describe("pi-permission-system check", () => {
  it("warns that sessions run without prompts when the package is not listed, or there is no settings.json", () => {
    const agent = tmp();
    assert.match(describeResourceProblems(agent, repoTree()) ?? "", /pi-permission-system is not in pi's packages.*without permission prompts/);
    fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ packages: ["npm:pi-web-access"] }));
    assert.match(describeResourceProblems(agent, repoTree()) ?? "", /not in pi's packages/);
  });

  it("accepts the package listed as an object with a source", () => {
    const agent = agentDirWithPermissions();
    fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ packages: [{ source: "npm:@gotgenes/pi-permission-system", extensions: ["x"] }] }));
    assert.equal(describeResourceProblems(agent, repoTree()), undefined);
  });

  it("warns that everything will ask when the package is listed but its config is missing", () => {
    const agent = agentDirWithPermissions();
    fs.rmSync(path.join(agent, "extensions", "pi-permission-system", "config.json"));
    assert.match(describeResourceProblems(agent, repoTree()) ?? "", /no usable config at .*config\.json \(missing\): every tool will ask/);
  });

  it("warns when the config is not valid JSON, with the parse error", () => {
    const agent = agentDirWithPermissions();
    fs.writeFileSync(path.join(agent, "extensions", "pi-permission-system", "config.json"), "{ \"permission\": ");
    assert.match(describeResourceProblems(agent, repoTree()) ?? "", /no usable config.*JSON.*every tool will ask/);
  });

  it("stays quiet when the user turned the warning off", () => {
    assert.equal(describeResourceProblems(tmp(), repoTree(), { permissionSystem: false }), undefined);
    assert.equal(describeResourceProblems(agentDirWithPermissions({}), repoTree(), { permissionSystem: false }), undefined);
  });
});

describe("permission grants audit", () => {
  const grantsFile = "/home/u/.local/share/toriel/permissions.json";
  const audit = (config: unknown, home = "/home/u"): Finding[] => {
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      return auditFindings(agentDirWithPermissions(config), repoTree(), { grantsFile });
    } finally {
      process.env.HOME = saved;
    }
  };
  const ids = (f: Finding[]) => f.map((x) => x.id);

  it("says to name toriel-grants in the authorizer chain, as a feature-level problem, and keeps quiet once it is there", () => {
    const rules = { permission: { path: { "*": "allow", [grantsFile]: "ask" } } };
    const [missing] = audit(rules);
    assert.equal(missing?.id, "grants-chain");
    assert.equal(missing?.level, "feature");
    assert.match(missing?.message ?? "", /grants are inactive: add "toriel-grants" to "authorizerChain" in .*config\.json/);
    assert.deepEqual(ids(audit({ ...rules, authorizerChain: ["other"] })), ["grants-chain"]);
    assert.deepEqual(audit({ ...rules, authorizerChain: ["other", "toriel-grants"] }), []);
  });

  it("says to put a path rule on the grants file, as a hardening problem naming it with ~ and where it goes", () => {
    const [f] = audit({ authorizerChain: ["toriel-grants"], permission: { "*": "allow" } });
    assert.equal(f?.id, "grants-path-rule");
    assert.equal(f?.level, "hardening");
    assert.match(f?.message ?? "", /nothing stops an agent editing the permission grants file: add "~\/\.local\/share\/toriel\/permissions\.json": "ask"/);
    assert.match(f?.message ?? "", /after a "\*": "allow" entry/);
  });

  it("accepts ask or deny, as a literal path, a ~ path or a glob, and rejects a later allow", () => {
    const chain = { authorizerChain: ["toriel-grants"] };
    for (const [pattern, action] of [[grantsFile, "ask"], [grantsFile, "deny"], ["~/.local/share/toriel/permissions.json", "ask"], ["/home/u/.local/share/toriel/*", "ask"], ["*permissions.json", "deny"]] as const) {
      assert.deepEqual(audit({ ...chain, permission: { path: { "*": "allow", [pattern]: action } } }), [], `${pattern} ${action}`);
    }
    assert.deepEqual(audit({ ...chain, permission: { path: { [grantsFile]: { action: "ask", reason: "grants" } } } }), []);
    assert.deepEqual(ids(audit({ ...chain, permission: { path: { [grantsFile]: "ask", "*": "allow" } } })), ["grants-path-rule"]);
    assert.deepEqual(ids(audit({ ...chain, permission: { path: { [grantsFile]: "allow" } } })), ["grants-path-rule"]);
  });

  it("reports both problems together, and says nothing about them when the config is unusable", () => {
    assert.deepEqual(ids(audit({})), ["grants-chain", "grants-path-rule"]);
    const agent = agentDirWithPermissions();
    fs.writeFileSync(path.join(agent, "extensions", "pi-permission-system", "config.json"), "{ nope");
    const found = auditFindings(agent, repoTree(), { grantsFile });
    assert.deepEqual(ids(found), ["permission-package"]);
    assert.equal(found[0]?.level, "recommended");
  });

  it("offers a fix only where the config has the usual shape", () => {
    const [chain, rule] = audit({});
    assert.ok(chain?.fix && rule?.fix);
    const odd = audit({ authorizerChain: "toriel-grants", permission: { path: "nope" } });
    assert.deepEqual(odd.map((f) => f.fix), [undefined, undefined]);
  });
});

describe("start-up summary", () => {
  const f = (id: string, level: Finding["level"], message: string): Finding => ({ id, level, message });

  it("shows required and recommended problems in full and only counts the rest", () => {
    assert.equal(summarizeFindings([]), undefined);
    assert.equal(summarizeFindings([f("a", "required", "node is old"), f("b", "recommended", "no permission package"), f("c", "feature", "x"), f("d", "hardening", "y")]), "node is old; no permission package; 2 suggestions: /doctor lists them");
    assert.equal(summarizeFindings([f("c", "feature", "x")]), "1 suggestion: /doctor lists them");
  });

  it("is what describeResourceProblems says: a config missing only the grants lines costs a count, not a paragraph", () => {
    assert.equal(describeResourceProblems(agentDirWithPermissions({}), repoTree(), { grantsFile: "/home/u/p.json" }), "2 suggestions: /doctor lists them");
  });
});

describe("pathAction", () => {
  it("lets the last matching rule win, treats * as crossing directories, and expands ~", () => {
    const home = process.env.HOME ?? "";
    const config = { permission: { path: { "*": "allow", "~/.ssh/*": "deny", "*.env": "ask", "/data/*": "ask", "/data/ok/*": "allow" } } };
    assert.equal(pathAction(config, `${home}/.ssh/id_rsa`), "deny");
    assert.equal(pathAction(config, "/x/y/.env"), "ask");
    assert.equal(pathAction(config, "/data/a/b"), "ask");
    assert.equal(pathAction(config, "/data/ok/a"), "allow");
    assert.equal(pathAction(config, "/elsewhere"), "allow");
    assert.equal(pathAction({}, "/x"), undefined);
    assert.equal(pathAction({ permission: { path: [] } }, "/x"), undefined);
  });
});
