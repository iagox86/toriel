import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { profileTranscript, renderProfilerStats } from "../src/performance-profiler.ts";

let counter = 0;
function resetFixture() {
  counter = 0;
}
/** A jsonl line with a fresh id/parentId chain and a monotonically increasing ISO timestamp. */
function entry(type: string, extra: Record<string, unknown> = {}): string {
  counter++;
  return JSON.stringify({ type, id: `e${counter}`, parentId: counter === 1 ? null : `e${counter - 1}`, timestamp: new Date(Date.UTC(2026, 0, 1) + counter * 1000).toISOString(), ...extra });
}
function assistant(content: unknown[], provider = "litellm", model = "gemma4", offsetSeconds = 0, usage?: Record<string, unknown>): string {
  return entry("message", {
    message: {
      role: "assistant",
      content,
      provider,
      model,
      usage: usage ?? { input: 10, output: 5, cacheRead: 100, cacheWrite: 50, totalTokens: 165, cost: { input: 0.0001, output: 0.0002, total: 0.0003 } },
      timestamp: Date.UTC(2026, 0, 1) + (offsetSeconds + counter) * 1000,
    },
  });
}
function toolCall(id: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
  return { type: "toolCall", id, name, arguments: args };
}
function toolResult(toolCallId: string, toolName: string, text: string, extra: Record<string, unknown> = {}): string {
  return entry("message", { message: { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError: false, timestamp: Date.UTC(2026, 0, 1), ...extra } });
}
/** Count the indented bullets that follow a section header in the rendered block. */
function bulletsUnder(block: string, head: string): number {
  const lines = block.split("\n");
  const i = lines.indexOf(head);
  assert.notEqual(i, -1, `section ${head} is present`);
  let count = 0;
  for (let j = i + 1; j < lines.length && lines[j].startsWith("  - "); j++) {
    count++;
  }
  return count;
}

describe("profileTranscript", () => {
  it("sums per-tool calls, errors and durations, and skips results without durationMs", () => {
    resetFixture();
    const text = [
      entry("session", { id: "s", cwd: "/tmp" }),
      assistant([toolCall("c1", "bash", { command: "npm test" }), toolCall("c2", "read", { path: "/a.ts" })]),
      toolResult("c1", "bash", "ok", { durationMs: 3000 }),
      toolResult("c2", "read", "x".repeat(120)),
      // an orphan result (no matching toolCall) still counts, named by its toolName
      toolResult("c3", "bash", "boom", { isError: true, durationMs: 200 }),
    ].join("\n");
    const stats = profileTranscript(text);
    assert.deepEqual(stats.tools.find((t) => t.tool === "bash"), { tool: "bash", calls: 2, errors: 1, durationMs: 3200, outputBytes: 6 });
    assert.deepEqual(stats.tools.find((t) => t.tool === "read"), { tool: "read", calls: 1, errors: 0, outputBytes: 120 });
  });

  it("sums usage per model and counts usage entries separately", () => {
    resetFixture();
    const text = [
      entry("session", { id: "s", cwd: "/tmp" }),
      assistant([{ type: "text", text: "hi" }], "litellm", "gemma4"),
      assistant([{ type: "text", text: "hi" }], "anthropic", "claude", 0, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, cost: { input: 0, output: 0, total: 0.5 } }),
      entry("usage", { kind: "cache_warm", provider: "anthropic", model: "claude", usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 100, totalTokens: 100, cost: { input: 0, output: 0, total: 0.01 } } }),
    ].join("\n");
    const stats = profileTranscript(text);
    assert.equal(stats.models.length, 2);
    assert.deepEqual(stats.models[0], { model: "litellm/gemma4", requests: 1, input: 10, output: 5, cacheRead: 100, cacheWrite: 50, totalTokens: 165, cost: 0.0003 });
    assert.equal(stats.models[1].model, "anthropic/claude");
    assert.equal(stats.models[1].totalTokens, 10);
    assert.equal(stats.models[1].cost, 0.5);
    assert.equal(stats.usageEntries, 1, "the usage entry is counted separately, not into the model totals");
  });

  it("counts repeated reads by path, listing only paths read more than once; edits and writes do not count", () => {
    resetFixture();
    const text = [
      entry("session", { id: "s", cwd: "/tmp" }),
      assistant([toolCall("c1", "read", { path: "/same.ts" }), toolCall("c2", "edit", { path: "/other.ts" }), toolCall("c3", "read", { path: "/same.ts" }), toolCall("c4", "read", { path: "/other.ts" })]),
    ].join("\n");
    const stats = profileTranscript(text);
    assert.deepEqual(stats.repeatedPaths, [{ path: "/same.ts", count: 2 }]);
  });

  it("lists exact command repeats and, only when it finds more, the normalized repeat count", () => {
    resetFixture();
    const text = [
      entry("session", { id: "s", cwd: "/tmp" }),
      assistant([toolCall("c1", "bash", { command: "npm test" }), toolCall("c2", "bash", { command: "npm test" })]),
      assistant([toolCall("c3", "bash", { command: "build --target 12" }), toolCall("c4", "bash", { command: "build --target 99" })]),
    ].join("\n");
    const stats = profileTranscript(text);
    assert.deepEqual(stats.repeatedCommands, [{ command: "npm test", count: 2 }]);
    assert.equal(stats.exactRepeatGroups, 1);
    assert.equal(stats.normalizedCommandRepeats, 2, "digit-insensitive grouping finds the build pair too");

    // no repeats at all, exact or normalized: nothing reported
    resetFixture();
    const plain = [entry("session", { id: "s", cwd: "/tmp" }), assistant([toolCall("c1", "bash", { command: "echo one" }), toolCall("c2", "bash", { command: "echo two" })])].join("\n");
    assert.deepEqual(profileTranscript(plain).repeatedCommands, []);
    assert.equal(profileTranscript(plain).normalizedCommandRepeats, undefined);
  });

  it("orders the biggest tool outputs per result and caps the list at five", () => {
    resetFixture();
    const lines = [entry("session", { id: "s", cwd: "/tmp" })];
    for (let i = 0; i < 6; i++) {
      lines.push(assistant([toolCall(`c${i}`, "grep", { path: `/f${i}.ts` })]));
      lines.push(toolResult(`c${i}`, "grep", "y".repeat(100 * (i + 1))));
    }
    const stats = profileTranscript(lines.join("\n"));
    assert.equal(stats.biggestOutputs.length, 5);
    assert.deepEqual(stats.biggestOutputs[0], { tool: "grep", bytes: 600 }, "the biggest single output leads");
    assert.deepEqual(stats.biggestOutputs[4], { tool: "grep", bytes: 200 }, "only five survive");
  });

  it("reports the top three gaps between consecutive assistant messages with the later entry's index", () => {
    resetFixture();
    const text = [
      entry("session", { id: "s", cwd: "/tmp" }),
      // each assistant message also carries its fixture counter in seconds, so
      // consecutive gaps pick up +1000 ms; the offsets below are chosen so the
      // order still distinguishes the top three clearly
      assistant([{ type: "text", text: "a" }], "p", "m", 0),
      assistant([{ type: "text", text: "b" }], "p", "m", 100),
      assistant([{ type: "text", text: "c" }], "p", "m", 700),
      assistant([{ type: "text", text: "d" }], "p", "m", 1600),
      assistant([{ type: "text", text: "e" }], "p", "m", 1900),
    ].join("\n");
    const stats = profileTranscript(text);
    assert.deepEqual(stats.gaps, [
      { ms: 901_000, atEntry: 4 },
      { ms: 601_000, atEntry: 3 },
      { ms: 301_000, atEntry: 5 },
    ]);
  });

  it("counts compactions and remembers the last tokensBefore", () => {
    resetFixture();
    const text = [
      entry("session", { id: "s", cwd: "/tmp" }),
      entry("compaction", { summary: "s1", tokensBefore: 1000 }),
      entry("compaction", { summary: "s2", tokensBefore: 4200 }),
    ].join("\n");
    const stats = profileTranscript(text);
    assert.equal(stats.compactionCount, 2);
    assert.equal(stats.lastCompactionTokensBefore, 4200);
  });

  it("skips malformed lines and non-entry JSON without crashing", () => {
    resetFixture();
    const text = [
      entry("session", { id: "s", cwd: "/tmp" }),
      "this is not json at all",
      "123",
      "[1,2,3]",
      entry("message", { message: { role: "user", content: "hi", timestamp: 0 } }),
      "",
    ].join("\n");
    const stats = profileTranscript(text);
    assert.equal(stats.entryCount, 2, "only the two valid entries count");
    assert.equal(stats.models.length, 0);
  });

  it("computes the session span from the first and last entry timestamps", () => {
    resetFixture();
    const base = Date.UTC(2026, 0, 1);
    const text = [entry("session", { id: "s", cwd: "/tmp" }), assistant([]), entry("compaction", { summary: "s", tokensBefore: 1 })].join("\n");
    const stats = profileTranscript(text);
    assert.equal(stats.firstTimestamp, new Date(base + 1000).toISOString());
    assert.equal(stats.lastTimestamp, new Date(base + 3000).toISOString());
    assert.equal(stats.spanMs, 2000, "last entry minus first entry");
  });
});

describe("renderProfilerStats", () => {
  it("contains the quotable identifiers a reviewer would want (a path, a command)", () => {
    resetFixture();
    const text = [
      entry("session", { id: "s", cwd: "/tmp" }),
      assistant([toolCall("c1", "read", { path: "/home/ron/x.ts" }), toolCall("c2", "bash", { command: "npm test" })]),
      assistant([toolCall("c3", "read", { path: "/home/ron/x.ts" }), toolCall("c4", "bash", { command: "npm test" })]),
      toolResult("c1", "read", "abc"),
      toolResult("c2", "bash", "ok", { durationMs: 3000 }),
    ].join("\n");
    const block = renderProfilerStats(profileTranscript(text));
    assert.match(block, /\/home\/ron\/x\.ts x2/);
    assert.match(block, /`npm test` x2/);
    assert.match(block, /- span: .+ \.\. .+ \(\d+ ms\) across 5 entries/);
    assert.match(block, /read: 1 calls/);
    assert.match(block, /compactions: none/);
  });

  it("says n/a for a tool that never carried a durationMs", () => {
    resetFixture();
    const text = [entry("session", { id: "s", cwd: "/tmp" }), assistant([toolCall("c1", "read", { path: "/a" })]), toolResult("c1", "read", "x")].join("\n");
    assert.match(renderProfilerStats(profileTranscript(text)), /read: 1 calls, 0 errors, n\/a/);
  });

  it("renders the cache ratio, and n/a when nothing was fresh", () => {
    resetFixture();
    const text = [
      entry("session", { id: "s", cwd: "/tmp" }),
      assistant([{ type: "text", text: "hi" }]),
    ].join("\n");
    assert.match(renderProfilerStats(profileTranscript(text)), /cache: cacheRead 100 vs input\+cacheWrite 60 \(1\.7:1\)/);

    resetFixture();
    const allCached = [
      entry("session", { id: "s", cwd: "/tmp" }),
      assistant([{ type: "text", text: "hi" }], "litellm", "gemma4", 0, { input: 0, output: 5, cacheRead: 100, cacheWrite: 0, totalTokens: 105, cost: { input: 0, output: 0, total: 0.001 } }),
    ].join("\n");
    assert.match(renderProfilerStats(profileTranscript(allCached)), /cache: cacheRead 100 vs input\+cacheWrite 0 \(n\/a\)/);
  });

  it("caps every list at five entries and stays under 4 KB on a 200-entry transcript", () => {
    resetFixture();
    const lines = [entry("session", { id: "s", cwd: "/tmp" })];
    const tools = ["bash", "read", "grep", "edit", "write"];
    for (let i = 0; i < 200; i++) {
      const bucket = i % 5;
      const args = bucket === 0 ? { command: `run ${i % 11}` } : bucket === 1 ? { path: `/p${i % 13}.ts` } : { path: `/q${i}.ts` };
      lines.push(assistant([toolCall(`c${i}`, tools[bucket], args)], `p${i % 7}`, i % 7 === 0 ? "small" : "big"));
      if (i % 3 === 0) {
        lines.push(toolResult(`c${i}`, tools[bucket], "z".repeat(50 + i), { durationMs: i * 10 }));
      }
    }
    lines.push(entry("compaction", { summary: "s", tokensBefore: 5000 }));
    const stats = profileTranscript(lines.join("\n"));
    const block = renderProfilerStats(stats);
    assert.equal(bulletsUnder(block, "- models (7 total, top 5 by cost):"), 5);
    assert.equal(bulletsUnder(block, "- tools:"), 5, "five tools, none cut, so no total annotation");
    assert.equal(bulletsUnder(block, "- biggest tool outputs:"), 5);
    assert.equal(bulletsUnder(block, "- repeated file reads:"), 5);
    assert.equal(bulletsUnder(block, "- repeated shell commands:"), 5);
    assert.equal(bulletsUnder(block, "- longest tool durations:"), 3);
    assert.equal(bulletsUnder(block, "- biggest gaps between assistant messages:"), 3);
    assert.ok(Buffer.byteLength(block) < 4096, `block is ${Buffer.byteLength(block)} bytes`);
    assert.deepEqual(stats.longestDurations, [
      { tool: "edit", ms: 1980 },
      { tool: "bash", ms: 1950 },
      { tool: "grep", ms: 1920 },
    ]);
    assert.equal(stats.exactRepeatGroups, 11, "run 0 .. run 10 each repeat");
    assert.equal(stats.repeatedPaths.length, 5);
  });
});
