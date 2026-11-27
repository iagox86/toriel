import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SESSION_ENV, withoutSessionEnv } from "../scripts/test-env.ts";
import { bangEnv, CHILD_ENV_KEYS, childEnv, sandboxWritableRoots } from "../src/child-env.ts";
import { delegateEnv } from "../src/daemon-children.ts";
import { BACKGROUND_COMMAND as DAEMON_COMMAND } from "../src/daemon-handlers-ops.ts";
import { BACKGROUND_COMMAND as EXTENSION_COMMAND } from "../pi/extensions/toriel-jobs.ts";

describe("a session's command environment", () => {
  it("gives the pi child the toriel variables, with the session id only when it has one", () => {
    assert.deepEqual(childEnv({ sessionId: "abc" }, "/sock", { A: "1" }), { A: "1", TORIEL_CHILD: "1", TORIEL_SOCK: "/sock", TORIEL_SESSION_ID: "abc" });
    assert.equal(childEnv({}, "/sock", {}).TORIEL_SESSION_ID, undefined);
  });

  it("lets a !command see the session id, the socket and pi's session variables, as the agent's bash does", () => {
    const env = bangEnv({ sessionId: "abc", sessionFile: "/s/abc.jsonl" }, "/sock", { PATH: "/usr/bin", PI_MODEL: "stale" }, "/pi/bin");
    assert.equal(env.TORIEL_SESSION_ID, "abc");
    assert.equal(env.TORIEL_SOCK, "/sock");
    assert.equal(env.PI_SESSION_ID, "abc");
    assert.equal(env.PI_SESSION_FILE, "/s/abc.jsonl");
    assert.equal(env.PI_MODEL, undefined, "stale model variables from the daemon's own environment are dropped");
    assert.equal(env.PATH, "/pi/bin:/usr/bin");
  });

  it("leaves a PATH that already has pi's bin directory alone, and sets no session id while the daemon does not know one", () => {
    const env = bangEnv({}, "/sock", { PATH: "/usr/bin:/pi/bin", PI_SESSION_ID: "daemon-own" }, "/pi/bin");
    assert.equal(env.PATH, "/usr/bin:/pi/bin");
    assert.equal(env.TORIEL_SESSION_ID, undefined);
    assert.equal(env.PI_SESSION_ID, undefined);
  });
});

describe("the TORIEL_SCOPE_ROOT / TORIEL_SCOPE_MODE seam", () => {
  it("sets both scope variables when a scope is given", () => {
    const env = childEnv({ sessionId: "abc" }, "/sock", { A: "1" }, { root: "/w", mode: "deny" });
    assert.equal(env.TORIEL_SCOPE_ROOT, "/w");
    assert.equal(env.TORIEL_SCOPE_MODE, "deny");
    const ask = childEnv({ sessionId: "abc" }, "/sock", { A: "1" }, { root: "/w", mode: "ask" });
    assert.equal(ask.TORIEL_SCOPE_ROOT, "/w");
    assert.equal(ask.TORIEL_SCOPE_MODE, "ask");
    assert.equal(env.A, "1");
  });

  it("drops both variables already in the base when no scope is given (no leak)", () => {
    const env = childEnv({ sessionId: "abc" }, "/sock", { A: "1", TORIEL_SCOPE_ROOT: "/leaked", TORIEL_SCOPE_MODE: "ask" });
    assert.equal(env.TORIEL_SCOPE_ROOT, undefined);
    assert.equal(env.TORIEL_SCOPE_MODE, undefined);
    assert.equal(env.A, "1");
  });

  it("lets the argument win over leaked base values", () => {
    const env = childEnv({}, "/sock", { TORIEL_SCOPE_ROOT: "/leaked", TORIEL_SCOPE_MODE: "deny" }, { root: "/w", mode: "ask" });
    assert.equal(env.TORIEL_SCOPE_ROOT, "/w");
    assert.equal(env.TORIEL_SCOPE_MODE, "ask");
  });

  it("never gives a !command either scope variable, even when they leak in the base", () => {
    const env = bangEnv({ sessionId: "abc" }, "/sock", { PATH: "/usr/bin", TORIEL_SCOPE_ROOT: "/leaked", TORIEL_SCOPE_MODE: "ask" }, "/pi/bin");
    assert.equal(env.TORIEL_SCOPE_ROOT, undefined);
    assert.equal(env.TORIEL_SCOPE_MODE, undefined);
  });
});

describe("the MCP file variable (tickets 209, 216)", () => {
  it("carries the path of mcp.yaml, never its contents, only when given, and never from the daemon's own environment", () => {
    assert.equal(childEnv({}, "/sock", {}, undefined, { mcpFile: "/c/toriel/mcp.yaml" }).TORIEL_MCP_FILE, "/c/toriel/mcp.yaml");
    assert.equal(childEnv({}, "/sock", {}).TORIEL_MCP_FILE, undefined);
    assert.equal(childEnv({}, "/sock", { TORIEL_MCP_FILE: "/leak.yaml" }).TORIEL_MCP_FILE, undefined, "a daemon started inside a session must not hand its own on");
  });

  it("names the servers a profile's tools reach, so that session declares them directly (ticket 298)", () => {
    assert.equal(childEnv({}, "/sock", {}, undefined, { mcpDirect: ["git", "ghidra"] }).TORIEL_MCP_DIRECT, "git,ghidra");
    assert.equal(childEnv({}, "/sock", {}, undefined, { mcpDirect: [] }).TORIEL_MCP_DIRECT, undefined);
    assert.equal(childEnv({}, "/sock", { TORIEL_MCP_DIRECT: "leak" }).TORIEL_MCP_DIRECT, undefined, "never inherited from the daemon");
  });

  it("names the file of remembered server summaries only when the daemon gives one (ticket 303)", () => {
    assert.equal(childEnv({}, "/sock", {}, undefined, { mcpSummaries: "/state/mcp-summaries.json" }).TORIEL_MCP_SUMMARIES, "/state/mcp-summaries.json");
    assert.equal(childEnv({}, "/sock", { TORIEL_MCP_SUMMARIES: "/leak" }).TORIEL_MCP_SUMMARIES, undefined, "never inherited from the daemon");
  });
});

describe("the sandbox and shared-directory variables (board 190)", () => {
  it("always gives the shared directory, and the sandbox pair only for a scoped child that asks", () => {
    const plain = childEnv({}, "/sock", {}, undefined, { sharedDir: "/shared" });
    assert.equal(plain.TORIEL_SHARED_DIR, "/shared");
    assert.equal(plain.TORIEL_SANDBOX, undefined);
    const scoped = childEnv({}, "/sock", {}, { root: "/w", mode: "deny" }, { sharedDir: "/shared", sandboxWritable: ["/home/u/.npm", "/home/u/.cache"] });
    assert.equal(scoped.TORIEL_SANDBOX, "bwrap");
    assert.equal(scoped.TORIEL_SANDBOX_RW, "/home/u/.npm:/home/u/.cache");
    assert.equal(childEnv({}, "/sock", {}, { root: "/w", mode: "deny" }, { sharedDir: "/shared" }).TORIEL_SANDBOX, undefined, "no sandbox unless asked");
  });

  it("hands a sandboxed child the persistent tmp directory, and never one from the daemon's own environment", () => {
    const scoped = childEnv({}, "/sock", {}, { root: "/w", mode: "deny" }, { sandboxWritable: [], tmpDir: "/data/tmp" });
    assert.equal(scoped.TORIEL_SANDBOX_TMP, "/data/tmp");
    assert.equal(childEnv({}, "/sock", {}, undefined, { tmpDir: "/data/tmp" }).TORIEL_SANDBOX_TMP, undefined, "no sandbox, no tmp");
    assert.equal(childEnv({}, "/sock", { TORIEL_SANDBOX_TMP: "/leaked" }).TORIEL_SANDBOX_TMP, undefined);
  });

  it("never turns the sandbox on without a scope root (it would be invalid and refuse every command)", () => {
    assert.equal(childEnv({}, "/sock", {}, undefined, { sandboxWritable: ["/x"] }).TORIEL_SANDBOX, undefined);
  });

  it("drops all three from the base, for the child and for a !command", () => {
    const leaked = { TORIEL_SANDBOX: "bwrap", TORIEL_SANDBOX_RW: "/x", TORIEL_SHARED_DIR: "/leaked", A: "1" };
    for (const env of [childEnv({}, "/sock", leaked), bangEnv({}, "/sock", leaked, "/pi/bin")]) {
      assert.equal(env.TORIEL_SANDBOX, undefined);
      assert.equal(env.TORIEL_SANDBOX_RW, undefined);
      assert.equal(env.TORIEL_SHARED_DIR, undefined);
      assert.equal(env.A, "1");
    }
  });

  it("expands ~/ in the writable roots and defaults to the npm and cache directories", () => {
    assert.deepEqual(sandboxWritableRoots({}, "/home/u"), ["/home/u/.npm", "/home/u/.cache"]);
    assert.deepEqual(sandboxWritableRoots({ sandboxWritable: ["~/x", "/abs"] }, "/home/u"), ["/home/u/x", "/abs"]);
    assert.deepEqual(sandboxWritableRoots({ sandboxWritable: [] }, "/home/u"), []);
  });
});

describe("the background command name", () => {
  it("is the same in the daemon and in the extension", () => {
    assert.equal(DAEMON_COMMAND, EXTENSION_COMMAND);
  });
});

describe("what a test run drops from a surrounding session (ticket 339)", () => {
  it("lists every variable the daemon sets on a child, so a test inside a sandboxed, scoped session sees none of them", () => {
    // the extras turn on every conditional branch childEnv has (session id, scope pair, sandbox pair and tmp, every MCP/
    // file-history/plan/freshness switch), so any new conditional key shows up in this set
    const full = childEnv({ sessionId: "abc", sessionFile: "/f" }, "/sock", {}, { root: "/w", mode: "deny" }, {
      sharedDir: "/s",
      tmpDir: "/t",
      sandboxWritable: ["/c"],
      mcpFile: "/m",
      mcpDirect: ["git"],
      mcpSummaries: "/ms",
      fileHistoryDir: "/h",
      planDir: "/p",
      freshness: false,
    });
    // the delegation pair comes straight from delegateEnv's output, so a new key there fails this test until CHILD_ENV_KEYS lists it
    const fullWithDelegation = { ...full, ...delegateEnv("types") };
    const set = Object.keys(fullWithDelegation);
    assert.deepEqual(
      set.filter((k) => !CHILD_ENV_KEYS.includes(k)),
      [],
      "a key the daemon sets on a child is missing from CHILD_ENV_KEYS",
    );
    assert.deepEqual(Object.keys(withoutSessionEnv({ ...fullWithDelegation, PATH: "/bin", TORIEL_PROFILE: "x", TORIEL_TIMING: "1" })), ["PATH"]);
    assert.ok(SESSION_ENV.includes("TORIEL_SANDBOX") && SESSION_ENV.includes("TORIEL_SCOPE_ROOT"));
  });
});
