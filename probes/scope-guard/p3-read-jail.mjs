#!/usr/bin/env node
/**
 * P3 - Read jail cost (decision 1: reads AND writes, if no extra work)
 *
 * Part 1: the P2 precedence table repeated on `path_read` (the cross-cutting
 * path-gate surface for read-only tools, handlers/gates/path.ts:40,
 * capabilitySurfaceForTool("path", "read")) and on `external_directory_read`
 * (the boundary gate, handlers/gates/external-directory.ts:58).
 *   RS-A = [ deny "*", allow "<W>/**" ]   (deny first, specific allow last)
 *   RS-B = [ allow "<W>/**", deny "*" ]
 * Cases: inside W, parent via .., sibling W-evil, symlink inside W pointing out.
 *
 * Part 2: full-pipeline cost of a `path_read: {"*": "deny"}` catch-all on
 * real `read` tool calls through the real ToolCallGatePipeline + GateRunner:
 *   (a) read of an infra dir (agentDir/skills) under the catch-all deny
 *   (b) read of an in-W file under the same catch-all deny + W/** allow
 *   (c) read of an infra dir with NO rules (today's baseline: ask)
 * Evidence: the external_directory gate's infra auto-allow
 * (handlers/gates/external-directory.ts:71-101) is the ONLY bypass that
 * survives a catch-all deny (isTargetedDeny, :131-147) - and the path gate
 * (describePathGate, handlers/gates/path.ts:49-56) has NO such bypass and
 * runs deny-first (orderDenyFirst, descriptor.ts), so a catch-all
 * path_read deny blocks infra reads too. Part 2 shows that live.
 *
 * Part 3: what the infra auto-allow roots actually are on this host
 * (computeExtensionPaths, config/extension-paths.ts) - the reads a
 * deny-by-default config does NOT need to allowlist because the package
 * already auto-allows them... except when the path gate denies first.
 *
 * Verdict: expressible? what must the allowlist contain? or defer reads?
 */

import { createJiti } from "jiti";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const jiti = createJiti(import.meta.url);
const PKG =
  process.env.PI_PERM_SRC ||
  "/home/ron/.nvm/versions/node/v27.0.0-alpha.0.0.0/lib/node_modules/@gotgenes/pi-permission-system/src";

// Reference source for citation checks (PI_PERM_SRC defaults to the pi-load
// location, but the cited line numbers are against /home/ron/projects/pi-permission-system-src)
//

// ── Scratch environment ────────────────────────────────────────────────────
const base = mkdtempSync(join(tmpdir(), "p3-"));
const W = join(base, "W");
const MAIN = join(base, "main");
const SIB = join(base, "W-evil");
const AGENT = join(base, "agent"); // scratch agentDir
mkdirSync(W, { recursive: true });
mkdirSync(MAIN, { recursive: true });
mkdirSync(SIB, { recursive: true });
mkdirSync(join(AGENT, "skills", "messaging"), { recursive: true });
writeFileSync(join(W, "a.txt"), "x");
writeFileSync(join(base, "outside.txt"), "x");
writeFileSync(join(SIB, "f.txt"), "x");
writeFileSync(join(AGENT, "skills", "messaging", "SKILL.md"), "skill");
symlinkSync(MAIN, join(W, "link-out"), "dir");

const { posixPathFlavor } = await jiti(`${PKG}/path/path-flavor.ts`);
const { PathNormalizer } = await jiti(`${PKG}/path/path-normalizer.ts`);
const rule = await jiti(`${PKG}/policy/rule.ts`);
const { evaluateAnyValue } = rule;
const normalizer = new PathNormalizer(posixPathFlavor, W);

// ── Part 1: matcher table on the read surfaces ────────────────────────────
function mkRule(surface, pattern, action) {
  return { surface, pattern, action, origin: "global", layer: "config" };
}

const cases = [
  ["inside W (W/a.txt)", "a.txt"],
  ["parent via .. (../outside)", "../outside.txt"],
  ["sibling (W-evil/f.txt)", "../W-evil/f.txt"],
  ["symlink out (link-out/target.txt)", "link-out/target.txt"],
  ["agentDir skill", join(AGENT, "skills", "messaging", "SKILL.md")],
];

function run(surface, rs, values) {
  return evaluateAnyValue(surface, values, rs, posixPathFlavor).rule.action;
}

function rs(surfaces) {
  const out = [];
  for (const s of surfaces) {
    out.push(mkRule(s, "*", "deny"));
    out.push(mkRule(s, W + "/**", "allow"));
  }
  return out;
}
const RS_REVERSED = ["path_read", "external_directory_read"].flatMap((s) => [
  mkRule(s, W + "/**", "allow"),
  mkRule(s, "*", "deny"),
]);

console.log("P3 READ JAIL  (P2 shape on the read surfaces)");
console.log(`W = ${W}`);
console.log(`scratch agentDir = ${AGENT}\n`);
console.log("RS-A = [deny '*' then allow '<W>/**'] on both read surfaces");
console.log("RS-B = [allow '<W>/**' then deny '*'] on both read surfaces\n");

const hdr =
  "CASE".padEnd(34) +
  "path_read".padEnd(12) +
  "ext_dir_read".padEnd(14) +
  "RS-B path_read".padEnd(16) +
  "match values";
console.log(hdr);
console.log("-".repeat(110));
const rsA = rs(["path_read", "external_directory_read"]);
for (const [name, rel] of cases) {
  const values = normalizer.forPath(rel).matchValues();
  const a1 = run("path_read", rsA.filter((r) => r.surface === "path_read"), values);
  const a2 = run(
    "external_directory_read",
    rsA.filter((r) => r.surface === "external_directory_read"),
    values,
  );
  const b1 = run(
    "path_read",
    RS_REVERSED.filter((r) => r.surface === "path_read"),
    values,
  );
  const mv = values.join("  |  ");
  console.log(
    name.slice(0, 33).padEnd(34) +
      a1.padEnd(12) +
      a2.padEnd(14) +
      b1.padEnd(16) +
      mv.slice(0, 90),
  );
}

console.log(
  "\nnote: the symlink case carries the canonical alias (access-path.ts matchValues),",
);
console.log(
  `  e.g. ${normalizer.forPath("link-out/target.txt")
    .matchValues()
    .join(" | ")}`,
);
console.log(
  "  so under last-match-wins (rule.ts:107/:236) a LATER allow on the lexical alias",
);
console.log(
  "  still wins even though the canonical target is outside W: config cannot close the",
);
console.log(
  "  symlink hole; only a chain link checking boundaryValue/canonical can.",
);

// ── Part 2: full pipeline, `read` tool calls ──────────────────────────────
const { PermissionManager } = await jiti(`${PKG}/policy/permission-manager.ts`);
const { PermissionResolver } = await jiti(
  `${PKG}/policy/permission-resolver.ts`,
);
const { ToolCallGatePipeline } = await jiti(
  `${PKG}/handlers/gates/tool-call-gate-pipeline.ts`,
);
const { GateRunner } = await jiti(`${PKG}/handlers/gates/runner.ts`);
const { composeAuthorizerChain } = await jiti(
  `${PKG}/authority/authorizer-chain.ts`,
);

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

const sessionRules = { getRuleset: () => [] };

// The REAL infra auto-allow scope for the scratch agentDir (computeExtensionPaths).
const { computeExtensionPaths: ceP } = await jiti(`${PKG}/config/extension-paths.ts`);
const realInfraScope = (() => {
  const p = ceP(AGENT);
  return { dirs: [...p.piInfrastructureDirs], excludedDirs: [...p.piInfrastructureExcludedDirs] };
})();
function makeDenyingTerminal(calls) {
  return {
    async authorize() {
      calls.terminalCalls += 1;
      return {
        approved: false,
        state: "denied",
        confirmationUnavailable: false,
        denialReason: "terminal-refused",
        decidedBy: { kind: "authorizer", name: "terminal", verdict: "deny", reason: "terminal-refused" },
      };
    },
  };
}
// A toriel-grants-shaped link: deny the path/external_directory family when
// the access's boundary (canonical) value falls outside W; defer otherwise.
function scopeLinkFor(calls) {
  return async (details) => {
    calls.linkCalls += 1;
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

function makeHarness({ permission, link }) {
  const calls = { escalateCalls: 0, linkCalls: 0, terminalCalls: 0 };
  const activeLink = link ? scopeLinkFor(calls) : link;
  const terminal = makeDenyingTerminal(calls);
  const manager = makeManager(permission);
  const resolver = new PermissionResolver(manager, sessionRules);
  const inputs = {
    getActiveSkillEntries: () => [],
    getInfrastructureReadScope: () => realInfraScope,
    getToolPreviewLimits: () => ({}),
    getPathNormalizer: () => normalizer,
    getShellToolAliases: () => undefined,
    getCommandEffects: () => undefined,
  };
  const pipeline = new ToolCallGatePipeline(resolver, inputs);
  const prompter = {
    async escalate(details) {
      calls.escalateCalls += 1;
      const chain = composeAuthorizerChain(
        activeLink ? [{ name: "toriel-grants", authorize: activeLink }] : [],
        terminal,
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

const tccRead = (path) => ({
  toolName: "read",
  agentName: null,
  input: { path },
  toolCallId: "t1",
  cwd: W,
});

async function part(label, tcc, harness) {
  const t0 = Date.now();
  let outcome;
  try {
    outcome = await harness.pipeline.evaluate(tcc, harness.runner);
  } catch (e) {
    outcome = { action: "error", reason: e.message };
  }
  const ms = Date.now() - t0;
  console.log(
    `${label.padEnd(52)} -> ${outcome.action}${outcome.reason ? ` (${outcome.reason.slice(0, 60)})` : ""}  [${ms}ms]` +
      `  escalate=${harness.calls.escalateCalls} link=${harness.calls.linkCalls} terminal=${harness.calls.terminalCalls}`,
  );
  return outcome;
}

console.log("\nP2: pipeline outcomes for `read` tool calls");
console.log("-".repeat(110));

// (a) infra-dir skill read under catch-all path_read deny + W/** allow
let h = makeHarness({
  permission: { path_read: { "*": "deny", [W + "/**"]: "allow" } },
  link: true,
});
await part(
  "(a) read agentDir/skills/... with path_read '*':deny",
  tccRead(join(AGENT, "skills", "messaging", "SKILL.md")),
  h,
);

// (b) in-W read under the catch-all deny + W allow + read-tool allow (worker stays functional in W)
h = makeHarness({
  permission: {
    path_read: { "*": "deny", [W + "/**"]: "allow" },
    read: { "*": "allow" },
  },
  link: true,
});
await part("(b) read W/a.txt: path_read deny + W/** allow + read allow", tccRead("a.txt"), h);

// (c) infra-dir read, NO rules, no link (baseline: what the infra auto-allow does today)
h = makeHarness({ permission: {}, link: false });
await part("(c) read agentDir/skills/... no rules, no link (infra baseline)", tccRead(join(AGENT, "skills", "messaging", "SKILL.md")), h);

// (d) infra-dir read under catch-all path_read deny + read allow (does the path gate still block infra reads?)
h = makeHarness({
  permission: {
    path_read: { "*": "deny", [W + "/**"]: "allow" },
    read: { "*": "allow" },
  },
  link: false,
});
await part(
  "(d) read agentDir/skills/... path_read deny + read allow, no link",
  tccRead(join(AGENT, "skills", "messaging", "SKILL.md")),
  h,
);

// (e) infra-dir read, no path_read rule, only external_directory_read catch-all deny
h = makeHarness({
  permission: { external_directory_read: { "*": "deny" }, read: { "*": "allow" } },
  link: false,
});
await part(
  "(e) read agentDir/skills/... external_directory_read '*':deny only",
  tccRead(join(AGENT, "skills", "messaging", "SKILL.md")),
  h,
);

// ── Part 3: the infra auto-allow roots on this host ──────────────────────
const paths = ceP(AGENT);
console.log("\nP3: infra auto-allow roots for scratch agentDir (extension-paths.ts)");
for (const d of paths.piInfrastructureDirs) console.log(`  dir:     ${d}`);
for (const d of paths.piInfrastructureExcludedDirs) console.log(`  exclude: ${d}`);
console.log(
  "\n  pi-infrastructure-read.ts: project-local <cwd>/.pi/npm and <cwd>/.pi/git are auto-allowed too.",
);
