import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bangEnv, childEnv } from "../src/child-env.ts";
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

describe("the background command name", () => {
  it("is the same in the daemon and in the extension", () => {
    assert.equal(DAEMON_COMMAND, EXTENSION_COMMAND);
  });
});
