import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { applyFixes, CATALOG, collectFindings, type DoctorOptions, exitCode, lineDiff, plannedFixes, previewFixes, renderDoctor, runDoctor } from "../src/doctor.ts";
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

  it("grades what it finds, and exits 1 only for a required problem", () => {
    const grants = runDoctor(setup({ config: {} }).opts);
    assert.deepEqual(grants.filter((c) => c.state === "problem").map((c) => [c.id, c.level]), [["grants-chain", "feature"], ["grants-path-rule", "hardening"]]);
    assert.equal(exitCode(grants), 0);
    const noPackage = runDoctor(setup({ noPackage: true }).opts);
    assert.deepEqual(noPackage.filter((c) => c.state === "problem").map((c) => [c.id, c.level]), [["permission-package", "recommended"]]);
    assert.equal(exitCode(noPackage), 0);
    const noCli = runDoctor(setup({ noCli: true }).opts);
    assert.equal(exitCode(noCli), 1);
    assert.match(collectFindings(setup({ noCli: true }).opts)[0]?.message ?? "", /pi's cli\.js is not at .*cli\.js: run npm install/);
  });

  it("skips the checks that need the permission package when it is not there, and says so", () => {
    const checks = runDoctor(setup({ noPackage: true }).opts);
    assert.deepEqual(checks.filter((c) => c.state === "skipped").map((c) => c.id), ["grants-chain", "grants-path-rule"]);
    assert.match(renderDoctor(checks), /skipped {2}permission grants are switched on[\s\S]*needs pi-permission-system/);
  });

  it("reports start-up problems it is handed, and settings problems", () => {
    const f = collectFindings({ ...setup({ settings: '{"scheduleDailyLimit":0}' }).opts, startup: ["XDG_RUNTIME_DIR is not set"] });
    assert.deepEqual(f.map((x) => [x.id, x.level]), [["startup", "required"], ["settings", "recommended"]]);
    assert.match(f[1]?.message ?? "", /^toriel settings: scheduleDailyLimit must be a number of at least 1/);
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
    assert.match(text, /Optional features[\s\S]*PROBLEM {2}permission grants[\s\S]*\(1 ok\)/);
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
    assert.match(diff, /\+ {7}"\*": "allow",/);
    assert.equal(fs.readFileSync(s.config, "utf8"), original, "previewing writes nothing");
    const backup = applyFixes(s.config, group?.fixes ?? [], new Date(2026, 10, 1, 9, 5, 7));
    assert.match(backup, /config\.json\.bak-20261101-090507$/);
    assert.equal(fs.readFileSync(backup, "utf8"), original);
    assert.equal(fs.statSync(s.config).mode & 0o777, 0o640);
    const now = JSON.parse(fs.readFileSync(s.config, "utf8"));
    assert.deepEqual(now.authorizerChain, ["toriel-grants"]);
    assert.deepEqual(now.permission.bash, { "*": "allow", "sudo *": "ask" }, "the user's own rules are untouched");
    assert.deepEqual(now.permission.path, { "*": "allow", [GRANTS_RULE]: "ask" });
    assert.deepEqual(collectFindings(s.opts), [], "the same check now passes");
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
