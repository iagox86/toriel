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

  it("answers a probe from the grants with the expiry, and leaves the dialog's suggestion alone (ticket 94)", async () => {
    const h = await start();
    const { c, session, uuid } = await savedSession(h);
    await c.request({ type: "permission_add", uuid, surface: "bash", pattern: "ls*", for: "1h" });
    await c.request({ type: "permission_add", uuid, surface: "bash", pattern: "pwd" });
    const link = await h.connect();
    const timed = await link.request({ type: "permission_check", uuid, grants: [{ surface: "bash", pattern: "ls -l" }], probe: true });
    assert.deepEqual([timed.allow, typeof timed.expiresAt], [true, "number"]);
    assert.ok(timed.expiresAt > Date.now() && timed.expiresAt <= Date.now() + 3_600_000);
    const open = await link.request({ type: "permission_check", uuid, grants: [{ surface: "bash", pattern: "pwd" }], probe: true });
    assert.deepEqual([open.allow, open.expiresAt], [true, null], "a grant until revoked has no expiry");
    assert.equal((await link.request({ type: "permission_check", uuid, grants: [{ surface: "bash", pattern: "rm x" }], probe: true })).allow, false);
    // a probe must not stand in for a real ask's suggestion: the next dialog gets none
    await c.request({ type: "prompt", session, message: "/ask-select" });
    const dialog = await c.waitFor((m) => m.type === "ui_request" && m.request?.id === "ask-select-1");
    assert.equal(dialog.request.toriel, undefined);
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

  it("logs every ui_response, and names one that matches no pending dialog (ticket 249)", async () => {
    const h = await start();
    const { c, session } = await savedSession(h);
    await c.request({ type: "prompt", session, message: "/ask-select" });
    await c.waitFor((m) => m.type === "ui_request" && m.request?.id === "ask-select-1");
    await c.request({ type: "ui_response", session, response: { id: "ask-select-1", value: "No" } });
    await c.request({ type: "ui_response", session, response: { id: "stale-9", value: "Yes" } });
    const log = fs.readFileSync(path.join(h.dir, "daemon.log"), "utf8");
    assert.match(log, new RegExp(`session ${session} ui_response ask-select-1\\n`));
    assert.match(log, new RegExp(`session ${session} ui_response stale-9 matches no pending dialog \\(pending: none\\)`));
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

  describe("file-path asks", () => {
    const ask = { surface: "path_write", pattern: "/p/deep/docs/*" };

    /** A session with a file-path prompt open, as pi raises one: the link reported the ask, then the dialog came. */
    async function pathPrompt() {
      const h = await start();
      const { c, session, uuid } = await savedSession(h);
      const link = await h.connect();
      const raise = async () => {
        await link.request({ type: "permission_check", uuid, grants: [ask], value: "sudo -V" });
        await c.request({ type: "prompt", session, message: "/ask-select" });
      };
      await raise();
      const dialog = await c.waitFor((m) => m.type === "ui_request" && m.request?.id === "ask-select-1");
      return { c, session, uuid, link, raise, dialog, h };
    }

    it("carries the grant pi suggested, so the prompt can offer toriel's rows", async () => {
      const { dialog } = await pathPrompt();
      assert.deepEqual(dialog.request.toriel, { grants: [ask] });
    });

    it("makes a grant only from the open prompt, with a pattern that covers what pi asked about", async () => {
      const { c, session } = await pathPrompt();
      const add = (extra: Record<string, unknown>) => c.request({ type: "permission_add", session, surface: "path_write", for: "1h", source: "dialog", ...extra });
      await assert.rejects(add({ pattern: "/p/*" }), /answering the file-path prompt/, "no prompt named");
      await assert.rejects(add({ pattern: "/p/*", dialog: "some-other-prompt" }), /answering the file-path prompt/, "not the prompt that is open");
      await assert.rejects(add({ pattern: "/elsewhere/*", dialog: "ask-select-1" }), /does not cover/, "a pattern that would not cover this ask");
      await assert.rejects(c.request({ type: "permission_add", session, surface: "external_directory", pattern: "/p/*", dialog: "ask-select-1" }), /does not cover/, "another surface than the one asked");
      const ok = await add({ pattern: "/p/*", dialog: "ask-select-1" });
      assert.equal(ok.grant.surface, "path_write");
      assert.equal(ok.grant.source, "dialog");
    });

    it("refuses a file-path grant once the prompt is answered, and from /permissions add", async () => {
      const { c, session } = await pathPrompt();
      await c.request({ type: "ui_response", session, response: { id: "ask-select-1", value: "Yes" } });
      await assert.rejects(c.request({ type: "permission_add", session, surface: "path_write", pattern: "/p/*", dialog: "ask-select-1", source: "dialog" }), /answering the file-path prompt/);
      await assert.rejects(c.request({ type: "permission_add", session, surface: "path_write", pattern: "/p/*", source: "command" }), /answering the file-path prompt/);
    });

    it("makes no grant for a prompt about the grants file or pi's config, even one pi wrapped across lines", async () => {
      // pi's own directory is protected; the daemon reads it from PI_CODING_AGENT_DIR
      const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-agentdir-"));
      const file = path.join(agentDir, "settings.json");
      const pattern = `${agentDir}/*`;
      const h = await start({ PI_CODING_AGENT_DIR: agentDir, FAKE_PI_ASK_COMMAND: `cat ${file}` });
      const { c, session, uuid } = await savedSession(h);
      const link = await h.connect();
      await link.request({ type: "permission_check", uuid, grants: [{ surface: "path_read", pattern }], value: `cat ${file}` });
      await c.request({ type: "prompt", session, message: "/ask-select" });
      const dialog = await c.waitFor((m) => m.type === "ui_request" && m.request?.id === "ask-select-1");
      assert.match(dialog.request.title, /\n/, "the fake wraps the command, as pi does");
      assert.deepEqual(dialog.request.toriel, { protectedAsk: true }, "the controller is told, instead of being offered rows that could only be refused");
      await assert.rejects(c.request({ type: "permission_add", session, surface: "path_read", pattern, dialog: "ask-select-1", source: "dialog" }), /always asked about/);
    });

    it("marks a protected prompt as such even when the link reported nothing for it (no grants link, or no match)", async () => {
      const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-agentdir-"));
      const h = await start({ PI_CODING_AGENT_DIR: agentDir, FAKE_PI_ASK_COMMAND: `cat ${path.join(agentDir, "settings.json")}` });
      const { c, session } = await savedSession(h);
      await c.request({ type: "prompt", session, message: "/ask-select" });
      const dialog = await c.waitFor((m) => m.type === "ui_request" && m.request?.id === "ask-select-1");
      assert.deepEqual(dialog.request.toriel, { protectedAsk: true });
    });

    it("marks a protected prompt however the path is spelled: relative, or with a detour", async () => {
      for (const command of ["cat ../.pi/agent/mcp.json", "cat x/../.pi/agent/mcp.json"]) {
        const h = await start({ FAKE_PI_ASK_COMMAND: command });
        const { c, session } = await savedSession(h);
        await c.request({ type: "prompt", session, message: "/ask-select" });
        const dialog = await c.waitFor((m) => m.type === "ui_request" && m.request?.id === "ask-select-1");
        assert.deepEqual(dialog.request.toriel, { protectedAsk: true }, command);
      }
    });

    it("does not mark an ordinary prompt", async () => {
      const { dialog } = await pathPrompt();
      assert.equal(dialog.request.toriel?.protectedAsk, undefined);
    });

    it("does not mark a prompt about the agent-maintained memory store, but still refuses a grant for pi's own files (ticket 246)", async () => {
      const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-hermes-"));
      const skill = path.join(agentDir, "pi-hermes-memory", "skills", "x", "SKILL.md");
      const pattern = `${agentDir}/*`;
      const h = await start({ PI_CODING_AGENT_DIR: agentDir, FAKE_PI_ASK_COMMAND: `cat ${skill}` });
      const { c, session, uuid } = await savedSession(h);
      const link = await h.connect();
      await link.request({ type: "permission_check", uuid, grants: [{ surface: "path_read", pattern }], value: `cat ${skill}` });
      await c.request({ type: "prompt", session, message: "/ask-select" });
      const dialog = await c.waitFor((m) => m.type === "ui_request" && m.request?.id === "ask-select-1");
      assert.equal(dialog.request.toriel?.protectedAsk, undefined, "a hermes skill is carved out of the whole-tree protection");
      assert.ok(dialog.request.toriel?.grants?.length, "the suggestion rides along, so the dialog can offer grant rows");
      const added = await c.request({ type: "permission_add", session, surface: "path_read", pattern, dialog: "ask-select-1", source: "dialog" });
      assert.equal(added.grant.pattern, pattern);
    });

    it("answers a later prompt the grant covers itself, before any controller sees it", async () => {
      const { c, session, raise } = await pathPrompt();
      await c.request({ type: "permission_add", session, surface: "path_write", pattern: "/p/*", for: "session", source: "dialog", dialog: "ask-select-1" });
      await c.request({ type: "ui_response", session, response: { id: "ask-select-1", value: "Yes" } });
      const prompts = () => c.messages.filter((m) => m.type === "ui_request" && m.request?.id === "ask-select-1").length;
      assert.equal(prompts(), 1);
      await raise();
      const notice = await c.waitFor((m) => m.type === "notice" && /allowed by permission grant #\d+/.test(m.text));
      assert.match(notice.text, /sudo -V/);
      assert.match(notice.text, /^allowed by permission grant #\d+: /, "one grant is named once (ticket 205)");
      assert.equal(notice.durable, true, "a security-relevant fact is a transcript row, not a flash");
      assert.equal(prompts(), 1, "the covered prompt never reached the controller");
    });
  });

  describe("deny-after (ticket 88)", () => {
    const denied = (c: Client) => c.waitFor((m) => m.type === "notice" && /^denied automatically/.test(m.text));
    const sawDenied = (c: Client) => c.messages.some((m) => m.type === "notice" && /^denied automatically/.test(m.text));

    it("is off by default: a prompt nobody answers just waits", async () => {
      const h = await start({ FAKE_PI_ASK_COMMAND: "npm test", TORIEL_DENY_MIN_MS: "500" });
      const { c, session } = await savedSession(h);
      await c.request({ type: "prompt", session, message: "/ask-select" });
      await c.waitFor((m) => m.type === "ui_request" && m.request?.id === "ask-select-1");
      await new Promise((r) => setTimeout(r, 1500));
      assert.equal(sawDenied(c), false);
      assert.equal((await c.request({ type: "deny_after", session, after: "status" })).ms, undefined);
    });

    it("denies a prompt nobody answered in time, says so durably, and clears the open dialog", async () => {
      const h = await start({ FAKE_PI_ASK_COMMAND: "npm test", TORIEL_DENY_MIN_MS: "500" });
      const { c, session } = await savedSession(h);
      const set = await c.request({ type: "deny_after", session, after: "1 second" });
      assert.equal(set.ms, 1000);
      await c.request({ type: "prompt", session, message: "/ask-select" });
      await c.waitFor((m) => m.type === "ui_request" && m.request?.id === "ask-select-1");
      const notice = await denied(c);
      assert.match(notice.text, /^denied automatically: nobody answered in 1s: npm test/);
      assert.equal(notice.durable, true);
      const meta = await c.waitFor((m) => m.type === "sessions" && m.sessions.some((x: { id: number; pendingDialog: boolean }) => x.id === session && !x.pendingDialog));
      assert.ok(meta, "the badge is gone");
    });

    it("the dialog carries when it will be denied (ticket 220); with deny-after off it carries nothing", async () => {
      const h = await start({ FAKE_PI_ASK_COMMAND: "npm test", TORIEL_DENY_MIN_MS: "500" });
      const { c, session } = await savedSession(h);
      await c.request({ type: "prompt", session, message: "/ask-select" });
      const plain = await c.waitFor((m) => m.type === "ui_request" && m.request?.id === "ask-select-1");
      assert.equal(plain.request.toriel?.denyAt, undefined, "off: the dialog renders as before");
      await c.request({ type: "ui_response", session, response: { id: "ask-select-1", value: "No" } });
      await c.request({ type: "deny_after", session, after: "1 second" });
      const before = Date.now();
      c.messages.length = 0;
      await c.request({ type: "prompt", session, message: "/ask-select" });
      const armed = await c.waitFor((m) => m.type === "ui_request" && m.request?.id === "ask-select-1");
      const at = armed.request.toriel?.denyAt;
      assert.equal(typeof at, "number");
      assert.ok(at >= before + 900 && at <= Date.now() + 1100, `denyAt is about a second out: ${at - before}ms`);
      await denied(c);
    });

    it("dismisses a question nobody answered in time (ticket 227), with its own notice", async () => {
      const h = await start({ TORIEL_DENY_MIN_MS: "500" });
      const { c, session } = await savedSession(h);
      await c.request({ type: "deny_after", session, after: "1 second" });
      await c.request({ type: "prompt", session, message: "/ask-question" });
      const q = await c.waitFor((m) => m.type === "ui_request" && m.request?.id === "question-1");
      assert.equal(typeof q.request.toriel?.denyAt, "number");
      const notice = await c.waitFor((m) => m.type === "notice" && /^dismissed automatically/.test(m.text));
      assert.match(notice.text, /^dismissed automatically: nobody answered in 1s: Ship it now\?/);
      assert.equal(sawDenied(c), false, "it was not a permission prompt");
    });

    it("an answer in time cancels it, and off or a bad duration is handled", async () => {
      const h = await start({ FAKE_PI_ASK_COMMAND: "npm test", TORIEL_DENY_MIN_MS: "500" });
      const { c, session } = await savedSession(h);
      await c.request({ type: "deny_after", session, after: "1 second" });
      await c.request({ type: "prompt", session, message: "/ask-select" });
      await c.waitFor((m) => m.type === "ui_request" && m.request?.id === "ask-select-1");
      await c.request({ type: "ui_response", session, response: { id: "ask-select-1", value: "Yes" } });
      await new Promise((r) => setTimeout(r, 1600));
      assert.equal(sawDenied(c), false, "the user answered first");
      assert.equal((await c.request({ type: "deny_after", session, after: "off" })).ms, undefined);
      await assert.rejects(c.request({ type: "deny_after", session, after: "soonish" }), /cannot read/);
      await assert.rejects(c.request({ type: "deny_after", session, after: "2 days" }), /between/);
    });
  });

  describe("auto mode (ticket 213)", () => {
    const wantsAnswer = (c: Client) => c.waitFor((m) => m.type === "notice" && /allowed by auto mode/.test(m.text));
    const asked = (c: Client) => c.messages.some((m) => m.type === "ui_request" && m.request?.id === "ask-select-1");

    /** What the grants link reports for an ask before its dialog: why pi asks (a rule the owner wrote, or the default). */
    const reportAsk = async (h: Harness, uuid: string, value: string, rule?: { explicit: boolean; pattern?: string; origin?: string }, grants: Array<{ surface: string; pattern: string }> = []) => {
      const link = await h.connect();
      await link.request({ type: "permission_check", uuid, grants, value, ...(rule ? { rule } : {}) });
    };

    it("never answers a question for the user, even one that offers Yes and No (ticket 227)", async () => {
      const h = await start();
      const { c, session } = await savedSession(h);
      await c.request({ type: "auto_mode", session, on: true });
      await c.request({ type: "prompt", session, message: "/ask-question" });
      await c.waitFor((m) => m.type === "ui_request" && m.request?.id === "question-1");
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(c.messages.some((m) => m.type === "notice" && /allowed by auto mode|auto mode still asks/.test(m.text)), false);
    });

    it("answers an ordinary prompt itself and says so, durably, with what it allowed", async () => {
      const h = await start({ FAKE_PI_ASK_COMMAND: "npm test" });
      const { c, session, uuid } = await savedSession(h);
      const on = await c.request({ type: "auto_mode", session, on: true });
      assert.equal(on.on, true);
      await reportAsk(h, uuid, "npm test", { explicit: false, pattern: "*", origin: "builtin" });
      await c.request({ type: "prompt", session, message: "/ask-select" });
      const notice = await wantsAnswer(c);
      assert.match(notice.text, /^allowed by auto mode: npm test/);
      assert.equal(notice.durable, true);
      assert.equal(asked(c), false, "no controller was asked");
    });

    it("answers the common ask too: the one pi suggests a grant for, whose suggestion the dialog uses up before auto mode looks", async () => {
      const h = await start({ FAKE_PI_ASK_COMMAND: "npm test" });
      const { c, session, uuid } = await savedSession(h);
      await c.request({ type: "auto_mode", session, on: true });
      await reportAsk(h, uuid, "npm test", { explicit: false, pattern: "*", origin: "builtin" }, [{ surface: "bash", pattern: "npm test" }]);
      await c.request({ type: "prompt", session, message: "/ask-select" });
      const notice = await wantsAnswer(c);
      assert.match(notice.text, /^allowed by auto mode: npm test/);
      assert.equal(asked(c), false);
    });

    it("still asks about an explicit rule when the ask carries a grant to suggest, and the prompt still offers the grant", async () => {
      const h = await start({ FAKE_PI_ASK_COMMAND: "npm test" });
      const { c, session, uuid } = await savedSession(h);
      await c.request({ type: "auto_mode", session, on: true });
      await reportAsk(h, uuid, "npm test", { explicit: true, pattern: "npm *", origin: "global" }, [{ surface: "bash", pattern: "npm test" }]);
      await c.request({ type: "prompt", session, message: "/ask-select" });
      const dialog = await c.waitFor((m) => m.type === "ui_request" && m.request?.id === "ask-select-1");
      assert.deepEqual(dialog.request.toriel, { grants: [{ surface: "bash", pattern: "npm test" }] });
      await c.waitFor((m) => m.type === "notice" && /your permission config asks about this one \(rule "npm \*"\)/.test(m.text));
    });

    it("still asks about what the owner's own config asks about, and says which rule", async () => {
      const h = await start({ FAKE_PI_ASK_COMMAND: "npm test" });
      const { c, session, uuid } = await savedSession(h);
      await c.request({ type: "auto_mode", session, on: true });
      await reportAsk(h, uuid, "npm test", { explicit: true, pattern: "npm *", origin: "global" });
      await c.request({ type: "prompt", session, message: "/ask-select" });
      await c.waitFor((m) => m.type === "ui_request" && m.request?.id === "ask-select-1");
      await c.waitFor((m) => m.type === "notice" && /auto mode still asks about this one: your permission config asks about this one \(rule "npm \*"\)/.test(m.text));
      assert.equal(c.messages.some((m) => m.type === "notice" && /allowed by auto mode/.test(m.text)), false);
    });

    it("asks when the link reported nothing about why (an older link, or a surface it cannot read): not a yes", async () => {
      const h = await start({ FAKE_PI_ASK_COMMAND: "npm test" });
      const { c, session } = await savedSession(h);
      await c.request({ type: "auto_mode", session, on: true });
      await c.request({ type: "prompt", session, message: "/ask-select" });
      await c.waitFor((m) => m.type === "ui_request" && m.request?.id === "ask-select-1");
      await c.waitFor((m) => m.type === "notice" && /auto mode still asks about this one: auto mode cannot tell whether your permission config asks/.test(m.text));
    });

    it("still asks about what is in the floor, and says why", async () => {
      const h = await start({ FAKE_PI_ASK_COMMAND: "git push origin main" });
      const { c, session } = await savedSession(h);
      await c.request({ type: "auto_mode", session, on: true });
      await c.request({ type: "prompt", session, message: "/ask-select" });
      await c.waitFor((m) => m.type === "ui_request" && m.request?.id === "ask-select-1");
      const why = await c.waitFor((m) => m.type === "notice" && /auto mode still asks about this one: .*pushes or publishes/.test(m.text));
      assert.equal(why.durable, undefined, "a flash, not a transcript row");
      assert.equal(c.messages.some((m) => m.type === "notice" && /allowed by auto mode/.test(m.text)), false);
    });

    it("asks as usual after it is switched off", async () => {
      const h = await start({ FAKE_PI_ASK_COMMAND: "npm test" });
      const { c, session } = await savedSession(h);
      await c.request({ type: "auto_mode", session, on: true });
      await c.request({ type: "auto_mode", session, on: false });
      await c.request({ type: "prompt", session, message: "/ask-select" });
      await c.waitFor((m) => m.type === "ui_request" && m.request?.id === "ask-select-1");
      assert.equal(c.messages.some((m) => m.type === "notice" && /allowed by auto mode/.test(m.text)), false);
    });

    it("toggles with no `on`, shows in the session's meta, and refuses a bad or over-long duration", async () => {
      const h = await start();
      const { c, session } = await savedSession(h);
      const meta = () => c.sessions().find((s) => s.id === session);
      assert.equal((await c.request({ type: "auto_mode", session })).on, true);
      await c.waitFor(() => meta()?.auto === true);
      assert.equal(meta()?.autoUntil, undefined, "no end");
      assert.equal((await c.request({ type: "auto_mode", session })).on, false);
      await c.waitFor(() => meta()?.auto === undefined);
      await assert.rejects(c.request({ type: "auto_mode", session, on: true, for: "soon" }), /cannot read "soon" as a duration/);
      await assert.rejects(c.request({ type: "auto_mode", session, on: true, for: "3d" }), /at most 1d/);
      const timed = await c.request({ type: "auto_mode", session, on: true, for: "2h" });
      assert.ok(timed.until > Date.now() + 119 * 60_000 && timed.until < Date.now() + 121 * 60_000);
      await c.waitFor(() => meta()?.autoUntil === timed.until);
      await assert.rejects(c.request({ type: "auto_mode", session: 9999, on: true }), /no session/);
    });

    it("ends a timed auto mode by itself, with a notice", async () => {
      const h = await start();
      const { c, session } = await savedSession(h);
      await c.request({ type: "auto_mode", session, on: true, for: "1s" });
      const ended = await c.waitFor((m) => m.type === "notice" && /auto mode ended/.test(m.text));
      assert.equal(ended.durable, true);
      await c.waitFor(() => c.sessions().find((s) => s.id === session)?.auto === undefined);
    });
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

describe("daemon: /fork and permission grants", () => {
  const forkOf = async (h: Harness, c: Client, session: number, keepPermissions?: boolean) => {
    const file = c.sessions().find((s) => s.id === session)?.sessionFile as string;
    return (await c.request({ type: "adopt", path: file, cwd: h.dir, fork: true, keepPermissions })) as Msg;
  };

  it("gives a fork no grants by default", async () => {
    const h = await start();
    const { c, session } = await savedSession(h);
    await c.request({ type: "permission_add", session, surface: "bash", pattern: "git status" });
    const forked = await forkOf(h, c, session);
    assert.equal(forked.grantsCopied, 0);
    assert.deepEqual((await c.request({ type: "permission_list", session: forked.sessionId })).grants, []);
  });

  it("copies the parent's active grants into a fork that asks for them, leaving the parent's alone", async () => {
    const h = await start();
    const { c, session, uuid } = await savedSession(h);
    await c.request({ type: "permission_add", session, surface: "bash", pattern: "git status", for: "1h" });
    await c.request({ type: "permission_add", session, surface: "mcp", pattern: "exa:*" });
    const before = (await c.request({ type: "permission_list", session })).grants as Msg[];
    const forked = await forkOf(h, c, session, true);
    assert.equal(forked.grantsCopied, 2);
    const copy = (await c.request({ type: "permission_list", session: forked.sessionId })).grants as Msg[];
    assert.deepEqual(copy.map((g) => [g.surface, g.pattern, g.expiresAt, g.dormant]), before.map((g) => [g.surface, g.pattern, g.expiresAt, false]));
    assert.ok(copy.every((g) => g.session === forked.sessionUuid && g.session !== uuid));
    assert.equal(((await c.request({ type: "permission_list", session })).grants as Msg[]).length, 2);
  });

  it("forks a session that is mid-turn from its last finished step", async () => {
    const h = await start();
    const { c, session } = await savedSession(h);
    const file = c.sessions().find((s) => s.id === session)?.sessionFile as string;
    // what a running turn leaves in the file: a tool call whose result has not arrived, then a line half written
    fs.appendFileSync(file, `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }] } })}\n{"type":"mess`);
    const parentCount = (await c.request({ type: "adopt", path: file, cwd: h.dir, fork: true })) as Msg;
    assert.equal(typeof parentCount.sessionId, "number");
    const history = await c.waitFor((m) => m.type === "history" && m.session === parentCount.sessionId);
    const roles = (history.messages as Msg[]).map((m) => m.role);
    assert.ok(roles.length > 0);
    assert.ok(!JSON.stringify(history.messages).includes('"toolCall"'), "the unanswered tool call is left out of the copy");
  });
});
