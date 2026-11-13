import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { answerablePrompt, touchesProtected } from "../src/daemon-permissions.ts";
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
    s.add({ session: A, surface: "bash", pattern: "l*" });
    assert.ok(s.covers(A, [{ surface: "bash", pattern: "ls" }]));
    assert.equal(s.covers(A, [{ surface: "bash", pattern: "ls" }, { surface: "bash", pattern: "rm x" }]), undefined);
    assert.equal(s.covers(B, [{ surface: "bash", pattern: "ls" }]), undefined);
    assert.equal(s.covers(A, [{ surface: "mcp", pattern: "ls" }]), undefined);
    assert.equal(s.covers(A, []), undefined);
  });

  it("covers an ask with a wider grant pattern: `git *` covers `git status`, `git *` and `git checkout main`", () => {
    const s = make();
    s.add({ session: A, surface: "bash", pattern: "git *" });
    assert.ok(s.covers(A, [{ surface: "bash", pattern: "git status" }]));
    assert.ok(s.covers(A, [{ surface: "bash", pattern: "git *" }]));
    assert.ok(s.covers(A, [{ surface: "bash", pattern: "git checkout main" }]));
  });

  it("covers path asks inside a granted directory: `projects/code/*` covers `projects/code/tests/*` and `projects/code/foo`", () => {
    const s = make();
    s.add({ session: A, surface: "tool", pattern: "projects/code/*" });
    assert.ok(s.covers(A, [{ surface: "tool", pattern: "projects/code/tests/*" }]));
    assert.ok(s.covers(A, [{ surface: "tool", pattern: "projects/code/foo" }]));
  });

  it("does not cover asks outside the grant pattern: `projects/code/*` misses `projects/other/*` and `projects/code-tests/*`", () => {
    const s = make();
    s.add({ session: A, surface: "tool", pattern: "projects/code/*" });
    assert.equal(s.covers(A, [{ surface: "tool", pattern: "projects/other/*" }]), undefined);
    assert.equal(s.covers(A, [{ surface: "tool", pattern: "projects/code-tests/*" }]), undefined);
  });

  it("treats a grant without wildcards as a literal: `projects/code` covers only the ask `projects/code`", () => {
    const s = make();
    s.add({ session: A, surface: "tool", pattern: "projects/code" });
    assert.ok(s.covers(A, [{ surface: "tool", pattern: "projects/code" }]));
    assert.equal(s.covers(A, [{ surface: "tool", pattern: "projects/code/x" }]), undefined);
  });

  it("covers asks one character wide at each `?`: `a?c` covers `abc` and `a/c`, not `abbc`", () => {
    const s = make();
    s.add({ session: A, surface: "bash", pattern: "a?c" });
    assert.ok(s.covers(A, [{ surface: "bash", pattern: "abc" }]));
    assert.ok(s.covers(A, [{ surface: "bash", pattern: "a/c" }]));
    assert.equal(s.covers(A, [{ surface: "bash", pattern: "abbc" }]), undefined);
  });

  it("treats other special characters in a grant as literal: `a.b` covers `a.b`, not `axb`", () => {
    const s = make();
    s.add({ session: A, surface: "bash", pattern: "a.b" });
    assert.ok(s.covers(A, [{ surface: "bash", pattern: "a.b" }]));
    assert.equal(s.covers(A, [{ surface: "bash", pattern: "axb" }]), undefined);
  });

  it("reports the covering grant: `used` holds the grant that covers the ask", () => {
    const s = make();
    const g = s.add({ session: A, surface: "bash", pattern: "git *" });
    assert.deepEqual(s.covers(A, [{ surface: "bash", pattern: "git status" }])?.map((x) => x.id), [g.id]);
  });

  it("never covers a capped surface, even when a grant would match", () => {
    const s = make();
    s.add({ session: A, surface: "bash", pattern: "*" });
    assert.equal(s.covers(A, [{ surface: "path_write", pattern: "/tmp" }]), undefined);
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

  it("refuses file-path surfaces unless the caller vouches for a prompt answer, naming why", () => {
    const s = make();
    for (const surface of ["path", "path_write", "external_directory", "external_directory_read"]) {
      assert.ok(isCappedSurface(surface), surface);
      assert.throws(() => s.add({ session: A, surface, pattern: "/tmp/*" }), /file-path/);
      assert.throws(() => s.add({ session: A, surface, pattern: "/tmp/*", source: "command" }, true), /file-path/, "only a dialog answer counts, whatever the caller says");
      assert.throws(() => s.add({ session: A, surface, pattern: "/tmp/*", source: "dialog" }), /file-path/, "a dialog source alone is not enough");
    }
    assert.equal(isCappedSurface("bash"), false);
    assert.equal(isCappedSurface("pathology"), false);
    assert.equal(cappedReason("bash"), undefined);
    assert.equal(s.covers(A, [{ surface: "path_write", pattern: "/tmp/*" }]), undefined);
  });

  it("covers a file-path ask only for a grant made from a prompt, and only when asked to", () => {
    const s = make();
    s.add({ session: A, surface: "path_write", pattern: "/p/*", source: "dialog" }, true);
    const ask = [{ surface: "path_write", pattern: "/p/deep/docs/*" }];
    assert.equal(s.covers(A, ask), undefined, "the link's own check never allows a path ask");
    assert.equal(s.covers(A, ask, true)?.length, 1);
    assert.equal(s.covers(A, [{ surface: "path", pattern: "/p/deep/docs/*" }], true), undefined, "another surface");
    assert.equal(s.covers(A, [{ surface: "path_write", pattern: "/q/*" }], true), undefined, "outside the pattern");
    assert.equal(s.covers(B, ask, true), undefined, "another session");
  });

  it("keeps a prompt-made file-path grant across a restart, dormant until restored", () => {
    make().add({ session: A, surface: "path_write", pattern: "/p/*", source: "dialog" }, true);
    const again = make();
    again.load();
    assert.equal(again.list(A).length, 1);
    assert.equal(again.covers(A, [{ surface: "path_write", pattern: "/p/x" }], true), undefined, "dormant");
    again.restore(A);
    assert.equal(again.covers(A, [{ surface: "path_write", pattern: "/p/x" }], true)?.length, 1);
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

describe("answerablePrompt: a file-path prompt the daemon may answer itself", () => {
  const request = (surface: string, title = "Permission Required\ncommand : /p/deep/docs/a.md", options: unknown = ["Yes", "No"]) => ({
    id: "d1",
    method: "select",
    title,
    options,
    toriel: { grants: [{ surface, pattern: "/p/deep/docs/*" }] },
  });
  const store = () => {
    const s = make();
    s.add({ session: A, surface: "path_write", pattern: "/p/*", source: "dialog" }, true);
    s.add({ session: A, surface: "bash", pattern: "ls *" });
    return s;
  };
  const PROTECTED = ["/home/me/.local/share/toriel/permissions.json", "/home/me/.pi/agent"];

  it("answers when every suggested pair is covered", () => {
    assert.equal(answerablePrompt(store(), A, request("path_write"), "/p/deep/docs/a.md", PROTECTED)?.length, 1);
  });

  it("does not answer for another session, an uncovered path, or a prompt without a plain Yes", () => {
    assert.equal(answerablePrompt(store(), B, request("path_write"), "/p/deep/docs/a.md", PROTECTED), undefined);
    assert.equal(answerablePrompt(store(), A, request("path"), "/p/deep/docs/a.md", PROTECTED), undefined, "another surface");
    assert.equal(answerablePrompt(store(), A, request("path_write", undefined, ["Allow", "Deny"]), "/p/x", PROTECTED), undefined);
    assert.equal(answerablePrompt(store(), undefined, request("path_write"), "/p/x", PROTECTED), undefined);
  });

  it("answers only select prompts, not an input or editor dialog that happens to carry grants", () => {
    for (const method of ["input", "editor", "confirm"]) {
      assert.equal(answerablePrompt(store(), A, { ...request("path_write"), method }, "/p/deep/docs/a.md", PROTECTED), undefined, method);
    }
  });

  it("leaves everything but file-path prompts to the grants link", () => {
    assert.equal(answerablePrompt(store(), A, request("bash"), "ls x", PROTECTED), undefined);
  });

  it("never answers for the grants file or pi's own configuration, whatever pattern a grant has", () => {
    const s = make();
    s.add({ session: A, surface: "path_write", pattern: "/home/me/*", source: "dialog" }, true);
    const ask = (title: string) => ({ ...request("path_write", title), toriel: { grants: [{ surface: "path_write", pattern: "/home/me/.local/share/toriel/*" }] } });
    assert.equal(answerablePrompt(s, A, ask("x"), "/home/me/.local/share/toriel/permissions.json", PROTECTED), undefined, "by the asked path");
    assert.equal(answerablePrompt(s, A, ask("write /home/me/.pi/agent/settings.json"), undefined, PROTECTED), undefined, "by the title when the value is not a bare path");
    assert.equal(answerablePrompt(s, A, ask("x"), "/home/me/notes/a.md", PROTECTED)?.length, 1, "other files are fine");
  });
});

describe("touchesProtected: every spelling of a protected file", () => {
  const PROTECTED = ["/home/me/.local/share/toriel/permissions.json", "/home/me/.pi/agent"];
  const touches = (text: string) => touchesProtected(text, PROTECTED);

  it("sees the absolute path, the ~ form, and a command pi wrapped across lines", () => {
    assert.equal(touches("write /home/me/.pi/agent/settings.json"), true);
    assert.equal(touches("cat ~/.pi/agent/mcp.json"), true);
    assert.equal(touches("cat /home/me/.pi/ag\nent/mcp.json"), true);
  });

  it("sees relative spellings, which still contain the tail of the path", () => {
    assert.equal(touches("../.pi/agent/mcp.json"), true);
    assert.equal(touches("x/../.pi/agent/mcp.json"), true);
    assert.equal(touches("../../toriel/permissions.json"), true);
    assert.equal(touches("repo/.pi/agent/models.json"), true, "a repo-local .pi/agent is matched too");
  });

  it("collapses .. and . segments, so a path that only resolves to a protected file is seen", () => {
    assert.equal(touches("/home/me/notes/../.pi/agent/auth.json"), true);
    assert.equal(touches("/home/me/./.pi/./agent/auth.json"), true);
    assert.equal(touches("/home/me//.pi//agent/auth.json"), true);
    assert.equal(touches("/home/me/.pi/x/../agent/auth.json"), true, "only the collapse sees this one: the tail is split by the detour");
    assert.equal(touches("/home/me/.local/share/y/../toriel/permissions.json"), true);
    assert.equal(touches("/home/me/a/b/../../.local/share/toriel/permissions.json"), true);
  });

  it("leaves other files alone, at the price of nothing but the odd extra prompt", () => {
    assert.equal(touches("/home/me/notes/a.md"), false);
    assert.equal(touches("/home/me/.pi/other/a.md"), false);
    assert.equal(touches("../notes/../toriel/readme.md"), false);
    assert.equal(touches(""), false);
  });

  it("makes answerablePrompt refuse a relative spelling, grant or no grant", () => {
    const s = make();
    s.add({ session: A, surface: "path_write", pattern: "*", source: "dialog" }, true);
    const request = { id: "d", method: "select", title: "Permission Required\npath : x/../.pi/agent/mcp.json", options: ["Yes", "No"], toriel: { grants: [{ surface: "path_write", pattern: "x/../.pi/agent/mcp.json" }] } };
    assert.equal(answerablePrompt(s, A, request, "x/../.pi/agent/mcp.json", PROTECTED), undefined);
  });
});
