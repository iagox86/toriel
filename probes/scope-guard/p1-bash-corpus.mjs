#!/usr/bin/env node
/**
 * P1 - Bash corpus through externalAccesses()
 *
 * Runs a fixed corpus of shell commands through the pi-permission-system
 * bash parser (BashProgram.parse) with cwd set to a scratch worktree W,
 * then reports which external paths are detected and their proven effect.
 *
 * Verdict per command:
 *   CAUGHT   - at least one external write detected
 *   READ     - external read detected but no write
 *   MISS     - no external access detected (parser gap / residue)
 *   VERBATIM-FAIL - readsVerbatim() is false (command can't be fully parsed)
 */

import { createJiti } from "jiti";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const jiti = createJiti(import.meta.url);
const PKG =
  process.env.PI_PERM_SRC ||
  "/home/ron/.nvm/versions/node/v27.0.0-alpha.0.0.0/lib/node_modules/@gotgenes/pi-permission-system/src";

// ── Scratch environment ──────────────────────────────────────────────────
const base = mkdtempSync(join(tmpdir(), "p1-"));
const W = join(base, "W"); // worktree
const MAIN = join(base, "main"); // "main checkout" sibling
const SIBLING_EVIL = join(base, "W-evil");
mkdirSync(W, { recursive: true });
mkdirSync(MAIN, { recursive: true });
mkdirSync(SIBLING_EVIL, { recursive: true });

// files inside W
writeFileSync(join(W, "a.txt"), "inside W");
writeFileSync(join(W, "script.sh"), "#!/bin/sh\necho hi\n");

// files outside W
writeFileSync(join(base, "outside.txt"), "outside W");
writeFileSync(join(MAIN, "file.txt"), "in main checkout");
writeFileSync(join(SIBLING_EVIL, "f.txt"), "sibling");
mkdirSync(join(MAIN, ".git", "worktrees", "phase1"), { recursive: true });
writeFileSync(join(MAIN, ".git", "HEAD"), "ref: refs/heads/main\n");
writeFileSync(join(MAIN, ".git", "worktrees", "phase1", "HEAD"), "ref: refs/heads/phase1\n");

// symlink inside W pointing to MAIN
const linkPath = join(W, "link-out");
try { symlinkSync(MAIN, linkPath, "dir"); } catch {}

// ── Load permission-system modules ───────────────────────────────────────
const { BashProgram } = await jiti(`${PKG}/access-intent/bash/program.ts`);
const { PathNormalizer } = await jiti(`${PKG}/path/path-normalizer.ts`);
const { posixPathFlavor } = await jiti(`${PKG}/path/path-flavor.ts`);

const normalizer = new PathNormalizer(posixPathFlavor, W);

// ── Corpus ───────────────────────────────────────────────────────────────
const corpus = [
  // ── Redirects ──
  ["echo x > ../outside.txt", "redirect >", "should catch"],
  ["echo x >> ../outside.txt", "redirect >>", "should catch"],
  ["echo x 2> ../outside.txt", "redirect 2>", "should catch"],
  ["echo x &> ../outside.txt", "redirect &>", "should catch"],
  ["exec 3> ../outside.txt && echo x >&3", "exec fd redirect", "doubtful"],

  // ── sed / awk ──
  ["sed -i 's/a/b/' ../outside.txt", "sed -i", "should catch"],
  ["sed -i 's/a/b/' ../outside*.txt", "sed -i glob", "should catch"],
  ["awk -i inplace '{print}' ../outside.txt", "awk -i inplace", "should catch"],

  // ── file ops ──
  ["cp a.txt ../outside_copy.txt", "cp", "should catch"],
  ["mv a.txt ../moved.txt", "mv", "should catch"],
  ["install -m 644 a.txt ../installed.txt", "install", "doubtful"],
  ["ln -s ../outside.txt link-in-w", "ln -s (target outside)", "doubtful"],
  ["ln -s a.txt ../link-outside", "ln -s (link outside)", "should catch"],
  ["rm ../outside.txt", "rm outside", "should catch"],
  ["mkdir ../new-dir", "mkdir outside", "should catch"],
  ["touch ../touched.txt", "touch outside", "should catch"],
  ["dd if=/dev/zero of=../dd-out.txt bs=1 count=10", "dd of= outside", "doubtful"],
  ["echo x | tee ../tee-out.txt", "tee outside", "doubtful"],
  ["echo x | tee -a ../tee-out.txt", "tee -a outside", "doubtful"],

  // ── cd / chdir tricks ──
  ["cd .. && echo x > f.txt", "cd .. then write", "should catch"],
  ["pushd ..; echo x > f.txt", "pushd .. then write", "doubtful"],
  ["(cd .. && echo x > subshell.txt)", "subshell cd ..", "should catch"],
  ["env -C .. sh -c 'echo x > env-out.txt'", "env -C ..", "doubtful"],
  ["git -C ../main status", "git -C ..", "should catch (read)"],

  // ── variable / substitution ──
  ["d=..; echo x > $d/f.txt", "var + redirect", "should catch (or fail-closed)"],
  ['echo x > "$(pwd)/../var-out.txt"', "cmd-subst redirect", "should catch or fail-closed"],
  ['eval "echo x > ../eval-out.txt"', "eval", "expect fail-closed / catch"],

  // ── symlink ──
  ["echo x > link-out/target.txt", "write via symlink out", "should catch (canonical)"],
  ["cat link-out/file.txt", "read via symlink out", "should catch (read)"],

  // ── git writes (realistic F8 leak paths) ──
  ["git checkout -b feature", "git checkout", "should catch (git writes)"],
  ["git apply ../patch.diff", "git apply external patch", "should catch"],
  ["git -C ../main commit -m 'msg'", "git -C main commit", "should catch (write)"],
  ["git worktree add ../wt2 -b branch2", "git worktree add", "should catch (write)"],

  // ── Residue (expected NOT caught) ──
  ["python3 -c 'open(\"../py-out.txt\",\"w\").write(\"x\")'", "python -c", "residue"],
  ["node -e 'require(\"fs\").writeFile(\"../node-out.txt\",\"x\")'", "node -e", "residue"],
  ["make", "make", "residue"],
  ["npm run build", "npm run", "residue"],
  ["curl -o $(pwd)/../curl-out.txt http://example.com/file", "curl -o computed", "residue"],
  ["bash script.sh", "sh script.sh (written then run)", "residue"],
  ["find .. -name '*.txt' -exec rm {} \\;", "find -exec", "residue"],
  ["ls | xargs -I{} rm ../{}", "xargs rm", "residue"],
];

// ── Run corpus ───────────────────────────────────────────────────────────
const rows = [];

for (const [cmd, label, expected] of corpus) {
  let verdict, detail, verbatim;
  try {
    const prog = await BashProgram.parse(cmd, normalizer);
    verbatim = prog.readsVerbatim();
    const exts = prog.externalAccesses();
    if (!verbatim) {
      verdict = "FAIL-CLOSED";
      detail = "readsVerbatim()=false (parse incomplete)";
    } else if (exts.length === 0) {
      verdict = "MISS";
      detail = "no external access detected";
    } else {
      const writes = exts.filter((e) => e.effect === "write" || e.effect === "unproven");
      const reads = exts.filter((e) => e.effect === "read");
      if (writes.length > 0) {
        verdict = "CAUGHT-W";
        detail = exts
          .map((e) => `${e.effect}:${e.path.value()}${e.unlocated ? ` [${e.unlocated}]` : ""}`)
          .join("; ");
      } else if (reads.length > 0) {
        verdict = "CAUGHT-R";
        detail = exts
          .map((e) => `${e.effect}:${e.path.value()}${e.unlocated ? ` [${e.unlocated}]` : ""}`)
          .join("; ");
      } else {
        verdict = "CAUGHT";
        detail = exts.map((e) => e.path.value()).join(", ");
      }
    }
  } catch (e) {
    verdict = "ERROR";
    detail = e.message;
    verbatim = "?";
  }
  rows.push({ cmd, label, expected, verdict, detail, verbatim });
}

// ── Output ───────────────────────────────────────────────────────────────
const header = "P1 BASH CORPUS RESULTS".padEnd(90, "=");
console.log(header);
console.log(`cwd (W): ${W}`);
console.log(`main checkout: ${MAIN}`);
console.log("");
console.log(
  "CMD".padEnd(55) +
    "VERDICT".padEnd(14) +
    "EXPECTED".padEnd(14) +
    "DETAIL"
);
console.log("─".repeat(120));
for (const r of rows) {
  console.log(
    r.cmd.slice(0, 54).padEnd(55) +
      r.verdict.padEnd(14) +
      r.expected.padEnd(14) +
      r.detail.slice(0, 80)
  );
}

// ── Summary ──
console.log("\n" + "SUMMARY".padEnd(90, "="));
const caught = rows.filter((r) => r.verdict.startsWith("CAUGHT")).length;
const missed = rows.filter((r) => r.verdict === "MISS").length;
const failClosed = rows.filter((r) => r.verdict === "FAIL-CLOSED").length;
const residue = rows.filter((r) => r.expected === "residue" && r.verdict === "MISS").length;
const residueCaught = rows.filter((r) => r.expected === "residue" && r.verdict !== "MISS").length;
console.log(`Caught (external access detected):  ${caught}`);
console.log(`Missed (no external access found):  ${missed}`);
console.log(`Fail-closed (unreadable parse):     ${failClosed}`);
console.log(`Residue correctly not caught:       ${residue}`);
console.log(`Residue unexpectedly caught:        ${residueCaught}`);

const shouldCatch = rows.filter((r) => r.expected.startsWith("should"));
const shouldCaught = shouldCatch.filter((r) => r.verdict.startsWith("CAUGHT")).length;
console.log(`\nShould-catch: ${shouldCaught}/${shouldCatch.length}`);
const shouldMisses = shouldCatch.filter((r) => r.verdict === "MISS");
if (shouldMisses.length) {
  console.log("  MISSED (candidate tickets):");
  shouldMisses.forEach((r) => console.log(`    - ${r.label}: ${r.cmd}`));
}

console.log("\nDone.");