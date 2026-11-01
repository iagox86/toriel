import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { cappedReason, GrantStore, isCappedSurface } from "../src/permissions.ts";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";

let dir: string;
let file: string;
let t: number;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-grants-"));
  file = path.join(dir, "permissions.json");
  t = T0;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const make = (limits?: { perSession: number }) => new GrantStore(file, () => t, limits);

describe("GrantStore", () => {
  it("makes a grant active at once and lists it with its expiry", () => {
    const s = make();
    const g = s.add({ session: A, surface: "bash", pattern: "git status", expiresIn: HOUR, source: "dialog" });
    assert.equal(g.id, 1);
    assert.equal(g.expiresAt, T0 + HOUR);
    assert.deepEqual(s.list(A).map((x) => x.pattern), ["git status"]);
    assert.equal(s.isDormant(g.id), false);
    assert.equal(s.covers(A, [{ surface: "bash", pattern: "git status" }])?.length, 1);
  });

  it("covers an ask only when every suggested pair has a grant in the same session", () => {
    const s = make();
    s.add({ session: A, surface: "bash", pattern: "ls" });
    assert.equal(s.covers(A, [{ surface: "bash", pattern: "ls" }, { surface: "bash", pattern: "rm x" }]), undefined);
    assert.equal(s.covers(B, [{ surface: "bash", pattern: "ls" }]), undefined);
    assert.equal(s.covers(A, [{ surface: "mcp", pattern: "ls" }]), undefined);
    assert.equal(s.covers(A, []), undefined);
  });

  it("matches the pattern exactly, not as a wildcard", () => {
    const s = make();
    s.add({ session: A, surface: "bash", pattern: "git *" });
    assert.equal(s.covers(A, [{ surface: "bash", pattern: "git status" }]), undefined);
    assert.equal(s.covers(A, [{ surface: "bash", pattern: "git *" }])?.length, 1);
  });

  it("stops covering once a timed grant has expired, and sweep reports what lapsed", () => {
    const s = make();
    const g = s.add({ session: A, surface: "bash", pattern: "ls", expiresIn: HOUR });
    t = T0 + HOUR - 1;
    assert.ok(s.covers(A, [{ surface: "bash", pattern: "ls" }]));
    t = T0 + HOUR;
    assert.equal(s.covers(A, [{ surface: "bash", pattern: "ls" }]), undefined);
    assert.deepEqual(s.list(A), []);
    assert.deepEqual(s.sweep().map((x) => x.id), [g.id]);
    assert.deepEqual(s.sweep(), []);
  });

  it("updates the same surface and pattern instead of duplicating it", () => {
    const s = make();
    const first = s.add({ session: A, surface: "bash", pattern: "ls", expiresIn: HOUR });
    const again = s.add({ session: A, surface: "bash", pattern: "ls", expiresIn: 2 * HOUR });
    assert.equal(again.id, first.id);
    assert.equal(s.list(A).length, 1);
    assert.equal(again.expiresAt, T0 + 2 * HOUR);
    const forever = s.add({ session: A, surface: "bash", pattern: "ls" });
    assert.equal(forever.expiresAt, null);
  });

  it("refuses file-path surfaces, naming why", () => {
    const s = make();
    for (const surface of ["path", "path_write", "external_directory", "external_directory_read"]) {
      assert.ok(isCappedSurface(surface), surface);
      assert.throws(() => s.add({ session: A, surface, pattern: "/tmp/*" }), /file-path/);
    }
    assert.equal(isCappedSurface("bash"), false);
    assert.equal(isCappedSurface("pathology"), false);
    assert.equal(cappedReason("bash"), undefined);
    assert.equal(s.covers(A, [{ surface: "path_write", pattern: "/tmp/*" }]), undefined);
  });

  it("needs a surface and a pattern", () => {
    const s = make();
    assert.throws(() => s.add({ session: A, surface: " ", pattern: "ls" }), /surface/);
    assert.throws(() => s.add({ session: A, surface: "bash", pattern: "" }), /pattern/);
  });

  it("caps the grants per session", () => {
    const s = make({ perSession: 2 });
    s.add({ session: A, surface: "bash", pattern: "a" });
    s.add({ session: A, surface: "bash", pattern: "b" });
    assert.throws(() => s.add({ session: A, surface: "bash", pattern: "c" }), /already has 2/);
    s.add({ session: B, surface: "bash", pattern: "c" });
  });

  it("revokes one grant, and removes a whole session's", () => {
    const s = make();
    const a = s.add({ session: A, surface: "bash", pattern: "a" });
    s.add({ session: A, surface: "bash", pattern: "b" });
    s.add({ session: B, surface: "bash", pattern: "c" });
    assert.equal(s.revoke(a.id)?.pattern, "a");
    assert.equal(s.revoke(a.id), undefined);
    assert.equal(s.removeSession(A).length, 1);
    assert.deepEqual(s.list().map((x) => x.session), [B]);
  });

  it("reports the soonest expiry of timed grants only", () => {
    const s = make();
    s.add({ session: A, surface: "bash", pattern: "a" });
    assert.equal(s.soonestExpiry(A), undefined);
    s.add({ session: A, surface: "bash", pattern: "b", expiresIn: 2 * HOUR });
    s.add({ session: A, surface: "bash", pattern: "c", expiresIn: HOUR });
    assert.equal(s.soonestExpiry(A), T0 + HOUR);
  });
});

describe("GrantStore persistence", () => {
  it("writes the file owner-only", () => {
    make().add({ session: A, surface: "bash", pattern: "ls" });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  it("restores saved grants dormant: they do nothing until restore", () => {
    make().add({ session: A, surface: "bash", pattern: "ls", expiresIn: HOUR });
    const after = make();
    after.load();
    const [g] = after.list(A);
    assert.ok(g);
    assert.equal(after.isDormant(g.id), true);
    assert.equal(after.dormantCount(A), 1);
    assert.deepEqual(after.active(A), []);
    assert.equal(after.covers(A, [{ surface: "bash", pattern: "ls" }]), undefined);
    assert.equal(after.restore(A), 1);
    assert.equal(after.restore(A), 0);
    assert.equal(after.dormantCount(A), 0);
    assert.ok(after.covers(A, [{ surface: "bash", pattern: "ls" }]));
  });

  it("restores only the named session", () => {
    const s = make();
    s.add({ session: A, surface: "bash", pattern: "a" });
    s.add({ session: B, surface: "bash", pattern: "b" });
    const after = make();
    after.load();
    after.restore(A);
    assert.equal(after.dormantCount(A), 0);
    assert.equal(after.dormantCount(B), 1);
  });

  it("drops grants that expired while the daemon was down, and keeps ids growing", () => {
    const s = make();
    s.add({ session: A, surface: "bash", pattern: "short", expiresIn: HOUR });
    s.add({ session: A, surface: "bash", pattern: "long" });
    t = T0 + 2 * HOUR;
    const after = make();
    after.load();
    assert.deepEqual(after.list(A).map((x) => x.pattern), ["long"]);
    assert.equal(after.add({ session: A, surface: "bash", pattern: "new" }).id, 3);
  });

  it("a grant made after a restart is active while the saved ones stay dormant", () => {
    make().add({ session: A, surface: "bash", pattern: "old" });
    const after = make();
    after.load();
    const fresh = after.add({ session: A, surface: "bash", pattern: "fresh" });
    assert.equal(after.isDormant(fresh.id), false);
    assert.ok(after.covers(A, [{ surface: "bash", pattern: "fresh" }]));
    assert.equal(after.covers(A, [{ surface: "bash", pattern: "old" }]), undefined);
  });

  it("re-adding a dormant grant makes it active", () => {
    make().add({ session: A, surface: "bash", pattern: "ls", expiresIn: HOUR });
    const after = make();
    after.load();
    after.add({ session: A, surface: "bash", pattern: "ls", expiresIn: HOUR });
    assert.equal(after.dormantCount(A), 0);
    assert.ok(after.covers(A, [{ surface: "bash", pattern: "ls" }]));
  });

  it("ignores a missing, broken or hand-edited file instead of trusting it", () => {
    const s = make();
    s.load();
    assert.deepEqual(s.list(), []);
    fs.writeFileSync(file, "not json");
    const broken = make();
    broken.load();
    assert.deepEqual(broken.list(), []);
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        nextId: 5,
        grants: [
          { id: 1, session: A, surface: "bash", pattern: "ok", createdAt: 1, expiresAt: null, source: "command" },
          { id: 2, session: A, surface: "path_write", pattern: "/*", createdAt: 1, expiresAt: null, source: "command" },
          { id: 3, session: A, surface: "bash" },
          "junk",
        ],
      }),
    );
    const edited = make();
    edited.load();
    assert.deepEqual(edited.list().map((x) => x.pattern), ["ok"]);
    assert.equal(edited.dormantCount(A), 1);
  });
});
