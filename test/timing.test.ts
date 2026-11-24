import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { applyTiming } from "../src/preflight.ts";
import { MAX_BYTES, Timing, timingFromEnv } from "../src/timing.ts";
import { withoutSessionEnv } from "./helpers.ts";

function harness(enabled = true, thresholdMs = 150) {
  let t = 1000;
  const lines: Array<Record<string, unknown>> = [];
  const timing = new Timing({ enabled, file: "unused", thresholdMs, proc: "controller", now: () => t, write: (l) => lines.push(JSON.parse(l)), context: () => ({ load1: 2 }) });
  return { timing, lines, advance: (ms: number) => {
      t += ms;
    } };
}

describe("timing (ticket 225)", () => {
  it("logs only what takes longer than the threshold, with what else was going on", () => {
    const { timing, lines, advance } = harness();
    timing.time("history", { messages: 8000 }, () => advance(149));
    assert.deepEqual(lines, []);
    timing.time("history", { messages: 8000 }, () => advance(200));
    assert.equal(lines.length, 1);
    assert.deepEqual({ ...(lines[0] as object), at: undefined, pid: undefined }, { at: undefined, proc: "controller", pid: undefined, event: "history", ms: 200, messages: 8000, load1: 2 });
  });

  it("times an async step, and logs it even when it throws", async () => {
    const { timing, lines, advance } = harness();
    await timing.timeAsync("daemon_launch", { session: 3 }, async () => advance(500));
    await assert.rejects(timing.timeAsync("daemon_first_meta", {}, async () => {
      advance(300);
      throw new Error("boom");
    }));
    assert.deepEqual(lines.map((l) => [l.event, l.ms]), [["daemon_launch", 500], ["daemon_first_meta", 300]]);
  });

  it("a toggle runs from the key press to the frame drawn, and says how much of it was the frame", () => {
    const { timing, lines, advance } = harness();
    timing.stamp(); // the key arrives
    advance(40); // the handler works
    timing.begin("toggle_tools", { items: 900 });
    advance(260); // the frame
    timing.rendered(260, { streaming: false });
    assert.equal(lines.length, 1, "the frame that closed the toggle is not logged a second time as a render");
    assert.deepEqual(lines[0], { at: lines[0]?.at, proc: "controller", pid: lines[0]?.pid, event: "toggle_tools", ms: 300, items: 900, streaming: false, render_ms: 260, load1: 2 });
  });

  it("a quick toggle logs nothing, and an old key press is not where it began", () => {
    const { timing, lines, advance } = harness();
    timing.stamp();
    advance(10_000);
    timing.begin("switch");
    advance(100);
    timing.rendered(100);
    assert.deepEqual(lines, []);
    timing.begin("switch");
    advance(400);
    timing.rendered(10);
    assert.equal((lines as Array<Record<string, unknown>>)[0]?.ms, 400, "timed from the begin, not the 10 s old stamp");
  });

  it("logs a slow frame of its own, at most once a second, so a streaming reply does not flood the log", () => {
    const { timing, lines, advance } = harness();
    for (let i = 0; i < 5; i++) {
      advance(100);
      timing.rendered(200);
    }
    assert.equal(lines.filter((l) => l.event === "render").length, 1);
    advance(1000);
    timing.rendered(200);
    assert.equal(lines.filter((l) => l.event === "render").length, 2);
  });

  it("does nothing when off", () => {
    const { timing, lines, advance } = harness(false);
    assert.equal(timing.time("history", {}, () => { advance(999); return 7; }), 7);
    timing.stamp();
    timing.begin("switch");
    advance(999);
    timing.rendered(999);
    assert.deepEqual(lines, []);
  });

  it("is switched on by TORIEL_TIMING=1 and reads the threshold and file from the environment", () => {
    assert.equal(timingFromEnv({}, "daemon").enabled, false);
    assert.equal(timingFromEnv({ TORIEL_TIMING: "1" }, "daemon").enabled, true);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-timing-"));
    try {
      const file = path.join(dir, "sub", "timing.jsonl");
      const timing = timingFromEnv({ TORIEL_TIMING: "1", TORIEL_TIMING_MS: "0", TORIEL_TIMING_FILE: file }, "daemon");
      timing.time("x", { a: 1 }, () => undefined);
      const line = JSON.parse(fs.readFileSync(file, "utf8").trim());
      assert.equal(line.event, "x");
      assert.equal(line.proc, "daemon");
      assert.equal(typeof line.load1, "number");
      assert.equal(typeof line.cpu_ms, "number");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("moves a file that has grown past the limit aside instead of growing for ever", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-timing-"));
    try {
      const file = path.join(dir, "timing.jsonl");
      fs.writeFileSync(file, "x".repeat(MAX_BYTES + 1));
      timingFromEnv({ TORIEL_TIMING: "1", TORIEL_TIMING_MS: "0", TORIEL_TIMING_FILE: file }, "controller").time("x", {}, () => undefined);
      assert.equal(fs.statSync(`${file}.1`).size, MAX_BYTES + 1);
      assert.match(fs.readFileSync(file, "utf8"), /^\{"at":/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the --timing argument is taken off and sets TORIEL_TIMING for the daemon it starts", () => {
    const env: NodeJS.ProcessEnv = {};
    const argv = ["node", "toriel.ts", "--timing", "doctor"];
    applyTiming(argv, env);
    assert.deepEqual(argv, ["node", "toriel.ts", "doctor"]);
    assert.equal(env.TORIEL_TIMING, "1");
    const none = ["node", "toriel.ts"];
    const clean: NodeJS.ProcessEnv = {};
    applyTiming(none, clean);
    assert.equal(clean.TORIEL_TIMING, undefined);
  });

  it("a test run inside a --timing session does not hand the switches to its test daemons (they would write to the real log)", () => {
    const env = withoutSessionEnv({ TORIEL_TIMING: "1", TORIEL_TIMING_MS: "0", TORIEL_TIMING_FILE: "/x", PATH: "/bin" });
    assert.deepEqual(env, { PATH: "/bin" });
  });
});
