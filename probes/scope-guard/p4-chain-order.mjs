#!/usr/bin/env node
/**
 * P4 - chain order vs config allow
 * P5 - headless deny, no hang (subagent terminal)
 * P6 - fail-closed semantics (link throws; TORIEL_SCOPE_ROOT contract)
 *
 * Drives the REAL gate stack: ToolCallGatePipeline -> GateRunner ->
 * applyPermissionGate -> AskEscalator (emulating AuthorizerSelection.escalate,
 * authority/authorizer-selection.ts:261-265: composeAuthorizerChain(links,
 * terminal) then terminal.authorize) with a real composeAuthorizerChain and a
 * real encloseInDelegationEnvelope around the link.
 *
 * S1  config `path_write`/`external_directory_write`/`write`/`bash` all "*"
 *     allow, outside-W write via `write` tool and via `echo x > ../o` bash:
 *     does the ask still reach the chain?
 * S2  no config (default ask), toriel-grants-shaped link denies outside W:
 *     outcome must be the LINK's deny with its reason; the subagent terminal
 *     (real ParentAuthorizer, no parent resolvable) must never be consulted.
 * S3  link returns ALLOW on the path family: the bounded-delegation envelope
 *     (delegation-envelope.ts) must downgrade it to defer -> terminal decides.
 * S4  link defers -> terminal approves -> allow (the normal grant flow).
 * S5  (P5) subagent, no scope link, no parent session resolvable: outside-W
 *     ask resolves as deny with a legible reason, fast - never a hang.
 * S6  (P5) subagent, parent named but NOT serving: deny after the ~2s
 *     serving grace, still bounded, still legible.
 * S7  (P6) a registered link that throws: what reaches the model?
 */

import { createJiti } from "jiti";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const jiti = createJiti(import.meta.url);
const PKG =
  process.env.PI_PERM_SRC ||
  "/home/ron/.nvm/versions/node/v27.0.0-alpha.0.0.0/lib/node_modules/@gotgenes/pi-permission-system/src";

// ── Scratch environment ────────────────────────────────────────────────────
const base = mkdtempSync(join(tmpdir(), "p4-"));
const W = join(base, "W");
const MAIN = join(base, "main");
mkdirSync(W, { recursive: true });
mkdirSync(MAIN, { recursive: true });
writeFileSync(join(W, "a.txt"), "x");
writeFileSync(join(base, "outside.txt"), "x");
symlinkSync(MAIN, join(W, "link-out"), "dir");

const { posixPathFlavor } = await jiti(`${PKG}/path/path-flavor.ts`);
const { PathNormalizer } = await jiti(`${PKG}/path/path-normalizer.ts`);
const { PermissionManager } = await jiti(`${PKG}/policy/permission-manager.ts`);
const { PermissionResolver } = await jiti(`${PKG}/policy/permission-resolver.ts`);
const { ToolCallGatePipeline } = await jiti(`${PKG}/handlers/gates/tool-call-gate-pipeline.ts`);
const { GateRunner } = await jiti(`${PKG}/handlers/gates/runner.ts`);
const { composeAuthorizerChain } = await jiti(`${PKG}/authority/authorizer-chain.ts`);
const { encloseInDelegationEnvelope } = await jiti(`${PKG}/authority/delegation-envelope.ts`);
const { ParentAuthorizer } = await jiti(`${PKG}/authority/approval-escalator.ts`);

const OUTSIDE = join(base, "outside.txt");

function makeManager(globalPermission) {
  const empty = { permission: {} };
  return new PermissionManager({
    flavor: posixPathFlavor,
    policyLoader: {
      loadGlobalConfig: () => ({ permission: globalPermission ?? {} }),
      loadProjectConfig: () => empty,
      loadAgentConfig: () => empty,
      loadProjectAgentConfig: () => empty,
      getConfiguredMcpServerNames: () => [],
      getCacheStamp: () => "stamp-1",
      getResolvedPolicyPaths: () => ({
        globalConfigPath: "",
        globalConfigExists: false,
        projectConfigPath: null,
        projectConfigExists: false,
        agentsDir: "",
        agentsDirExists: false,
        projectAgentsDir: null,
        projectAgentsDirExists: false,
      }),
    },
  });
}

const normalizer = new PathNormalizer(posixPathFlavor, W);
const sessionRules = { getRuleset: () => [] };
const emptyInfraScope = { dirs: [], excludedDirs: [] };

/**
 * Harness mirroring AuthorizerSelection.escalate (authorizer-selection.ts:261-265):
 * composeAuthorizerChain(links, terminal) per ask. `link` is a raw
 * (details) => verdict fn, wrapped in the REAL delegation envelope under the
 * name "toriel-grants", exactly as resolveConfiguredLinks wraps it
 * (authorizer-selection.ts:292-295).
 */
function makeHarness({ permission, link, terminal, extraEnv }) {
  const calls = { escalateCalls: 0, linkCalls: 0, terminalCalls: 0 };
  const manager = makeManager(permission);
  const resolver = new PermissionResolver(manager, sessionRules);
  const inputs = {
    getActiveSkillEntries: () => [],
    getInfrastructureReadScope: () => emptyInfraScope,
    getToolPreviewLimits: () => ({}),
    getPathNormalizer: () => normalizer,
    getShellToolAliases: () => undefined,
    getCommandEffects: () => undefined,
  };
  const pipeline = new ToolCallGatePipeline(resolver, inputs);
  const countingTerminal = {
    async authorize(details) {
      calls.terminalCalls += 1;
      return terminal.authorize(details);
    },
  };
  const wrapped = link
    ? encloseInDelegationEnvelope("toriel-grants", async (details) => {
        calls.linkCalls += 1;
        return link(details);
      })
    : null;
  const prompter = {
    async escalate(details) {
      calls.escalateCalls += 1;
      const chain = composeAuthorizerChain(
        wrapped ? [{ name: "toriel-grants", authorize: wrapped }] : [],
        countingTerminal,
        {},
        { review: () => {} },
      );
      return chain.authorize(details);
    },
  };
  const runner = new GateRunner(
    resolver,
    { recordSessionApproval: () => {} },
    prompter,
    { writeReviewLog: () => {}, emitDecision: () => {} },
    () => false,
  );
  return { pipeline, runner, calls };
}

const tccWrite = { toolName: "write", agentName: null, input: { path: OUTSIDE, content: "x" }, toolCallId: "t1", cwd: W };
const tccBash = { toolName: "bash", agentName: null, input: { command: "echo x > ../outside.txt" }, toolCallId: "t2", cwd: W };

async function run(label, tcc, harness, expectReject = false) {
  const t0 = Date.now();
  let outcome;
  try {
    outcome = await harness.pipeline.evaluate(tcc, harness.runner);
  } catch (e) {
    outcome = { action: "reject", reason: e.message };
  }
  const ms = Date.now() - t0;
  const rej = expectReject ? "REJECT" : "unexpected reject";
  const line =
    outcome.action === "allow"
      ? "allow "
      : outcome.action === "block"
        ? "BLOCK "
        : rej.padEnd(5);
  console.log(
    `${label.slice(0, 58).padEnd(60)}-> ${line.padEnd(9)} [${ms}ms]` +
      `  escalate=${harness.calls.escalateCalls} link=${harness.calls.linkCalls} terminal=${harness.calls.terminalCalls}` +
      (outcome.reason ? `  reason="${outcome.reason.slice(0, 220)}"` : ""),
  );
  return outcome;
}

// A "toriel-grants scope guard" link: deny path/external_directory-family
// asks whose canonical (boundary) value is outside W; defer otherwise.
function scopeLink() {
  return async (details) => {
    const facts = details.accessIntent;
    if (!facts) return { kind: "defer" };
    const boundary = facts.boundaryValue ?? facts.matchValues[0];
    if (boundary && !(boundary === W || boundary.startsWith(W + "/"))) {
      return {
        kind: "deny",
        reason: `scope guard: ${boundary} is outside TORIEL_SCOPE_ROOT ${W}`,
      };
    }
    return { kind: "defer" };
  };
}

const APPROVED = {
  approved: true,
  state: "approved",
  decidedBy: { kind: "authorizer", name: "terminal", verdict: "allow", reason: null },
};
function approvingTerminal() {
  return {
    async authorize() {
      return APPROVED;
    },
  };
}

// Real subagent terminal: ParentAuthorizer. ctx stub = a UI-less child session.
function subagentTerminal(calls, env) {
  const ctx = {
    hasUI: false,
    ui: {},
    cwd: W,
    sessionManager: {
      getSessionId: () => "child-session-1",
      getSessionDir: () => join(base, "agent", "sessions"),
      getEntries: () => [],
    },
  };
  const logger = { review: () => {}, debug: () => {} };
  const terminal = new ParentAuthorizer(ctx, {
    forwardingDir: join(base, "agent", "sessions", "permission-forwarding"),
    registry: undefined,
    serving: {
      isServing: () => false,
      describe: () => ({ channel: "probe", state: "unserved", servingSessionIds: [] }),
    },
    getTimeoutMs: () => 10 * 60 * 1000,
    logger,
  });
  return {
    async authorize(details) {
      calls.terminalCalls += 1;
      const saved = process.env;
      for (const k of ["PI_AGENT_ROUTER_PARENT_SESSION_ID", "PI_SUBAGENT_PARENT_SESSION"]) {
        delete process.env[k];
      }
      if (env) for (const [k, v] of Object.entries(env)) process.env[k] = v;
      try {
        return await terminal.authorize(details);
      } finally {
        process.env = saved;
      }
    },
  };
}

console.log("P4 CHAIN ORDER / P5 HEADLESS DENY / P6 FAIL-CLOSED");
console.log(`W = ${W}, outside = ${OUTSIDE}`);
console.log("");

// ── S1: config allow short-circuits before the chain ──────────────────────
const s1permission = {
  write: { "*": "allow" },
  path_write: { "*": "allow" },
  external_directory_write: { "*": "allow" },
  bash: { "*": "allow" },
};
let h = makeHarness({ permission: s1permission, link: scopeLink(), terminal: subagentTerminal({}, null) });
await run("S1a config allow*: write tool outside W (real subagent terminal)", tccWrite, h);
h = makeHarness({ permission: s1permission, link: scopeLink(), terminal: subagentTerminal({}, null) });
await run("S1b config allow*: bash 'echo x > ../outside.txt'", tccBash, h);

// ── S2: no config; scope link denies; subagent terminal must not run ─────
h = makeHarness({ permission: {}, link: scopeLink(), terminal: subagentTerminal({}, null) });
await run("S2 default ask: write outside W, scope link denies", tccWrite, h);

// ── S3: link ALLOW on the path family is capped to defer (envelope) ──────
h = makeHarness({
  permission: {},
  link: async () => ({ kind: "allow" }),
  terminal: subagentTerminal({}, null),
});
await run("S3 link allow on path write (envelope must downgrade)", tccWrite, h);

// ── S4: link defers; terminal (approving) decides ─────────────────────────
h = makeHarness({ permission: {}, link: scopeLink(), terminal: approvingTerminal() });
// scopeLink defers only in-W; OUTSIDE is denied, so use a path under W for the defer flow:
const tccWriteIn = { toolName: "write", agentName: null, input: { path: join(W, "new.txt"), content: "x" }, toolCallId: "t3", cwd: W };
await run("S4 in-W write: link defers, approving terminal allows", tccWriteIn, h);

// ── S5 (P5): subagent, no scope link, no parent resolvable ───────────────
h = makeHarness({ permission: {}, link: null, terminal: subagentTerminal({}, null) });
await run("S5 subagent no parent: outside-W ask (no scope link)", tccWrite, h);

// ── S6 (P5): subagent, parent named but not serving ──────────────────────
h = makeHarness({ permission: {}, link: null, terminal: subagentTerminal({}, { PI_SUBAGENT_PARENT_SESSION: "parent-x" }) });
await run("S6 subagent parent not serving: outside-W ask", tccWrite, h);

// ── S7 (P6): a registered link that throws ───────────────────────────────
h = makeHarness({
  permission: {},
  link: async () => {
    throw new Error("boom: scope link crashed");
  },
  terminal: subagentTerminal({}, null),
});
const s7 = await run("S7 link throws: what does the pipeline do?", tccWrite, h, true);
console.log(
  s7.action === "reject"
    ? "\nP6: pipeline.evaluate REJECTS on a throwing link; in production the\n"
      + "  tool_call boundary (handlers/tool-call-boundary.ts:23-36, 56-59) owns the\n"
      + "  try/catch: it blocks the call and writes a gate_error review entry\n"
      + "  ('[pi-permission-system] ' + formatted error). Fail-closed = BLOCK, not ask.\n"
      + "  The reason text is the generic error, NOT a scope message - a well-behaved\n"
      + "  link therefore must never throw (toriel-grants.ts defers on every error)."
    : "\nP6 UNEXPECTED: pipeline absorbed the throw",
);
