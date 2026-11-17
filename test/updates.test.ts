import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { updateMain } from "../src/update-cli.ts";
import { type Runner, applyUpdates, collect, compareVersions, installArgs, isBehind, npmNameOf, renderReport, withLatest } from "../src/updates.ts";

function pkg(dir: string, name: string, version: string): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "package.json"), JSON.stringify({ name, version }));
}

/** A toriel checkout, a pi config directory and a global node_modules, all temporary. */
function setup(opts: { listed?: unknown[] } = {}) {
  const base = mkdtempSync(join(tmpdir(), "updates-"));
  const root = join(base, "root");
  const agentDir = join(base, "agent");
  const globalRoot = join(base, "global");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(root, { recursive: true });
  const deps = {
    "@earendil-works/pi-coding-agent": "1.4.0",
    "@earendil-works/pi-tui": "1.4.0",
    "pi-web-access": "0.48.0",
    "@gotgenes/pi-permission-system": "42.0.0",
    "pi-hermes-memory": "0.11.0",
    "@juicesharp/rpiv-ask-user-question": "2.15.0",
  };
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: deps }));
  writeFileSync(join(root, "package-lock.json"), "LOCK-ORIGINAL");
  const modules = join(root, "node_modules");
  for (const [n, v] of Object.entries(deps)) {
    pkg(modules, n, v);
  }
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: opts.listed ?? [] }));
  return { base, root, agentDir, globalRoot };
}

const LATEST: Record<string, string> = {
  "@earendil-works/pi-coding-agent": "1.5.2",
  "pi-web-access": "0.48.0",
  "@gotgenes/pi-permission-system": "42.0.0",
  "pi-hermes-memory": "0.12.0",
  "@juicesharp/rpiv-ask-user-question": "2.15.0",
  "pi-user-extra": "42.1.0",
};
const fetcher = async (name: string): Promise<string> => {
  const v = LATEST[name];
  if (v === undefined) {
    throw new Error("registry answered 404");
  }
  return v;
};

describe("compareVersions", () => {
  it("orders numerically, not as text, and puts a prerelease below its release", () => {
    assert.equal(compareVersions("1.4.0", "1.5.2"), -1);
    assert.equal(compareVersions("1.10.0", "1.9.0"), 1);
    assert.equal(compareVersions("1.4", "1.4.0"), 0);
    assert.equal(compareVersions("2.0.0-beta.1", "2.0.0"), -1);
  });
});

describe("npmNameOf", () => {
  it("takes the name out of an npm entry and ignores the rest", () => {
    assert.equal(npmNameOf("npm:pi-web-access"), "pi-web-access");
    assert.equal(npmNameOf("npm:pi-user-extra@42.0.0"), "pi-user-extra");
    assert.equal(npmNameOf({ source: "npm:foo" }), "foo");
    assert.equal(npmNameOf("git:github.com/x/y"), undefined);
    assert.equal(npmNameOf("/home/me/pkg"), undefined);
  });
});

describe("collect", () => {
  it("reads pi, the bundled packages and the user's own", () => {
    const s = setup({ listed: ["npm:pi-user-extra", "git:github.com/x/y"] });
    pkg(s.globalRoot, "pi-user-extra", "42.0.0");
    const cs = collect(s);
    assert.deepEqual(cs.map((c) => `${c.kind}:${c.name}`), [
      "pi:pi",
      "bundled:@juicesharp/rpiv-ask-user-question",
      "bundled:pi-web-access",
      "bundled:@gotgenes/pi-permission-system",
      "bundled:pi-hermes-memory",
      "user:pi-user-extra",
    ]);
    assert.equal(cs[0]?.installed, "1.4.0");
    assert.deepEqual(cs[0]?.packages, ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]);
    assert.equal(cs[5]?.installed, "42.0.0");
    assert.equal(cs.some((c) => c.shadowed), false);
  });

  it("flags a bundled package the user lists too, and says which version actually runs", () => {
    const s = setup({ listed: ["npm:pi-web-access"] });
    pkg(s.globalRoot, "pi-web-access", "0.40.0");
    const web = collect(s).find((c) => c.name === "pi-web-access");
    assert.equal(web?.shadowed, true);
    assert.equal(web?.runs, "0.40.0");
    assert.equal(collect(s).filter((c) => c.name === "pi-web-access").length, 1, "listed once, as the bundled one");
    assert.match(renderReport(collect(s)), /SHADOWED.*yours is 0\.40\.0/);
  });
});

describe("withLatest", () => {
  it("asks npm once per package, caches for a day and refreshes on request", async () => {
    const s = setup();
    const cache = join(s.base, "cache", "updates.json");
    let asked = 0;
    const counting = async (n: string) => {
      asked++;
      return fetcher(n);
    };
    const first = await withLatest(collect(s), { fetcher: counting, cache, now: 1000 });
    assert.equal(first[0]?.latest, "1.5.2");
    const after = asked;
    await withLatest(collect(s), { fetcher: counting, cache, now: 2000 });
    assert.equal(asked, after, "a fresh cache answers without asking");
    await withLatest(collect(s), { fetcher: counting, cache, now: 2000, refresh: true });
    assert.equal(asked, after * 2, "--refresh asks again");
    await withLatest(collect(s), { fetcher: counting, cache, now: 1000 + 25 * 3600 * 1000 });
    assert.equal(asked, after * 3, "a day later it asks again");
  });

  it("makes a failed lookup a problem on that component only", async () => {
    const s = setup({ listed: ["npm:not-a-package"] });
    const cs = await withLatest(collect(s), { fetcher });
    const bad = cs.find((c) => c.name === "not-a-package");
    assert.match(bad?.problem ?? "", /could not ask npm: registry answered 404/);
    assert.equal(cs[0]?.problem, undefined);
  });
});

describe("renderReport", () => {
  it("says what is behind and how to update it, and leaves the user's own packages to pi", async () => {
    const s = setup({ listed: ["npm:pi-user-extra"] });
    pkg(s.globalRoot, "pi-user-extra", "42.0.0");
    const cs = await withLatest(collect(s), { fetcher });
    const text = renderReport(cs);
    assert.match(text, /pi\s+1\.4\.0\s+1\.5\.2\s+update available: 1\.5\.2/);
    assert.match(text, /pi-hermes-memory\s+0\.11\.0\s+0\.12\.0\s+update available: 0\.12\.0/);
    assert.match(text, /pi-user-extra\s+42\.0\.0\s+42\.1\.0\s+update available/);
    assert.match(text, /Update with: toriel update pi pi-hermes-memory\b/);
    assert.equal(cs.filter(isBehind).length, 3);
  });
});

function fakeRunner(failing: string[] = []): { runner: Runner; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    runner: {
      run: async (cmd, args) => {
        calls.push(`${cmd} ${args.join(" ")}`);
        return failing.includes(args.join(" ")) ? { code: 1, output: "boom" } : { code: 0, output: "" };
      },
    },
  };
}

describe("applyUpdates", () => {
  it("installs exact versions, then typechecks and tests", async () => {
    const s = setup();
    const cs = (await withLatest(collect(s), { fetcher })).filter((c) => c.name === "pi");
    assert.deepEqual(installArgs(cs), ["@earendil-works/pi-coding-agent@1.5.2", "@earendil-works/pi-tui@1.5.2"]);
    const f = fakeRunner();
    const chunks: string[] = [];
    const code = await applyUpdates(cs, { root: s.root, runner: f.runner, write: (t) => void chunks.push(t) });
    assert.equal(code, 0);
    assert.deepEqual(f.calls, [
      "npm install --save-exact @earendil-works/pi-coding-agent@1.5.2 @earendil-works/pi-tui@1.5.2",
      "npm run typecheck",
      "npm run test",
    ]);
    assert.match(chunks.join(""), /pi 1\.4\.0 -> 1\.5\.2/);
    assert.match(chunks.join(""), /kill-server/);
  });

  it("puts package.json and the lockfile back and reinstalls when the tests fail", async () => {
    const s = setup();
    const cs = (await withLatest(collect(s), { fetcher })).filter((c) => c.name === "pi");
    const before = readFileSync(join(s.root, "package.json"), "utf8");
    // the install changes both files; then the tests fail
    const calls: string[] = [];
    const runner: Runner = {
      run: async (_cmd, args, cwd) => {
        calls.push(args.join(" "));
        if (args[0] === "install") {
          writeFileSync(join(cwd, "package.json"), "CHANGED");
          writeFileSync(join(cwd, "package-lock.json"), "CHANGED");
        }
        return args[1] === "test" ? { code: 1, output: "not ok 3" } : { code: 0, output: "" };
      },
    };
    const chunks: string[] = [];
    const code = await applyUpdates(cs, { root: s.root, runner, write: (t) => void chunks.push(t) });
    assert.equal(code, 1);
    assert.equal(readFileSync(join(s.root, "package.json"), "utf8"), before);
    assert.equal(readFileSync(join(s.root, "package-lock.json"), "utf8"), "LOCK-ORIGINAL");
    assert.equal(calls.at(-1), "ci");
    assert.match(chunks.join(""), /npm run test failed after the bump/);
    assert.match(chunks.join(""), /nothing changed/);
  });

  it("skips the checks with noTest", async () => {
    const s = setup();
    const cs = (await withLatest(collect(s), { fetcher })).filter((c) => c.name === "pi");
    const f = fakeRunner();
    await applyUpdates(cs, { root: s.root, runner: f.runner, noTest: true, write: () => {} });
    assert.equal(f.calls.length, 1);
  });
});

describe("updateMain", () => {
  const run = async (args: string[], listed: unknown[] = []) => {
    const s = setup({ listed });
    pkg(s.globalRoot, "pi-user-extra", "42.0.0");
    const f = fakeRunner();
    const chunks: string[] = [];
    const code = await updateMain(args, { write: (t) => void chunks.push(t) }, { ...s, fetcher, runner: f.runner });
    return { code, out: chunks.join(""), calls: f.calls };
  };

  it("prints the report by default and changes nothing", async () => {
    const r = await run([]);
    assert.equal(r.code, 0);
    assert.match(r.out, /toriel update status/);
    assert.deepEqual(r.calls, []);
  });

  it("bumps what is named, and only what is behind", async () => {
    const r = await run(["pi", "pi-web-access"]);
    assert.equal(r.code, 0);
    assert.match(r.out, /pi-web-access: already up to date/);
    assert.match(r.calls[0] ?? "", /^npm install --save-exact @earendil-works\/pi-coding-agent@1\.5\.2/);
  });

  it("`all` bumps every behind component of toriel's own, never the user's packages", async () => {
    const r = await run(["all"], ["npm:pi-user-extra"]);
    const install = r.calls[0] ?? "";
    assert.match(install, /pi-hermes-memory@0\.12\.0/);
    assert.match(install, /pi-coding-agent@1\.5\.2/);
    assert.doesNotMatch(install, /gotgenes/);
  });

  it("sends the user to `pi update` for their own package and refuses an unknown name", async () => {
    const own = await run(["pi-user-extra"], ["npm:pi-user-extra"]);
    assert.equal(own.code, 2);
    assert.match(own.out, /pi update/);
    const unknown = await run(["nope"]);
    assert.equal(unknown.code, 2);
    assert.match(unknown.out, /no such component "nope"/);
    assert.deepEqual(unknown.calls, []);
  });

  it("rejects an unknown option", async () => {
    const r = await run(["--wat"]);
    assert.equal(r.code, 2);
    assert.match(r.out, /usage: toriel update/);
  });
});
