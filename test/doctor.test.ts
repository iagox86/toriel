import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ANSI_STYLE, applyFixes, CATALOG, collectFindings, type DoctorOptions, exitCode, lineDiff, plannedFixes, previewFixes, renderDoctor, runDoctor } from "../src/doctor.ts";
import { GRANTS_RULE, setup as setupIn, tempHome } from "./doctor-fixture.ts";

let env: ReturnType<typeof tempHome>;
beforeEach(() => {
  env = tempHome();
});
afterEach(() => env.done());
const setup = (over: Parameters<typeof setupIn>[1] = {}) => setupIn(env.home, over);

describe("doctor checks", () => {
  it("finds nothing wrong with a complete setup", () => {
    const { opts } = setup();
    assert.deepEqual(collectFindings(opts), []);
    const checks = runDoctor(opts);
    assert.equal(exitCode(checks), 0);
    assert.ok(checks.every((c) => c.state === "ok"));
    assert.match(renderDoctor(checks), /Everything checks out\./);
  });

  it("only ever reports findings the catalog knows, and the catalog has no dead entries", () => {
    const scenarios: DoctorOptions[] = [
      { ...setup({ noPiDir: true, noResources: true, stale: false, noCli: true, noInhibit: true, settings: '{"bogus":1}' }).opts, startup: ["node is too old"] },
      setup({ stale: true }).opts,
      setup({ noPackage: true }).opts,
      setup({ config: {} }).opts,
      { ...setup({}).opts, env: { WAYLAND_DISPLAY: "wayland-0" }, pathDirs: ["/nonexistent-path"], startup: [] },
      { ...setup({}).opts, tty: true, env: { TERM: "xterm-256color" }, startup: [] },
      setup({ gitMcp: "none" }).opts,
      setup({ gdbMcp: "none", ghidraMcp: "codemode" }).opts,
      setup({ config: { authorizerChain: ["toriel-grants"], permission: { "*": "allow", path: { "*": "allow", [GRANTS_RULE]: "ask" } } } }).opts,
      setup({ scopePatch: "absent" }).opts,
      setup({ scopePatch: "absent", config: { authorizerChain: ["toriel-grants"], permission: { "*": "allow", external_directory_write: { "/tmp/*": "allow" }, path: { "*": "ask", [GRANTS_RULE]: "ask" } } }, settings: JSON.stringify({ scopeGuardAcceptedAllows: [{ surface: "external_directory_write", pattern: "/tmp/*" }, { surface: "*", pattern: "*" }] }) }).opts,
    ];
    const seen = new Set<string>();
    for (const opts of scenarios) {
      for (const f of collectFindings(opts)) {
        seen.add(f.id);
      }
    }
    const catalog = CATALOG.map((c) => c.id);
    assert.equal(new Set(catalog).size, catalog.length, "catalog ids are unique");
    assert.deepEqual([...seen].filter((id) => !catalog.includes(id)), [], "a finding id is missing from the catalog (src/doctor.ts)");
    assert.deepEqual(catalog.filter((id) => !seen.has(id)), [], "a catalog entry nothing can report any more");
  });

  it("flags an installed package that lacks the scope patch, and stays quiet when the marker is there", () => {
    const absent = runDoctor(setup({ scopePatch: "absent" }).opts);
    const hit = absent.filter((c) => c.id === "permission-package-scope-patch");
    assert.deepEqual(hit.map((c) => [c.id, c.level]), [["permission-package-scope-patch", "hardening"]]);
    assert.match(hit[0]?.findings[0]?.message ?? '', /lacks the toriel scope patch[\s\S]*pi\/patches\/scope-config-patch\.md/);
    assert.equal(exitCode(absent), 0);
    const present = runDoctor(setup({ scopePatch: "present" }).opts);
    assert.deepEqual(present.filter((c) => c.state === "problem").map((c) => c.id), [], "the marker satisfies the check");
  });

  it("does not flag allows the toriel settings record as accepted (scopeGuardAcceptedAllows)", () => {
    const allows = { authorizerChain: ["toriel-grants"], permission: { "*": "allow", external_directory_write: { "/tmp/*": "allow" }, path: { "*": "ask", [GRANTS_RULE]: "ask" } } };
    const acceptance = JSON.stringify({ scopeGuardAcceptedAllows: [{ surface: "external_directory_write", pattern: "/tmp/*" }, { surface: "*", pattern: "*" }] });
    const without = collectFindings(setup({ scopePatch: "absent", config: allows }).opts);
    assert.ok(without.some((f) => f.id === "scope-guard-short-circuit"), "the same config without an acceptance still fires");
    const quiet = collectFindings(setup({ scopePatch: "absent", config: allows, settings: acceptance }).opts);
    assert.deepEqual(quiet.filter((f) => f.id === "scope-guard-short-circuit"), []);
    assert.ok(quiet.every((f) => f.id !== "settings"), "the acceptance list itself parses cleanly");
  });

  it("grades what it finds, and exits 1 only for a required problem", () => {
    const grants = runDoctor(setup({ config: {} }).opts);
    assert.deepEqual(grants.filter((c) => c.state === "problem").map((c) => [c.id, c.level]), [["grants-chain", "feature"], ["grants-path-rule", "hardening"]]);
    assert.equal(exitCode(grants), 0);
    const allows = runDoctor(setup({ config: { authorizerChain: ["toriel-grants"], permission: { "*": "allow", path: { "*": "allow", [GRANTS_RULE]: "ask" } } } }).opts);
    assert.deepEqual(allows.filter((c) => c.state === "problem").map((c) => [c.id, c.level]), [["scope-guard-short-circuit", "hardening"]]);
    assert.equal(exitCode(allows), 0);
    const noPackage = runDoctor(setup({ noPackage: true }).opts);
    assert.deepEqual(noPackage.filter((c) => c.state === "problem").map((c) => [c.id, c.level]), [["permission-package", "recommended"]]);
    assert.equal(exitCode(noPackage), 0);
    const noCli = runDoctor(setup({ noCli: true }).opts);
    assert.equal(exitCode(noCli), 1);
    assert.match(collectFindings(setup({ noCli: true }).opts)[0]?.message ?? "", /pi's cli\.js is not at .*cli\.js: run npm install/);
  });

  it("clipboard: only when a display is present, and only when its tool is missing", () => {
    const { opts } = setup({});
    const base = path.dirname(opts.agentDir as string);
    const bin = path.join(base, "bin");
    const nothing = fs.mkdtempSync(path.join(base, "empty-")); // not /bin: on Fedora it is a symlink to /usr/bin, which may hold the tools
    for (const tool of ["wl-paste", "wl-copy", "xclip"]) {
      fs.writeFileSync(path.join(bin, tool), "#!/bin/sh\n", { mode: 0o755 });
    }
    const finding = (env: NodeJS.ProcessEnv, pathDirs: readonly string[] = [env.PATH ?? ""]) => collectFindings({ ...opts, env, startup: [], pathDirs }).filter((f) => f.id === "clipboard");
    assert.deepEqual(finding({}), [], "no display, no clipboard finding");
    assert.equal(finding({ WAYLAND_DISPLAY: "wayland-0" }, [nothing]).length, 1, "wayland without wl-clipboard");
    assert.match(finding({ WAYLAND_DISPLAY: "wayland-0" }, [nothing])[0]?.message ?? "", /wl-clipboard/);
    assert.deepEqual(finding({ WAYLAND_DISPLAY: "wayland-0" }, [bin]), [], "wl-paste and wl-copy present");
    assert.equal(finding({ DISPLAY: ":0" }, [nothing]).length, 1, "x11 without xclip");
    assert.match(finding({ DISPLAY: ":0" }, [nothing])[0]?.message ?? "", /xclip/);
    assert.deepEqual(finding({ DISPLAY: ":0" }, [bin]), [], "xclip present");
  });

  it("truecolor: only for a real terminal without a truecolor signal", () => {
    const finding = (env: NodeJS.ProcessEnv, tty?: boolean) => collectFindings({ ...setup({}).opts, tty, env, startup: [] }).filter((f) => f.id === "truecolor");
    assert.deepEqual(finding({ TERM: "xterm-256color" }), [], "not a real terminal: skipped");
    assert.equal(finding({ TERM: "xterm-256color" }, true).length, 1);
    assert.match(finding({ TERM: "xterm-256color" }, true)[0]?.message ?? "", /truecolor/);
    assert.deepEqual(finding({ COLORTERM: "truecolor", TERM: "xterm-256color" }, true), [], "COLORTERM says truecolor");
    assert.deepEqual(finding({ TERM: "xterm-kitty" }, true), [], "a known truecolor terminal by name");
  });

  it("skips the checks that need the permission package when it is not there, and says so", () => {
    const checks = runDoctor(setup({ noPackage: true }).opts);
    assert.deepEqual(checks.filter((c) => c.state === "skipped").map((c) => c.id), ["grants-chain", "grants-path-rule", "permission-package-scope-patch", "scope-guard-short-circuit"]);
    assert.match(renderDoctor(checks), /skipped {2}permission grants are switched on[\s\S]*needs pi-permission-system/);
  });

  it("reports start-up problems it is handed, and settings problems", () => {
    const f = collectFindings({ ...setup({ settings: '{"scheduleDailyLimit":0}' }).opts, startup: ["XDG_RUNTIME_DIR is not set"] });
    assert.deepEqual(f.map((x) => [x.id, x.level]), [["startup", "required"], ["settings", "recommended"]]);
    assert.match(f[1]?.message ?? "", /^toriel settings: scheduleDailyLimit must be a number of at least 1/);
  });

  it("asks for the git MCP server to be exposed directly, since pi gives an agent no tool from a codemode server", () => {
    const grade = (gitMcp: string) => collectFindings(setup({ gitMcp }).opts).filter((x) => x.id === "mcp-git-direct");
    assert.deepEqual(grade("direct"), []);
    for (const bad of ["default", "codemode", "deferred"]) {
      const [f] = grade(bad);
      assert.equal(f?.level, "feature", bad);
      assert.match(f?.message ?? "", /advisory-diff, code-review and git-archaeology agents need an MCP server named "git".*"exposure": "direct"/, bad);
    }
    assert.match(grade("none")[0]?.message ?? "", /MCP server "git" is not configured/);
  });

  it("asks for pi-web-access when it is missing from pi's packages, since the research-web agent has no web tools without it", () => {
    assert.deepEqual(collectFindings(setup({}).opts).filter((x) => x.id === "web-package"), []);
    const [f] = collectFindings(setup({ noWeb: true }).opts).filter((x) => x.id === "web-package");
    assert.equal(f?.level, "feature");
    assert.match(f?.message ?? "", /advisory-diff and research-web agents need pi-web-access in the packages of .*settings\.json \(pi install npm:pi-web-access\)/);
    assert.equal(f?.fix, undefined);
  });

  it("asks for the gdb and ghidra MCP servers the same way, one check per server", () => {
    const grade = (id: string, over: object) => collectFindings(setup(over).opts).filter((x) => x.id === id);
    assert.deepEqual(grade("mcp-gdb-direct", {}), []);
    assert.deepEqual(grade("mcp-ghidra-direct", {}), []);
    const [gdb] = grade("mcp-gdb-direct", { gdbMcp: "codemode" });
    assert.equal(gdb?.level, "feature");
    assert.match(gdb?.message ?? "", /crash-analysis and debug agents need an MCP server named "gdb".*"exposure": "direct"/);
    assert.match(gdb?.fix?.summary ?? "", /set "exposure": "direct" on the "gdb" entry/, "the entry exists, only its exposure is wrong: fixable");
    const [missing] = grade("mcp-ghidra-direct", { ghidraMcp: "none" });
    assert.match(missing?.message ?? "", /binary-diff, re-explain, re-find and re-trace agents need an MCP server named "ghidra".*MCP server "ghidra" is not configured/);
    assert.equal(missing?.fix, undefined, "a missing entry needs the user's own command and args: no automatic fix");
    assert.deepEqual(grade("mcp-git-direct", { gdbMcp: "codemode", ghidraMcp: "none" }), [], "one server's problem is not another's");
  });

  it("asks for the sleep lock only on linux, and only when preventSleep is not off", () => {
    assert.deepEqual(collectFindings(setup({ noInhibit: true }).opts).map((x) => [x.id, x.level]), [["sleep-lock", "feature"]]);
    assert.deepEqual(collectFindings({ ...setup({ noInhibit: true }).opts, platform: "darwin" }), []);
    assert.deepEqual(collectFindings(setup({ noInhibit: true, settings: '{"preventSleep":false}' }).opts), []);
  });
});

describe("doctor report", () => {
  it("has a section per level, marks problems, and says which are fixable", () => {
    const text = renderDoctor(runDoctor(setup({ config: {} }).opts));
    assert.match(text, /^toriel doctor\n\nRequired \(toriel does not work without these\)\n {2}ok /);
    assert.match(text, /Optional features[\s\S]*PROBLEM {2}permission grants are switched on[\s\S]*\[fixable: add "toriel-grants" to "authorizerChain"\]/);
    assert.match(text, /Hardening[\s\S]*PROBLEM {2}an agent cannot edit the permission grants file/);
    assert.match(text, /2 problems, 2 fixable automatically \(toriel doctor --fix, or \/doctor --fix\)\.$/);
  });

  it("leaves the passing checks out of the compact report and counts them", () => {
    const text = renderDoctor(runDoctor(setup({ config: {} }).opts), { compact: true });
    assert.match(text, /Required: all 5 ok/);
    assert.match(text, /Recommended: all 2 ok/);
    assert.doesNotMatch(text, / ok {7}/);
    assert.match(text, /Optional features[\s\S]*PROBLEM {2}permission grants[\s\S]*\(7 ok\)/);
  });
});

describe("doctor report colours", () => {
  // one setup per test: its temp directory shows in the messages, so two setups would never read the same
  let found: ReturnType<typeof runDoctor>;
  beforeEach(() => {
    found = runDoctor(setup({ config: {} }).opts);
  });
  const checks = () => found;
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

  it("adds no escape codes unless asked", () => {
    assert.doesNotMatch(renderDoctor(checks()), /\x1b/);
  });

  it("colours ok green, PROBLEM red and the problem count red, and leaves the words the same", () => {
    const plain = renderDoctor(checks());
    const coloured = renderDoctor(checks(), { style: ANSI_STYLE });
    assert.equal(strip(coloured), plain);
    assert.match(coloured, /\x1b\[32mok {5}\x1b\[39m/);
    assert.match(coloured, /\x1b\[31mPROBLEM\x1b\[39m/);
    assert.match(coloured, /\x1b\[31m2 problems\x1b\[39m, 2 fixable/);
  });

  it("colours the compact report too, with the passing checks' count dim", () => {
    const coloured = renderDoctor(checks(), { compact: true, style: ANSI_STYLE });
    assert.match(coloured, /Required\x1b\[22m: \x1b\[32mall 5 ok\x1b\[39m/);
    assert.match(coloured, /\x1b\[2m {2}\(7 ok\)\x1b\[22m/);
  });
});

describe("doctor fixes", () => {
  it("adds the chain entry and the path rule, keeping a backup and the file's mode", () => {
    const s = setup({ config: { permission: { "*": "allow", bash: { "*": "allow", "sudo *": "ask" } } } });
    fs.chmodSync(s.config, 0o640);
    const original = fs.readFileSync(s.config, "utf8");
    const [group] = plannedFixes(runDoctor(s.opts));
    assert.equal(group?.file, s.config);
    assert.equal(group?.fixes.length, 2);
    const diff = previewFixes(s.config, group?.fixes ?? []);
    assert.match(diff, /\+ {3}"authorizerChain": \[/);
    assert.match(diff, /\+ {7}"~\/\.local\/share\/toriel\/permissions\.json": "ask"/);
    assert.doesNotMatch(diff, /\+ {7}"\*": "allow",/, "the fix no longer seeds an allow-all into a missing path section (an omitted fallback means ask)");
    assert.equal(fs.readFileSync(s.config, "utf8"), original, "previewing writes nothing");
    const backup = applyFixes(s.config, group?.fixes ?? [], new Date(2026, 10, 1, 9, 5, 7));
    assert.match(backup, /config\.json\.bak-20261101-090507$/);
    assert.equal(fs.readFileSync(backup, "utf8"), original);
    assert.equal(fs.statSync(s.config).mode & 0o777, 0o640);
    const now = JSON.parse(fs.readFileSync(s.config, "utf8"));
    assert.deepEqual(now.authorizerChain, ["toriel-grants"]);
    assert.deepEqual(now.permission.bash, { "*": "allow", "sudo *": "ask" }, "the user's own rules are untouched");
    assert.deepEqual(now.permission.path, { [GRANTS_RULE]: "ask" });
    assert.deepEqual(collectFindings(s.opts).map((f) => f.id), ["scope-guard-short-circuit"], "the grants problems are gone; the \"*\": allow fallback remains, and only a person should narrow it");
    assert.deepEqual(plannedFixes(runDoctor(s.opts)), [], "and there is nothing left to fix");
  });

  it("appends to an existing chain and path block, and turns an explicit allow on the file into ask", () => {
    const s = setup({ config: { authorizerChain: ["model-judge"], permission: { path: { "*.env": "deny", [GRANTS_RULE]: "allow" } } } });
    const [group] = plannedFixes(runDoctor(s.opts));
    applyFixes(s.config, group?.fixes ?? []);
    const now = JSON.parse(fs.readFileSync(s.config, "utf8"));
    assert.deepEqual(now.authorizerChain, ["model-judge", "toriel-grants"]);
    assert.deepEqual(Object.entries(now.permission.path), [["*.env", "deny"], [GRANTS_RULE, "ask"]], "the rule moves last so it wins");
    assert.deepEqual(collectFindings(s.opts), []);
  });

  it("does not touch a config it cannot read as a JSON object", () => {
    const s = setup({ config: { authorizerChain: ["toriel-grants"], permission: {} } });
    fs.writeFileSync(s.config, "{ not json");
    assert.throws(() => previewFixes(s.config, [{ file: s.config, summary: "x", edit: (c) => c }]));
    fs.writeFileSync(s.config, "[]");
    assert.throws(() => previewFixes(s.config, [{ file: s.config, summary: "x", edit: (c) => c }]), /not a JSON object/);
    assert.equal(fs.readFileSync(s.config, "utf8"), "[]");
    assert.deepEqual(fs.readdirSync(path.dirname(s.config)), ["config.json"], "no backup for a failed fix");
  });

  it("sets \"exposure\": \"direct\" on a mis-exposed mcp.json entry, leaving its siblings alone", () => {
    const s = setup({ gdbMcp: "codemode" });
    const mcp = path.join(s.agentDir, "mcp.json");
    const original = fs.readFileSync(mcp, "utf8");
    const [group] = plannedFixes(runDoctor(s.opts));
    assert.equal(group?.file, mcp);
    assert.equal(group?.fixes.length, 1);
    const diff = previewFixes(mcp, group?.fixes ?? []);
    assert.match(diff, /\+ {7}"exposure": "direct"/);
    assert.match(diff, /- {7}"exposure": "codemode"/);
    assert.equal(fs.readFileSync(mcp, "utf8"), original, "previewing writes nothing");
    applyFixes(mcp, group?.fixes ?? []);
    const now = JSON.parse(fs.readFileSync(mcp, "utf8"));
    assert.deepEqual(now.mcpServers.gdb, { command: "node", args: ["x"], exposure: "direct" });
    assert.deepEqual(now.mcpServers.git, { command: "node", args: ["x"], exposure: "direct" }, "the healthy sibling is untouched");
    assert.deepEqual(collectFindings(s.opts), [], "and the setup is healthy again");
  });

  it("offers no fix for the package, the files or the settings: those need a person", () => {
    assert.deepEqual(plannedFixes(runDoctor(setup({ noPackage: true, noCli: true, noResources: true }).opts)), []);
  });
});

describe("lineDiff", () => {
  it("is empty when nothing changes", () => {
    assert.equal(lineDiff("a\nb", "a\nb"), "");
  });

  it("marks added and removed lines with two lines of context and ellipses between distant changes", () => {
    const before = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"].join("\n");
    const after = ["1", "X", "3", "4", "5", "6", "7", "8", "Y", "10"].join("\n");
    assert.equal(lineDiff(before, after), ["  1", "- 2", "+ X", "  3", "  4", "  ...", "  7", "  8", "- 9", "+ Y", "  10"].join("\n"));
  });
});
