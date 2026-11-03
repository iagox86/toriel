import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildInfo, fingerprint } from "../src/build-id.ts";
import { type BuildInfo, PROTOCOL } from "../src/shared.ts";
import { compareDaemon, describeDaemon, type Hello } from "../src/version-check.ts";

const LOCAL: BuildInfo = { fingerprint: "aaaa", label: "1fa724e", dir: "/work/main" };
const hello = (over: Partial<Hello> = {}): Hello => ({ type: "hello", protocol: PROTOCOL, build: LOCAL, pid: 77, sock: "/run/toriel.sock", ...over });

describe("compareDaemon", () => {
  it("is fine when protocol and code are the same", () => {
    assert.deepEqual(compareDaemon(LOCAL, hello()), { level: "ok" });
  });

  it("only warns when the code differs, naming both checkouts and the daemon's pid", () => {
    const v = compareDaemon(LOCAL, hello({ build: { fingerprint: "bbbb", label: "9c0ffee+dirty", dir: "/work/branch" } }));
    assert.equal(v.level, "warn");
    assert.match((v as { text: string }).text, /9c0ffee\+dirty from \/work\/branch \(pid 77\).*1fa724e from \/work\/main/);
  });

  it("blocks when the protocols differ and says how far apart they are", () => {
    const v = compareDaemon(LOCAL, hello({ protocol: PROTOCOL + 3 }));
    assert.equal(v.level, "blocked");
    assert.match((v as { text: string }).text, new RegExp(`protocol ${PROTOCOL + 3}, this toriel ${PROTOCOL}`));
  });

  it("takes a missing hello as an older daemon, which is a warning because compatibility is unknown", () => {
    const v = compareDaemon(LOCAL, undefined);
    assert.equal(v.level, "warn");
    assert.match((v as { text: string }).text, /older than this toriel/);
  });

  it("always says what the fix costs and that nothing is restarted for you", () => {
    for (const h of [undefined, hello({ protocol: 0 }), hello({ build: { ...LOCAL, fingerprint: "zzzz" } })]) {
      const v = compareDaemon(LOCAL, h) as { text: string };
      assert.match(v.text, /toriel kill-server.*running sessions stop too.*nothing is restarted for you/);
    }
  });
});

describe("describeDaemon", () => {
  it("lists what runs where, marks an isolated instance, and ends with the verdict", () => {
    const h = hello({ profile: "branch" });
    const text = describeDaemon(LOCAL, h, compareDaemon(LOCAL, h));
    assert.match(text, /runs 1fa724e from \/work\/main \(pid 77, protocol \d+\), socket \/run\/toriel.sock, isolated instance "branch"/);
    assert.match(text, /same code and protocol: OK/);
  });

  it("says so when the daemon did not report anything", () => {
    assert.match(describeDaemon(LOCAL, undefined, compareDaemon(LOCAL, undefined)), /predates the version check[\s\S]*WARNING/);
  });
});

describe("fingerprint", () => {
  function checkout(files: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-fp-"));
    for (const [name, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), text);
    }
    return root;
  }

  it("is the same for the same code in another folder or with other timestamps", () => {
    const a = checkout({ "src/a.ts": "one", "pi/extensions/x.ts": "two" });
    const b = checkout({ "src/a.ts": "one", "pi/extensions/x.ts": "two" });
    fs.utimesSync(path.join(b, "src/a.ts"), 1, 1);
    assert.equal(fingerprint(a), fingerprint(b));
  });

  it("changes when a source file or an extension changes, or a file is added", () => {
    const base = fingerprint(checkout({ "src/a.ts": "one", "pi/extensions/x.ts": "two" }));
    assert.notEqual(base, fingerprint(checkout({ "src/a.ts": "ONE", "pi/extensions/x.ts": "two" })));
    assert.notEqual(base, fingerprint(checkout({ "src/a.ts": "one", "pi/extensions/x.ts": "TWO" })));
    assert.notEqual(base, fingerprint(checkout({ "src/a.ts": "one", "src/b.ts": "", "pi/extensions/x.ts": "two" })));
  });

  it("ignores files that are not code and is 'unknown' for a folder with none", () => {
    const withDocs = checkout({ "src/a.ts": "one", "src/notes.md": "x" });
    assert.equal(fingerprint(withDocs), fingerprint(checkout({ "src/a.ts": "one" })));
    assert.equal(fingerprint(checkout({})), "unknown");
  });
});

describe("buildInfo", () => {
  it("describes this checkout, with a label that is never empty", () => {
    const b = buildInfo();
    assert.ok(b.fingerprint.length > 0);
    assert.ok(b.label.length > 0);
    assert.equal(b.dir, path.join(import.meta.dirname, ".."));
  });

  it("falls back to the fingerprint as the label outside a git checkout", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-nogit-"));
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src/a.ts"), "x");
    const b = buildInfo(root);
    assert.equal(b.label, b.fingerprint);
  });
});
