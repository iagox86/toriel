import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { PERMISSIONS_FILE } from "../src/config.ts";
import { auditFindings, describeResourceProblems, type Finding, missingResources, pathAction, PI_RESOURCES_DIR, RESOURCES, resourceArgs, scopeGuardFindings, staleInstalls, summarizeFindings, TORIEL_TOOLS } from "../src/resources.ts";

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

  it("includes the theme file: the controller reads it at startup and cannot start without it", () => {
    assert.deepEqual(RESOURCES.filter((r) => r.kind === "theme").map((r) => r.path), ["themes/solarized-dark.json"]);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-res-"));
    assert.ok(missingResources(empty).some((r) => r.path === "themes/solarized-dark.json"));
  });

  it("covers every extension file in pi/extensions except presence, which is only for plain pi", () => {
    const shipped = RESOURCES.filter((r) => r.kind === "extension").map((r) => path.basename(r.path));
    const onDisk = fs.readdirSync(path.join(PI_RESOURCES_DIR, "extensions"), { withFileTypes: true }).filter((e) => e.isFile() && e.name !== "toriel-presence.ts").map((e) => e.name);
    assert.deepEqual([...shipped].sort(), onDisk.sort());
  });
});

describe("resourceArgs", () => {
  it("passes every extension with -e and the skill with --skill, as absolute paths", () => {
    const args = resourceArgs({}, "/r/pi");
    assert.deepEqual(args.filter((_, i) => i % 2 === 0), RESOURCES.filter((r) => r.kind !== "theme").map((r) => (r.kind === "extension" ? "-e" : "--skill")));
    assert.ok(args.includes("/r/pi/extensions/toriel-agents.ts"));
    assert.ok(args.includes("/r/pi/skills/messaging"));
  });

  it("never loads the theme into pi (the controller reads it itself)", () => {
    assert.ok(!resourceArgs().some((a) => a.includes("themes")));
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
    assert.deepEqual([...TORIEL_TOOLS], ["+toriel_message", "+toriel_schedule_create", "+toriel_schedule_list", "+toriel_schedule_cancel", "+toriel_agent", "+toriel_agents", "+toriel_usage", "+toriel_job"]);
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
/** The permission package's config as toriel wants it: the grants link in the chain, the grants file asking, and no allow on a covered write surface (the scope guard). */
const GOOD_CONFIG = { authorizerChain: ["toriel-grants"], permission: { "*": "ask", path: { "*": "ask", [PERMISSIONS_FILE]: "ask" } } };

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
    assert.deepEqual(ids(audit({ ...rules, authorizerChain: ["other", "toriel-grants"] })), [], "the grants problems are gone; an ask-only config cannot short-circuit the scope guard");
  });

  it("says to put a path rule on the grants file, as a hardening problem naming it with ~ and where it goes", () => {
    const [f] = audit({ authorizerChain: ["toriel-grants"], permission: { "*": "allow" } });
    assert.equal(f?.id, "grants-path-rule");
    assert.equal(f?.level, "hardening");
    assert.match(f?.message ?? "", /nothing stops an agent editing the permission grants file: add "~\/\.local\/share\/toriel\/permissions\.json": "ask"/);
    assert.match(f?.message ?? "", /last matching rule wins: put it after any catch-all allow entry/);
  });

  it("accepts ask or deny, as a literal path, a ~ path or a glob, and rejects a later allow", () => {
    const chain = { authorizerChain: ["toriel-grants"] };
    for (const [pattern, action] of [[grantsFile, "ask"], [grantsFile, "deny"], ["~/.local/share/toriel/permissions.json", "ask"], ["/home/u/.local/share/toriel/*", "ask"], ["*permissions.json", "deny"]] as const) {
      assert.deepEqual(ids(audit({ ...chain, permission: { path: { "*": "allow", [pattern]: action } } })), [], `${pattern} ${action}: a path allow is in-cwd posture, not a guard short-circuit`);
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

describe("scope guard audit", () => {
  const ids = (config: unknown) => scopeGuardFindings(config).map((f) => f.id);

  it("fires for an external_directory_write allow, as a hardening problem with no automatic fix", () => {
    const [f] = scopeGuardFindings({ permission: { external_directory_write: { "*": "allow" } } });
    assert.equal(f?.id, "scope-guard-short-circuit");
    assert.equal(f?.level, "hardening");
    assert.equal(f?.fix, undefined);
    assert.match(f?.message ?? "", /^config allows outside-scope writes outright \(external_directory_write: "\*"\): an ask these match is allowed before the authorizer chain runs/);
    assert.match(f?.message ?? "", /; set them to "ask" - an explicit "\*": "ask" on external_directory_write also makes the "\*" fallback unreachable - if you want directory scoping to hold \(deliberate allows can be recorded in the toriel settings as scopeGuardAcceptedAllows so they are not flagged\)$/);
  });

  it("fires for the \"*\" fallback when no external_directory_write catch-all answers, naming it as the fallback", () => {
    const [f] = scopeGuardFindings({ permission: { "*": "allow" } });
    assert.equal(f?.id, "scope-guard-short-circuit");
    assert.match(f?.message ?? "", /\("\*" \(fallback\)\)/);
  });

  it("stays quiet when a catch-all ask makes the fallback unreachable (the locked-down shape)", () => {
    assert.deepEqual(scopeGuardFindings({ permission: { "*": "allow", external_directory_write: { "*": "ask" } } }), []);
    assert.deepEqual(scopeGuardFindings({ permission: { "*": "allow", external_directory: { "*": "ask" } } }), [], "the bare sugar expands into the directional section at load");
    assert.deepEqual(scopeGuardFindings({ permission: { "*": "allow", external_directory_write: { "*": "deny" } } }), []);
  });

  it("fires for allow entries on the covered surfaces in any pattern form", () => {
    assert.deepEqual(ids({ permission: { external_directory_write: "allow" } }), ["scope-guard-short-circuit"]);
    assert.match(scopeGuardFindings({ permission: { external_directory_write: "allow" } })[0]?.message ?? "", /\(external_directory_write: "\*"\)/);
    assert.deepEqual(ids({ permission: { external_directory: { "/tmp/*": "allow" } } }), ["scope-guard-short-circuit"]);
    assert.deepEqual(ids({ permission: { external_directory_write: { "/tmp/*": { action: "allow" } } } }), ["scope-guard-short-circuit"]);
  });

  it("ignores path, path_write, write and edit allows: they gate in-cwd asks, which the guard does not deny", () => {
    assert.deepEqual(scopeGuardFindings({ permission: { path: { "*": "allow" }, path_write: "allow", write: "allow", edit: { "*": "allow" } } }), []);
  });

  it("stays quiet on an ask-only config", () => {
    assert.deepEqual(scopeGuardFindings({ permission: { path: { "*": "ask" }, "*": "ask" } }), []);
  });

  it("stays quiet on deny rules, read-only surfaces and bash, which the guard does not cover this phase", () => {
    assert.deepEqual(scopeGuardFindings({ permission: { path: { "*": "deny" }, path_read: { "*": "allow" }, external_directory_read: "allow", bash: { "*": "allow" }, path_write: { "*": "ask" } } }), []);
  });

  it("returns nothing for a missing or unusable config", () => {
    assert.deepEqual(scopeGuardFindings(undefined), []);
    assert.deepEqual(scopeGuardFindings({}), []);
    assert.deepEqual(scopeGuardFindings({ permission: "allow" }), []);
    assert.deepEqual(scopeGuardFindings({ permission: [] }), []);
    assert.deepEqual(scopeGuardFindings({ permission: { path: [] } }), []);
  });

  it("fires once for a mixed covered section, naming only the allow", () => {
    const found = scopeGuardFindings({ permission: { external_directory_write: { "~/work/*": "ask", "*": "allow", "*.env": "deny" } } });
    assert.equal(found.length, 1);
    assert.match(found[0]?.message ?? "", /\(external_directory_write: "\*"\)/);
  });

  it("lists every offender in one finding, covered surfaces in order with the fallback last", () => {
    const [f] = scopeGuardFindings({ permission: { "*": "allow", external_directory: { "~/x/*": "allow" }, external_directory_write: { "*": "allow", "/tmp/**": "allow" } } });
    assert.match(f?.message ?? "", /\(external_directory_write: "\*", external_directory_write: "\/tmp\/\*\*", external_directory: "~\/x\/\*", "\*" \(fallback\)\)/);
  });

  it("stays quiet when every offender is recorded as accepted (exact surface and pattern)", () => {
    const config = { permission: { "*": "allow", external_directory_write: { "/tmp/*": "allow" } } };
    assert.deepEqual(scopeGuardFindings(config, [{ surface: "external_directory_write", pattern: "/tmp/*" }, { surface: "*", pattern: "*" }]), []);
  });

  it("narrows the finding to the unaccepted offenders when only some are accepted, and teaches the mechanism", () => {
    const config = { permission: { "*": "allow", external_directory_write: { "/tmp/*": "allow" } } };
    const [f] = scopeGuardFindings(config, [{ surface: "external_directory_write", pattern: "/tmp/*" }]);
    assert.equal(f?.id, "scope-guard-short-circuit");
    assert.match(f?.message ?? "", /^config allows outside-scope writes outright \("\*" \(fallback\)\):/);
    assert.match(f?.message ?? "", /\(deliberate allows can be recorded in the toriel settings as scopeGuardAcceptedAllows so they are not flagged\)$/);
  });

  it("accepts an offender only on its exact surface: the write form does not cover the bare external_directory", () => {
    assert.equal(scopeGuardFindings({ permission: { external_directory: { "/tmp/*": "allow" } } }, [{ surface: "external_directory_write", pattern: "/tmp/*" }]).length, 1);
  });

  it("accepts the \"*\" entry only for the fallback offender, not for allows on the named surfaces", () => {
    const [f] = scopeGuardFindings({ permission: { "*": "allow", external_directory_write: { "/tmp/*": "allow" } } }, [{ surface: "*", pattern: "*" }]);
    assert.match(f?.message ?? "", /^config allows outside-scope writes outright \(external_directory_write: "\/tmp\/\*"\):/);
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
