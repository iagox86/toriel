import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { parseCommandLine } from "../src/cli.ts";
import { SESSION_COMMANDS } from "../src/commands.ts";
import { capTranscript, performanceDir, performancePrompt, runPerformance, savePerformance } from "../src/performance.ts";

function stubPi(dir: string, body: string): string {
  const file = path.join(dir, "pi.mjs");
  fs.writeFileSync(file, body);
  return file;
}

describe("performancePrompt", () => {
  it("asks for every review area, toolless and one-shot", () => {
    const p = performancePrompt(false);
    assert.match(p, /no tools/);
    assert.match(p, /user cannot reply/);
    assert.match(p, /context bloat/);
    assert.match(p, /compaction/);
    assert.match(p, /skill, an agent profile or an MCP server/);
    assert.match(p, /repetitive shell commands/);
    assert.match(p, /user corrections/);
    assert.match(p, /model fit/);
    assert.match(p, /permission friction/);
  });

  it("says the transcript is truncated only when it is", () => {
    assert.doesNotMatch(performancePrompt(false), /truncated/);
    assert.match(performancePrompt(true, 1000), /truncated to its first 1000 bytes/);
  });
});

describe("capTranscript", () => {
  it("passes a transcript under the cap through unchanged", () => {
    assert.deepEqual(capTranscript("a\nb\n", 100), { text: "a\nb\n", truncated: false });
  });

  it("cuts a long transcript to whole lines inside the budget, as a prefix of the original", () => {
    const line = `{"n":1,"pad":"${"x".repeat(99)}"}\n`; // 114 bytes
    const text = Array(100).fill(line).join("");
    const { text: kept, truncated } = capTranscript(text, 1000);
    assert.equal(truncated, true);
    assert.ok(Buffer.byteLength(kept) <= 1000);
    assert.ok(kept.endsWith("\n"), "the cut lands on a line boundary");
    assert.ok(text.startsWith(kept));
    for (const l of kept.split("\n").filter((l) => l !== "")) {
      JSON.parse(l); // every kept line is still a whole jsonl line
    }
  });

  it("keeps nothing when the first line alone exceeds the budget", () => {
    assert.deepEqual(capTranscript(`${"a".repeat(10)}\n`, 5), { text: "", truncated: true });
  });
});

describe("runPerformance", () => {
  it("runs pi toolless over a capped copy and leaves the original session file untouched", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-test-"));
    try {
      const session = path.join(dir, "s.jsonl");
      const big = `{"pad":"${"x".repeat(499)}"}\n`.repeat(100); // 100 x 510 bytes
      fs.writeFileSync(session, big);
      const cli = stubPi(dir, `
        import fs from "node:fs";
        const f = process.argv[process.argv.indexOf("--session") + 1];
        const body = fs.readFileSync(f, "utf8");
        const prompt = process.argv.at(-1) ?? "";
        console.log("noTools=" + process.argv.includes("--no-tools") + " lines=" + body.split("\\n").filter((l) => l).length + " prompt=" + prompt.includes("performance review") + " truncatedNote=" + prompt.includes("truncated to its first"));
      `);
      const r = await runPerformance({ piCli: cli, file: session, capBytes: 10_000 });
      assert.equal(r.truncated, true);
      assert.match(r.answer, /^noTools=true lines=19 prompt=true truncatedNote=true$/); // 10_000 / 510 = 19 whole lines
      assert.equal(fs.readFileSync(session, "utf8"), big);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sends a small transcript through in full", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-test-"));
    try {
      const session = path.join(dir, "s.jsonl");
      fs.writeFileSync(session, '{"type":"session"}\n');
      const cli = stubPi(dir, `
        import fs from "node:fs";
        const f = process.argv[process.argv.indexOf("--session") + 1];
        console.log("lines=" + fs.readFileSync(f, "utf8").split("\\n").filter((l) => l).length + " truncatedNote=" + (process.argv.at(-1) ?? "").includes("truncated"));
      `);
      const r = await runPerformance({ piCli: cli, file: session, capBytes: 1_048_576 });
      assert.equal(r.truncated, false);
      assert.equal(r.answer, "lines=1 truncatedNote=false");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("savePerformance", () => {
  it("saves a report as markdown named by the time", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-test-"));
    try {
      const file = savePerformance("findings", dir, new Date("2026-01-02T03:04:05Z"));
      assert.match(path.basename(file), /^performance-2026-01-02T03-04-05-000Z\.md$/);
      assert.equal(fs.readFileSync(file, "utf8"), "# performance review\n\nfindings\n");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps reports under the XDG data dir", () => {
    assert.equal(performanceDir({ XDG_DATA_HOME: "/d" }), path.join("/d", "toriel", "performance"));
  });
});

describe("/performance command", () => {
  it("is declared as a session command with a model flag and help", () => {
    const r = parseCommandLine(SESSION_COMMANDS, "/performance");
    assert.equal(r.kind, "run");
    const m = parseCommandLine(SESSION_COMMANDS, "/performance -m litellm/gemma4:12b");
    assert.equal(m.kind, "run");
    assert.equal(m.kind === "run" ? m.call.opts.model : undefined, "litellm/gemma4:12b");
    assert.equal(parseCommandLine(SESSION_COMMANDS, "/performance --help").kind, "help");
    assert.equal(parseCommandLine(SESSION_COMMANDS, "/performance -h").kind, "help");
  });
});
