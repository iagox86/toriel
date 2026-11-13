#!/usr/bin/env node
/**
 * P2 - Rule precedence (decides whether `{"*": "deny", "<W>/**": "allow"}` is expressible)
 *
 * Tests the REAL matcher (evaluate / evaluateAnyValue from rule.ts + wildcard-matcher.ts)
 * against a scratch worktree W. Cases: inside W, parent via .., sibling W-evil, symlink out.
 * Compares two ruleset orderings:
 *   RS-A: [ deny "*", allow "<W>/**" ]   (deny first, specific allow second)
 *   RS-B: [ allow "<W>/**", deny "*" ]   (specific allow first, catch-all deny second)
 *
 * Mechanism to cite:
 *  - rule.ts:107  evaluate() -> rules.findLast(...)        => LAST-MATCH-WINS
 *  - wildcard-matcher.ts findCompiledWildcardMatch -> patterns.findLast
 *  - rule.ts evaluateAnyValue: last rule matching ANY alias value wins
 *  - permission-resolver.ts:96-106 folds a BARE family over _read/_write most-restrictive
 */
import { createJiti } from "jiti";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const jiti = createJiti(import.meta.url);
const PKG = "/home/ron/.nvm/versions/node/v27.0.0-alpha.0.0.0/lib/node_modules/@gotgenes/pi-permission-system/src";

const base = mkdtempSync(join(tmpdir(), "p2-"));
const W = join(base, "W");
const MAIN = join(base, "main");
const SIB = join(base, "W-evil");
mkdirSync(W, { recursive: true });
mkdirSync(MAIN, { recursive: true });
mkdirSync(SIB, { recursive: true });
writeFileSync(join(W, "a.txt"), "x");
writeFileSync(join(base, "outside.txt"), "x");
writeFileSync(join(SIB, "f.txt"), "x");
writeFileSync(join(MAIN, "target.txt"), "x");
symlinkSync(MAIN, join(W, "link-out"), "dir");

const { posixPathFlavor } = await jiti(`${PKG}/path/path-flavor.ts`);
const { PathNormalizer } = await jiti(`${PKG}/path/path-normalizer.ts`);
const rule = await jiti(`${PKG}/policy/rule.ts`);
const { evaluateAnyValue } = rule;

const normalizer = new PathNormalizer(posixPathFlavor, W);

// Build the same match-value set the real resolver hands to the matcher.
const vals = (rel) => normalizer.forPath(rel).matchValues();

const cases = [
  ["inside W (W/a.txt)",        vals("a.txt")],
  ["parent via .. (../outside)", vals("../outside.txt")],
  ["sibling (W-evil/f.txt)",    vals("../W-evil/f.txt")],
  ["symlink out (link-out/target.txt)", vals("link-out/target.txt")],
];

function mkRule(surface, pattern, action) {
  return { surface, pattern, action, origin: "global", layer: "config" };
}
const SURFACE = "path_write";
const RS_A = [ mkRule(SURFACE, "*", "deny"),      mkRule(SURFACE, W + "/**", "allow") ];
const RS_B = [ mkRule(SURFACE, W + "/**", "allow"), mkRule(SURFACE, "*", "deny") ];

function run(rs, values) {
  const { rule } = evaluateAnyValue(SURFACE, values, rs, posixPathFlavor);
  return rule.action;
}

console.log("P2 RULE PRECEDENCE  (surface: path_write)");
console.log(`W = ${W}`);
console.log("");
console.log("RS-A = [ deny '*', allow '<W>/**' ]   (recommended 'deny outside, allow inside' ordering)");
console.log("RS-B = [ allow '<W>/**', deny '*' ]   (reversed ordering)\n");

const hdr = "CASE".padEnd(32) + "RS-A".padEnd(8) + "RS-B".padEnd(8) + "match values";
console.log(hdr);
console.log("-".repeat(96));
for (const [name, values] of cases) {
  const a = run(RS_A, values);
  const b = run(RS_B, values);
  const mv = values.slice(0, 2).join("  |  ").slice(0, 60);
  console.log(name.padEnd(32) + a.padEnd(8) + b.padEnd(8) + mv);
}
