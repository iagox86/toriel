import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { parseCommandLine } from "../src/cli.ts";
import { SESSION_COMMANDS } from "../src/commands.ts";
import { capTranscript, clipEntryLine, performanceDir, performancePrompt, runPerformance, savePerformance, TRANSCRIPT_CAP_BYTES } from "../src/performance.ts";

const HEADER = '{"type":"session","id":"abcd","cwd":"/tmp"}';

function lineOf(kb: number, n: number): string {
  return JSON.stringify({ type: "message", n, pad: "x".repeat(kb * 1024) });
}

function bigTranscript(lines: number, kb: number): string {
  return [HEADER, ...Array.from({ length: lines }, (_, i) => lineOf(kb, i))].join("\n");
}

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

  it("says the earliest entries were dropped only when they were", () => {
    assert.doesNotMatch(performancePrompt(false), /omitted|dropped|truncated/);
    assert.match(performancePrompt(true), /earliest entries were dropped/);
    assert.match(performancePrompt(true), /judge only what is there/);
  });
});

describe("capTranscript", () => {
  it("passes a transcript under the cap through unchanged", () => {
    assert.deepEqual(capTranscript("a\nb\n", 100), { text: "a\nb\n", truncated: false });
  });

  it("keeps the session header, the omission note, and the most recent lines within the budget", () => {
    const raw = bigTranscript(30, 2); // header + 30 entries of ~2 KiB
    const { text: capped, truncated } = capTranscript(raw, 16 * 1024);
    assert.equal(truncated, true);
    const lines = capped.split("\n");
    assert.equal(lines[0], HEADER, "the session header comes first");
    assert.match(lines[1], /^\[toriel: \d+ earlier entries omitted to fit the .* MiB transcript cap\]$/, "the omission note follows the header");
    assert.equal(lines.at(-1), lineOf(2, 29), "the newest entry is kept");
    assert.ok(!capped.includes(lineOf(2, 0)), "the oldest entries are dropped");
    assert.ok(Buffer.byteLength(capped) <= 16 * 1024 + 200, `capped length ${Buffer.byteLength(capped)}`);
    assert.ok(Buffer.byteLength(capped) > 16 * 1024 * 0.85, "the cap is filled, not emptied");
    for (const l of lines.slice(2)) {
      JSON.parse(l); // every kept line is still a whole jsonl line
    }
  });

  it("clips a single huge entry instead of losing it, keeping valid JSON with the marker", () => {
    const raw = [HEADER, lineOf(100, 0), lineOf(1, 1)].join("\n"); // one 100 KiB line
    const { text: capped, truncated } = capTranscript(raw, 64 * 1024);
    assert.equal(truncated, false, "nothing was dropped, only clipped");
    const lines = capped.split("\n");
    assert.equal(lines[0], HEADER);
    const entry = JSON.parse(lines[1]) as { pad: string };
    assert.ok(entry.pad.startsWith("xxx"));
    assert.match(entry.pad, /\.\.\.\[\d+ characters cut\]$/);
    assert.equal(lines[2], lineOf(1, 1), "the small entry after the huge one survives");
    assert.ok(Buffer.byteLength(capped) <= 64 * 1024 + 200);
  });

  it("clips huge entries and still drops the oldest ones when the clipped lines overflow the budget", () => {
    const raw = [HEADER, lineOf(100, 0), lineOf(100, 1), lineOf(100, 2), lineOf(1, 3)].join("\n");
    const { text: capped, truncated } = capTranscript(raw, 20 * 1024);
    assert.equal(truncated, true);
    const lines = capped.split("\n");
    assert.equal(lines[0], HEADER);
    assert.match(lines[1], /^\[toriel: \d+ earlier entries omitted/);
    assert.equal(lines.at(-1), lineOf(1, 3), "the newest small entry survives");
    const kept = JSON.parse(lines[2]) as { n: number; pad: string };
    assert.equal(kept.n, 1);
    assert.match(kept.pad, /\.\.\.\[\d+ characters cut\]$/, "kept huge entries arrive clipped");
    assert.ok(!capped.includes(`"n":0`), "the entry that no longer fits even clipped is dropped");
    for (const l of lines.slice(2)) {
      JSON.parse(l); // every kept line is still valid JSON
    }
    assert.ok(Buffer.byteLength(capped) <= 20 * 1024 + 200);
  });
});

describe("clipEntryLine", () => {
  it("cuts long string values and keeps the rest of the entry", () => {
    const entry = { type: "message", small: "keep", list: ["short", "y".repeat(20)] };
    const clipped = JSON.parse(clipEntryLine(JSON.stringify(entry), 10)) as { small: string; list: string[] };
    assert.equal(clipped.small, "keep");
    assert.equal(clipped.list[0], "short");
    assert.match(clipped.list[1], /^y{10}\.\.\.\[10 characters cut\]$/);
  });

  it("passes a line that is not JSON through unchanged", () => {
    assert.equal(clipEntryLine("not json at all"), "not json at all");
  });
});

describe("runPerformance", () => {
  it("runs pi toolless over a header-plus-tail capped copy and leaves the original session file untouched", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-test-"));
    try {
      const session = path.join(dir, "s.jsonl");
      const entry = (n: number) => `{"type":"message","n":${n},"pad":"${"x".repeat(499)}"}`; // ~533 bytes with newline
      const big = `${[HEADER, ...Array.from({ length: 100 }, (_, i) => entry(i))].join("\n")}\n`;
      fs.writeFileSync(session, big);
      const cli = stubPi(dir, `
        import fs from "node:fs";
        const f = process.argv[process.argv.indexOf("--session") + 1];
        const lines = fs.readFileSync(f, "utf8").split("\\n").filter((l) => l);
        let allJson = true;
        for (let i = 2; i < lines.length; i++) {
          try { JSON.parse(lines[i]); } catch { allJson = false; }
        }
        const ns = lines.slice(2).map((l) => JSON.parse(l).n);
        const prompt = process.argv.at(-1) ?? "";
        console.log(JSON.stringify({
          noTools: process.argv.includes("--no-tools"),
          header: lines[0],
          note: lines[1],
          kept: ns.length,
          oldest: ns[0],
          newest: ns.at(-1),
          allJson,
          isPerf: prompt.includes("performance review"),
          omissionInPrompt: prompt.includes("earliest entries were dropped"),
        }));
      `);
      const r = await runPerformance({ piCli: cli, file: session, capBytes: 10_000 });
      assert.equal(r.truncated, true);
      const seen = JSON.parse(r.answer) as { noTools: boolean; header: string; note: string; kept: number; oldest: number; newest: number; allJson: boolean; isPerf: boolean; omissionInPrompt: boolean };
      assert.equal(seen.noTools, true);
      assert.equal(seen.isPerf, true);
      assert.equal(seen.header, HEADER, "pi received the session header first");
      assert.match(seen.note, /^\[toriel: \d+ earlier entries omitted to fit the .* transcript cap\]$/, "the omission note follows the header");
      assert.equal(seen.allJson, true, "every entry pi received is valid JSON");
      assert.equal(seen.newest, 99, "the newest entry is kept");
      assert.equal(seen.oldest, seen.newest - seen.kept + 1, "the kept entries are the most recent ones");
      assert.equal(seen.omissionInPrompt, true, "the prompt carries the omission");
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
        console.log("lines=" + fs.readFileSync(f, "utf8").split("\\n").filter((l) => l).length + " omission=" + (process.argv.at(-1) ?? "").includes("dropped"));
      `);
      const r = await runPerformance({ piCli: cli, file: session, capBytes: TRANSCRIPT_CAP_BYTES });
      assert.equal(r.truncated, false);
      assert.equal(r.answer, "lines=1 omission=false");
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
