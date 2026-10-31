import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const LAUNCHER = path.join(import.meta.dirname, "..", "bin", "toriel");

/** A copy of the repo layout the launcher expects, with a stub node that reports its own bin dir. */
function fixture(nvmrc: string, installed: string[]): { link: string; env: NodeJS.ProcessEnv } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-launch-"));
  const root = path.join(dir, "repo");
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.copyFileSync(LAUNCHER, path.join(root, "bin", "toriel"));
  fs.chmodSync(path.join(root, "bin", "toriel"), 0o755);
  fs.writeFileSync(path.join(root, ".nvmrc"), `${nvmrc}\n`);
  fs.writeFileSync(path.join(root, "toriel.ts"), "");
  const nvm = path.join(dir, "nvm");
  for (const v of installed) {
    const bin = path.join(nvm, "versions", "node", v, "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "node"), `#!/bin/sh\nif [ "$1" = --version ]; then echo ${v}; else echo "ran ${v} $*"; fi\n`, { mode: 0o755 });
  }
  const link = path.join(dir, "elsewhere", "toriel");
  fs.mkdirSync(path.dirname(link));
  fs.symlinkSync(path.join(root, "bin", "toriel"), link);
  // PATH holds only a stub node that is too old, plus the basics the script uses
  const oldBin = path.join(dir, "old");
  fs.mkdirSync(oldBin);
  fs.writeFileSync(path.join(oldBin, "node"), "#!/bin/sh\necho v20.1.0\n", { mode: 0o755 });
  const tools = ["sh", "dirname", "readlink", "tr", "cut", "sed", "ls", "sort", "tail", "cat"].map((t) => {
    const p = execFileSync("sh", ["-c", `command -v ${t}`], { encoding: "utf8" }).trim();
    fs.symlinkSync(p, path.join(oldBin, t));
    return t;
  });
  assert.ok(tools.length > 0);
  return { link, env: { PATH: oldBin, NVM_DIR: nvm, HOME: dir } };
}

describe("bin/toriel launcher", () => {
  it("runs through a symlink, with the node named by .nvmrc when the one on PATH is older, passing arguments on", () => {
    const { link, env } = fixture("v26.12.0", ["v24.1.0", "v26.3.0", "v26.12.0"]);
    const r = spawnSync(link, ["kill-server"], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^ran v26\.12\.0 .*\/repo\/toriel\.ts kill-server$/m);
  });

  it("says what to install when no suitable node exists", () => {
    const { link, env } = fixture("v26.12.0", ["v24.1.0"]);
    const r = spawnSync(link, [], { env, encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /needs node 26 or newer \(found: 20\); install it with: nvm install 26/);
  });
});
