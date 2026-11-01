import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { type Client, type Harness, type Msg, startDaemon } from "./helpers.ts";

const UUID = "11111111-2222-4333-8444-555555555555";
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.stop();
  }
});
const start = async (env: Record<string, string> = {}) => {
  const h = await startDaemon(env);
  harnesses.push(h);
  return h;
};

/** A connection that has announced itself as a controller (as the real one does with its first line), so it may change grants. */
async function controller(h: Harness): Promise<Client> {
  const c = await h.connect();
  await c.request({ type: "list" });
  return c;
}

const isSettled = (m: Msg) => m.type === "event" && m.event?.type === "agent_settled";

/** A session that has answered once, so it has a UUID. */
async function savedSession(h: Harness): Promise<{ c: Client; session: number; uuid: string }> {
  const c = await h.connect();
  const { sessionId } = await c.request({ type: "spawn", cwd: h.dir });
  await c.waitFor((m) => m.type === "history" && m.session === sessionId);
  await c.request({ type: "prompt", session: sessionId, message: "hi" });
  await c.waitFor(isSettled);
  for (let i = 0; i < 40; i++) {
    const uuid = c.sessions().find((s) => s.id === sessionId)?.sessionId;
    if (uuid) {
      return { c, session: sessionId, uuid };
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("the session never reported an id");
}

describe("daemon: permission grants", () => {
  it("adds, lists and revokes grants, and reports them in the session list", async () => {
    const h = await start();
    const { c, session, uuid } = await savedSession(h);
    const added = await c.request({ type: "permission_add", session, surface: "bash", pattern: "git status", for: "1h" });
    assert.match(added.echo, /^granted bash "git status" until /);
    assert.equal(added.grant.dormant, false);
    assert.equal(added.grant.session, uuid);
    await c.request({ type: "permission_add", session, surface: "mcp", pattern: "exa:*", source: "dialog" });
    const { grants } = await c.request({ type: "permission_list", session });
    assert.deepEqual(grants.map((g: Msg) => [g.id, g.surface, g.pattern, g.source, g.expiresAt === null]), [[1, "bash", "git status", "command", false], [2, "mcp", "exa:*", "dialog", true]]);
    const meta = await (async () => {
      for (let i = 0; i < 40; i++) {
        const m = c.sessions().find((s) => s.id === session);
        if (m?.grants === 2) {
          return m;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error("the session list never showed the grants");
    })();
    assert.equal(typeof meta.nextGrantExpiry, "number");
    const revoked = await c.request({ type: "permission_revoke", session, ref: "#1" });
    assert.equal(revoked.count, 1);
    assert.equal((await c.request({ type: "permission_revoke", session, ref: "exa:*" })).count, 1);
    assert.deepEqual((await c.request({ type: "permission_list", session })).grants, []);
    await assert.rejects(c.request({ type: "permission_revoke", session, ref: "9" }), /no permission grant #9/);
    await assert.rejects(c.request({ type: "permission_revoke", session }), /revoke which grant/);
  });

  it("revokes everything in a session at once, leaving other sessions' grants", async () => {
    const h = await start();
    const c = await controller(h);
    await c.request({ type: "permission_add", uuid: UUID, surface: "bash", pattern: "a" });
    await c.request({ type: "permission_add", uuid: UUID, surface: "bash", pattern: "b" });
    await c.request({ type: "permission_add", uuid: "other", surface: "bash", pattern: "a" });
    assert.equal((await c.request({ type: "permission_list" })).grants.length, 3);
    assert.equal((await c.request({ type: "permission_revoke", uuid: UUID, all: true })).count, 2);
    assert.deepEqual((await c.request({ type: "permission_list" })).grants.map((g: Msg) => g.session), ["other"]);
  });

  it("refuses file-path surfaces, bad lifetimes and a missing session in words", async () => {
    const h = await start();
    const c = await controller(h);
    await assert.rejects(c.request({ type: "permission_add", uuid: UUID, surface: "path_write", pattern: "/tmp/*" }), /file-path/);
    await assert.rejects(c.request({ type: "permission_add", uuid: UUID, surface: "bash", pattern: "ls", for: "soonish" }), /cannot read "soonish" as a duration/);
    await assert.rejects(c.request({ type: "permission_add", surface: "bash", pattern: "ls" }), /needs a session/);
    assert.equal((await c.request({ type: "permission_add", uuid: UUID, surface: "bash", pattern: "ls", for: "never" })).grant.expiresAt, null);
    assert.equal((await c.request({ type: "permission_add", uuid: UUID, surface: "bash", pattern: "ls", for: "session" })).grant.expiresAt, null);
  });

  it("lets the link's check allow a covered ask and defer an uncovered one, without becoming a controller", async () => {
    const h = await start();
    const c = await controller(h);
    await c.request({ type: "permission_add", uuid: UUID, surface: "bash", pattern: "sudo -V" });
    const link = await h.connect();
    const hit = await link.request({ type: "permission_check", uuid: UUID, grants: [{ surface: "bash", pattern: "sudo -V" }], value: "sudo -V" });
    assert.deepEqual([hit.allow, hit.grants], [true, [1]]);
    assert.equal((await link.request({ type: "permission_check", uuid: UUID, grants: [{ surface: "bash", pattern: "sudo -s" }] })).allow, false);
    assert.equal((await link.request({ type: "permission_check", uuid: "someone-else", grants: [{ surface: "bash", pattern: "sudo -V" }] })).allow, false);
    assert.equal((await link.request({ type: "permission_check", uuid: UUID, grants: [] })).allow, false);
    assert.equal((await link.request({ type: "permission_check", uuid: UUID, grants: "nope" as never })).allow, false);
    assert.equal(link.messages.some((m) => m.type === "sessions" || m.type === "history"), false, "a check is a one-shot call, not a controller attach");
  });

  it("does not let an expired grant allow anything", async () => {
    const h = await start();
    const c = await controller(h);
    await c.request({ type: "permission_add", uuid: UUID, surface: "bash", pattern: "ls", for: "1s" });
    assert.equal((await c.request({ type: "permission_check", uuid: UUID, grants: [{ surface: "bash", pattern: "ls" }] })).allow, true);
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal((await c.request({ type: "permission_check", uuid: UUID, grants: [{ surface: "bash", pattern: "ls" }] })).allow, false);
    assert.deepEqual((await c.request({ type: "permission_list", uuid: UUID })).grants, []);
  });

  it("hands the uncovered ask's suggested grant to the dialog that follows, once", async () => {
    const h = await start();
    const { c, session, uuid } = await savedSession(h);
    const link = await h.connect();
    await link.request({ type: "permission_check", uuid, grants: [{ surface: "bash", pattern: "sudo -V" }], value: "sudo -V" });
    await c.request({ type: "prompt", session, message: "/ask-select" });
    const dialog = await c.waitFor((m) => m.type === "ui_request" && m.request?.id === "ask-select-1");
    assert.deepEqual(dialog.request.toriel, { grants: [{ surface: "bash", pattern: "sudo -V" }] });
    assert.equal(dialog.request.options[0], "Yes", "pi's own options are untouched");
    await c.request({ type: "ui_response", session, response: { id: "ask-select-1", value: "No" } });
    await c.request({ type: "prompt", session, message: "/ask-select" });
    const again = await c.waitFor((m) => m.type === "ui_request" && m.request?.id === "ask-select-1" && m !== dialog);
    assert.equal(again.request.toriel, undefined, "the suggestion was used up by the first dialog");
  });

  it("matches a long command that pi wrapped across lines, and ignores a suggestion for another command", async () => {
    const long = "sudo dnf install --assumeyes some-quite-long-package-name";
    const h = await start({ FAKE_PI_ASK_COMMAND: long });
    const { c, session, uuid } = await savedSession(h);
    const link = await h.connect();
    await link.request({ type: "permission_check", uuid, grants: [{ surface: "bash", pattern: long }], value: long });
    await c.request({ type: "prompt", session, message: "/ask-select" });
    const dialog = await c.waitFor((m) => m.type === "ui_request" && m.request?.id === "ask-select-1");
    assert.match(dialog.request.title, /\n/);
    assert.deepEqual(dialog.request.toriel?.grants, [{ surface: "bash", pattern: long }]);
    await c.request({ type: "ui_response", session, response: { id: "ask-select-1", value: "No" } });
    await link.request({ type: "permission_check", uuid, grants: [{ surface: "bash", pattern: "rm -rf x" }], value: "rm -rf x" });
    await c.request({ type: "prompt", session, message: "/ask-select" });
    const other = await c.waitFor((m) => m.type === "ui_request" && m.request?.id === "ask-select-1" && m !== dialog);
    assert.equal(other.request.toriel, undefined);
  });

  it("keeps the suggestion when an unrelated dialog arrives before the one it belongs to", async () => {
    const h = await start();
    const { c, session, uuid } = await savedSession(h);
    const link = await h.connect();
    await link.request({ type: "permission_check", uuid, grants: [{ surface: "bash", pattern: "sudo -V" }], value: "sudo -V" });
    await c.request({ type: "prompt", session, message: "/ask" });
    const other = await c.waitFor((m) => m.type === "ui_request" && m.request?.id === "ask-1");
    assert.equal(other.request.toriel, undefined, "a confirm dialog never carries a grant");
    await c.request({ type: "ui_response", session, response: { id: "ask-1", confirmed: false } });
    await c.request({ type: "prompt", session, message: "/ask-select" });
    const dialog = await c.waitFor((m) => m.type === "ui_request" && m.request?.id === "ask-select-1");
    assert.deepEqual(dialog.request.toriel, { grants: [{ surface: "bash", pattern: "sudo -V" }] });
  });

  it("offers no grant for file-path asks, which pi would not honor", async () => {
    const h = await start();
    const { c, session, uuid } = await savedSession(h);
    const link = await h.connect();
    await link.request({ type: "permission_check", uuid, grants: [{ surface: "path_write", pattern: "sudo -V" }], value: "sudo -V" });
    await c.request({ type: "prompt", session, message: "/ask-select" });
    const dialog = await c.waitFor((m) => m.type === "ui_request" && m.request?.id === "ask-select-1");
    assert.equal(dialog.request.toriel, undefined);
  });

  it("removes a deleted session's grants", async () => {
    const h = await start();
    const { c, session, uuid } = await savedSession(h);
    await c.request({ type: "permission_add", session, surface: "bash", pattern: "ls" });
    await c.request({ type: "permission_add", uuid: "someone-else", surface: "bash", pattern: "ls" });
    await c.request({ type: "delete", session });
    assert.deepEqual((await c.request({ type: "permission_list" })).grants.map((g: Msg) => g.session), ["someone-else"]);
    assert.equal(uuid.length > 0, true);
  });
});

describe("daemon: who may change grants", () => {
  it("refuses a connection whose first line is a grant change, without syncing it as a controller", async () => {
    const h = await start();
    const stray = await h.connect();
    for (const cmd of [{ type: "permission_add", uuid: UUID, surface: "bash", pattern: "ls" }, { type: "permission_revoke", uuid: UUID, all: true }, { type: "permission_restore", uuid: UUID }]) {
      await assert.rejects(stray.request(cmd), /has not announced itself/);
    }
    assert.equal(stray.messages.some((m) => m.type === "sessions"), false, "a refused line does not make the socket a controller");
    const real = await controller(h);
    assert.deepEqual((await real.request({ type: "permission_list" })).grants, [], "nothing was stored");
  });

  it("lets a connection that announced itself with list change grants, and a one-shot check still works from a stranger", async () => {
    const h = await start();
    const c = await h.connect();
    await c.request({ type: "list" });
    await c.request({ type: "permission_add", uuid: UUID, surface: "bash", pattern: "ls" });
    const stranger = await h.connect();
    assert.equal((await stranger.request({ type: "permission_check", uuid: UUID, grants: [{ surface: "bash", pattern: "ls" }] })).allow, true);
    await assert.rejects(stranger.request({ type: "permission_revoke", uuid: UUID, all: true }), /has not announced itself/);
    assert.equal((await c.request({ type: "permission_list", uuid: UUID })).grants.length, 1);
  });
});

describe("daemon: permission grants across a restart", () => {
  it("brings saved grants back dormant and activates them only on restore", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "toriel-permfile-")), "permissions.json");
    const first = await start({ TORIEL_PERMISSIONS: file });
    const c1 = await controller(first);
    await c1.request({ type: "permission_add", uuid: UUID, surface: "bash", pattern: "ls", for: "1h" });
    await c1.request({ type: "permission_add", uuid: UUID, surface: "mcp", pattern: "exa:*" });
    harnesses.splice(harnesses.indexOf(first), 1);
    await first.stop();
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);

    const second = await start({ TORIEL_PERMISSIONS: file });
    const c2 = await controller(second);
    const listed = (await c2.request({ type: "permission_list", uuid: UUID })).grants;
    assert.deepEqual(listed.map((g: Msg) => [g.pattern, g.dormant]), [["ls", true], ["exa:*", true]]);
    assert.equal((await c2.request({ type: "permission_check", uuid: UUID, grants: [{ surface: "bash", pattern: "ls" }] })).allow, false, "saved grants do nothing yet");
    assert.equal((await c2.request({ type: "permission_restore", uuid: UUID })).count, 2);
    assert.equal((await c2.request({ type: "permission_check", uuid: UUID, grants: [{ surface: "bash", pattern: "ls" }] })).allow, true);
    assert.deepEqual((await c2.request({ type: "permission_list", uuid: UUID })).grants.map((g: Msg) => g.dormant), [false, false]);
    await assert.rejects(c2.request({ type: "permission_restore" }), /needs a session/);
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });
});
