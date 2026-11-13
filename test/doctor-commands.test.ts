import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseCommandLine } from "../src/cli.ts";
import { SESSION_COMMANDS, SWITCHER_COMMANDS } from "../src/commands.ts";
import { runDoctorCommand } from "../src/doctor-commands.ts";
import type { Host } from "../src/host.ts";
import { setup as setupIn, tempHome } from "./doctor-fixture.ts";

let env: ReturnType<typeof tempHome>;
beforeEach(() => {
  env = tempHome();
});
afterEach(() => env.done());

function fakeHost() {
  const panels: string[] = [];
  const raw: string[] = [];
  const notices: string[] = [];
  const choices: Array<{ title: string; options: string[]; pick: (c: string) => void }> = [];
  const host = {
    notify: (m: string) => void notices.push(m),
    daemonReport: () => "Daemon\n  (test)",
    tui: { requestRender: () => {} },
    // the tests below are about the words; the colours have their own test
    infoPanel: {
      show: (t: string) => {
        raw.push(t);
        panels.push(t.replace(/\x1b\[[0-9;]*m/g, ""));
      },
    },
    choicePanel: { open: (title: string, options: string[], _current: unknown, pick: (c: string) => void) => void choices.push({ title, options, pick }) },
  };
  return { host: host as unknown as Host, panels, raw, notices, choices };
}

const call = (fix: boolean) => ({ args: [], opts: fix ? { fix: true } : {} });

describe("/doctor", () => {
  it("is declared once and available in a session and in the switcher, with --help", () => {
    for (const specs of [SESSION_COMMANDS, SWITCHER_COMMANDS]) {
      const r = parseCommandLine(specs, "/doctor --help");
      assert.equal(r.kind, "help");
      assert.match((r as { text: string }).text, /--fix[\s\S]*never installs packages/);
      assert.equal(parseCommandLine(specs, "/doctor --fix").kind, "run");
    }
  });

  it("colours the panel with the controller theme: problems and passes get colours, the words stay the same", () => {
    const t = fakeHost();
    runDoctorCommand(t.host, call(false), setupIn(env.home, { config: {} }).opts);
    assert.match(t.raw[0] ?? "", /\x1b\[[0-9;]*mPROBLEM\x1b\[39m/);
    assert.match(t.raw[0] ?? "", /\x1b\[[0-9;]*mall 5 ok\x1b\[39m/);
    assert.doesNotMatch(t.panels[0] ?? "", /\x1b/);
  });

  it("shows the compact report in a panel and changes nothing", () => {
    const s = setupIn(env.home, { config: {} });
    const before = fs.readFileSync(s.config, "utf8");
    const t = fakeHost();
    runDoctorCommand(t.host, call(false), s.opts);
    assert.equal(t.panels.length, 1);
    assert.match(t.panels[0] ?? "", /Required: all 5 ok[\s\S]*PROBLEM {2}permission grants are switched on/);
    assert.equal(t.choices.length, 0);
    assert.equal(fs.readFileSync(s.config, "utf8"), before);
  });

  it("with --fix shows the proposed diff and asks; Cancel changes nothing", () => {
    const s = setupIn(env.home, { config: {} });
    const t = fakeHost();
    runDoctorCommand(t.host, call(true), s.opts);
    assert.match(t.panels[0] ?? "", /Proposed changes:[\s\S]*add "toriel-grants" to "authorizerChain"[\s\S]*\+ {3}"authorizerChain"/);
    assert.deepEqual(t.choices[0]?.options, ["Apply", "Cancel"]);
    t.choices[0]?.pick("Cancel");
    assert.deepEqual(JSON.parse(fs.readFileSync(s.config, "utf8")), {});
    assert.match(t.notices[0] ?? "", /nothing changed/);
  });

  it("with --fix, Apply writes the change, keeps the original, says so and shows the report again", () => {
    const s = setupIn(env.home, { config: {} });
    const t = fakeHost();
    runDoctorCommand(t.host, call(true), s.opts);
    t.choices[0]?.pick("Apply");
    assert.match(t.notices[0] ?? "", /changed .*config\.json \(original kept at .*config\.json\.bak-\d{8}-\d{6}\)/);
    assert.deepEqual(JSON.parse(fs.readFileSync(s.config, "utf8")).authorizerChain, ["toriel-grants"]);
    assert.equal(fs.readdirSync(path.dirname(s.config)).filter((f) => f.includes(".bak-")).length, 1);
    assert.match(t.panels.at(-1) ?? "", /Required: all 5 ok[\s\S]*Optional features: all 10 ok[\s\S]*Hardening: all 3 ok[\s\S]*Everything checks out\./, "the fix no longer seeds an allow, so the re-check is clean");
  });

  it("with --fix says when nothing is automatic, and offers no fix for a config of an unusual shape", () => {
    const none = fakeHost();
    runDoctorCommand(none.host, call(true), setupIn(env.home, { noPackage: true }).opts);
    assert.match(none.panels[0] ?? "", /Nothing here can be fixed automatically\./);
    assert.equal(none.choices.length, 0);
    const odd = fakeHost();
    runDoctorCommand(odd.host, call(true), setupIn(env.home, { config: { authorizerChain: "toriel-grants", permission: { path: "nope" } } }).opts);
    assert.match(odd.panels[0] ?? "", /PROBLEM/);
    assert.equal(odd.choices.length, 0);
  });
});
