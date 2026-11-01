import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { type DoctorIo, doctorMain, DOCTOR_USAGE } from "../src/doctor-cli.ts";
import { GOOD_CONFIG, setup as setupIn, tempHome } from "./doctor-fixture.ts";

let env: ReturnType<typeof tempHome>;
beforeEach(() => {
  env = tempHome();
});
afterEach(() => env.done());

function fakeIo(over: { interactive?: boolean; answer?: boolean } = {}) {
  const out: string[] = [];
  const asked: string[] = [];
  const io: DoctorIo = {
    write: (t) => void out.push(t),
    interactive: over.interactive ?? true,
    confirm: async (q) => {
      asked.push(q);
      return over.answer ?? false;
    },
  };
  return { io, text: () => out.join(""), asked };
}

const unfixed = { config: {} };

describe("toriel doctor (command line)", () => {
  it("prints usage for --help, and rejects an unknown argument with exit 2", async () => {
    const a = fakeIo();
    assert.equal(await doctorMain(["--help"], a.io), 0);
    assert.equal(a.text(), `${DOCTOR_USAGE}\n`);
    const b = fakeIo();
    assert.equal(await doctorMain(["--frobnicate"], b.io), 2);
    assert.match(b.text(), /unknown argument "--frobnicate"/);
  });

  it("stops at start-up problems, naming them, because the other checks need them", async () => {
    const a = fakeIo();
    assert.equal(await doctorMain([], a.io, { startup: ["dependencies are not installed (commander): run npm install in /x"] }), 1);
    assert.match(a.text(), /Required[\s\S]*PROBLEM {2}dependencies are not installed[\s\S]*Fix these first/);
    assert.doesNotMatch(a.text(), /Recommended/);
  });

  it("prints the report and exits 0 for a healthy setup, 0 for suggestions, 1 for a required problem", async () => {
    const healthy = fakeIo();
    assert.equal(await doctorMain([], healthy.io, setupIn(env.home, { config: GOOD_CONFIG }).opts), 0);
    assert.match(healthy.text(), /Everything checks out\./);
    const suggestions = fakeIo();
    assert.equal(await doctorMain([], suggestions.io, setupIn(env.home, unfixed).opts), 0);
    assert.match(suggestions.text(), /2 problems, 2 fixable/);
    const broken = fakeIo();
    assert.equal(await doctorMain([], broken.io, setupIn(env.home, { noCli: true }).opts), 1);
  });

  it("changes nothing without --fix", async () => {
    const s = setupIn(env.home, unfixed);
    const before = fs.readFileSync(s.config, "utf8");
    await doctorMain([], fakeIo().io, s.opts);
    assert.equal(fs.readFileSync(s.config, "utf8"), before);
  });

  it("with --fix --yes shows the diff, applies it, keeps a backup and re-checks", async () => {
    const s = setupIn(env.home, unfixed);
    const t = fakeIo();
    assert.equal(await doctorMain(["--fix", "--yes"], t.io, s.opts), 0);
    assert.match(t.text(), /\+ {3}"authorizerChain": \[/);
    assert.match(t.text(), /Applied\. The original is at .*config\.json\.bak-\d{8}-\d{6}/);
    assert.match(t.text(), /After fixing:[\s\S]*Everything checks out\./);
    assert.deepEqual(JSON.parse(fs.readFileSync(s.config, "utf8")).authorizerChain, ["toriel-grants"]);
    assert.equal(fs.readdirSync(path.dirname(s.config)).filter((f) => f.includes(".bak-")).length, 1);
    assert.equal(t.asked.length, 0, "--yes does not ask");
  });

  it("with --fix asks first, and applies only on a yes", async () => {
    const no = setupIn(env.home, unfixed);
    const a = fakeIo({ answer: false });
    await doctorMain(["--fix"], a.io, no.opts);
    assert.equal(a.asked.length, 1);
    assert.match(a.text(), /Not applied\./);
    assert.deepEqual(JSON.parse(fs.readFileSync(no.config, "utf8")), {});
    const yes = setupIn(env.home, unfixed);
    const b = fakeIo({ answer: true });
    await doctorMain(["--fix"], b.io, yes.opts);
    assert.deepEqual(JSON.parse(fs.readFileSync(yes.config, "utf8")).authorizerChain, ["toriel-grants"]);
  });

  it("with --fix and nobody at the terminal refuses to guess, and says to pass --yes", async () => {
    const s = setupIn(env.home, unfixed);
    const t = fakeIo({ interactive: false });
    await doctorMain(["--fix"], t.io, s.opts);
    assert.match(t.text(), /Not applied: nobody is at the terminal to confirm \(pass --yes to apply\)/);
    assert.equal(t.asked.length, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(s.config, "utf8")), {});
  });

  it("with --fix says when nothing can be fixed automatically", async () => {
    const nothing = fakeIo();
    assert.equal(await doctorMain(["--fix"], nothing.io, setupIn(env.home, { noPackage: true }).opts), 0);
    assert.match(nothing.text(), /Nothing here can be fixed automatically\./);
  });
});
