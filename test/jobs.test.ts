import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import extension, { describeJob, endNotice, formatDuration, type Job, JobRegistry, jobEnv, shellEnv } from "../pi/extensions/toriel-jobs.ts";

const until = async (cond: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) {
      throw new Error("timed out waiting");
    }
    await new Promise((r) => setTimeout(r, 20));
  }
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("background jobs", () => {
  let dir: string;
  let ended: Job[];
  const make = (opts: { maxRunning?: number; maxLifetimeMs?: number } = {}) => new JobRegistry({ dir, ...opts, onEnd: (j) => ended.push({ ...j }) });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "toriel-jobs-test-"));
    ended = [];
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs a command, keeps its output, and reports the exit once", async () => {
    const jobs = make();
    const job = jobs.start("echo out; echo err >&2; exit 3", dir);
    await until(() => ended.length === 1);
    assert.equal(ended[0]?.state, "exited");
    assert.equal(ended[0]?.exitCode, 3);
    const out = jobs.output(job.id);
    assert.match(out?.text ?? "", /out/);
    assert.match(out?.text ?? "", /err/);
    assert.equal(jobs.runningCount(), 0);
  });

  it("reads output from an offset and only the tail when asked for less", async () => {
    const jobs = make();
    const job = jobs.start("printf 0123456789", dir);
    await until(() => ended.length === 1);
    assert.deepEqual(jobs.output(job.id, 4), { text: "456789", next: 10, skipped: 0 });
    assert.deepEqual(jobs.output(job.id, 0, 3), { text: "789", next: 10, skipped: 7 });
    assert.equal(jobs.output("nope"), undefined);
  });

  it("stops the whole process group and does not report it as an exit", async () => {
    const jobs = make();
    const job = jobs.start("sleep 30 & sleep 30 & wait", dir);
    const pid = job.pid ?? 0;
    assert.ok(alive(pid));
    jobs.stop(job.id);
    await until(() => !alive(pid));
    await until(() => jobs.get(job.id)?.endedAt !== undefined);
    assert.equal(jobs.get(job.id)?.state, "stopped");
    assert.deepEqual(ended, []);
  });

  it("refuses a job over the running limit and accepts one again after an exit", async () => {
    const jobs = make({ maxRunning: 1 });
    const first = jobs.start("sleep 30", dir);
    assert.throws(() => jobs.start("true", dir), /already running 1 background jobs/);
    jobs.stop(first.id);
    await until(() => jobs.runningCount() === 0);
    assert.ok(jobs.start("true", dir));
    await until(() => ended.length === 1);
  });

  it("stops a job that outlives the lifetime cap and says so", async () => {
    const jobs = make({ maxLifetimeMs: 150 });
    const job = jobs.start("sleep 30", dir);
    await until(() => ended.length === 1);
    assert.equal(ended[0]?.state, "timed out");
    assert.match(endNotice(ended[0] as Job, ""), /lifetime limit/);
    assert.ok(!alive(job.pid ?? 0));
  });

  it("kills every running job at once on shutdown, with no notices", async () => {
    const jobs = make();
    const a = jobs.start("sleep 30", dir);
    const b = jobs.start("sleep 30", dir);
    jobs.killAll();
    await until(() => !alive(a.pid ?? 0) && !alive(b.pid ?? 0));
    assert.deepEqual(ended, []);
  });

  it("stops writing a log at the cap and says it dropped output", async () => {
    const jobs = make();
    const job = jobs.start("head -c 9000000 /dev/zero | tr '\\0' x", dir);
    await until(() => ended.length === 1, 15000);
    const out = jobs.output(job.id, 0, 20_000_000);
    assert.ok((out?.next ?? 0) <= 8 * 1024 * 1024 + 100);
    assert.match(out?.text.slice(-60) ?? "", /output limit reached/);
  });

  it("says it dropped output also when the log filled up exactly, before the next output arrived", async () => {
    const jobs = make();
    const job = jobs.start("head -c 8388608 /dev/zero | tr '\\0' x; sleep 0.3; echo more", dir);
    await until(() => ended.length === 1, 15000);
    const out = jobs.output(job.id, 0, 20_000_000);
    assert.equal(out?.next, 8 * 1024 * 1024 + "\n[output limit reached, the rest is dropped]\n".length);
    assert.doesNotMatch(out?.text ?? "", /more/);
  });
});

describe("job messages", () => {
  const job: Job = { id: "j1", command: "npm run build", pid: 1, startedAt: 0, endedAt: 252_000, state: "exited", exitCode: 0, logPath: "/x" };

  it("tell the agent what ended, how, and where the rest of the output is", () => {
    const text = endNotice(job, "line one\nline two\n");
    assert.match(text, /Background job j1 \(npm run build\) exited with code 0 after 4m12s/);
    assert.match(text, /line two/);
    assert.match(text, /toriel_job/);
  });

  it("keep only the end of a long output, cut at a line", () => {
    const tail = Array.from({ length: 400 }, (_, i) => `row ${i}`).join("\n");
    const text = endNotice(job, tail);
    assert.match(text, /row 399/);
    assert.doesNotMatch(text, /row 0\n/);
    assert.match(text, /\nrow \d+\n/);
  });

  it("say a job was killed by a signal and that no output was produced", () => {
    assert.match(endNotice({ ...job, exitCode: null, signal: "SIGKILL" }, ""), /killed by SIGKILL.*\n\(no output\)/s);
  });

  it("format durations and list rows", () => {
    assert.equal(formatDuration(4000), "4s");
    assert.equal(formatDuration(3_900_000), "1h05m");
    assert.equal(describeJob(job, 0), "j1  exited (code 0) after 4m12s  npm run build");
    assert.equal(describeJob({ ...job, state: "running", endedAt: undefined, exitCode: undefined }, 5000), "j1  running 5s  npm run build");
  });
});

describe("a job's environment", () => {
  it("puts pi's bin directory in front of PATH once, like pi's own bash tool", () => {
    assert.equal(shellEnv({ PATH: "/usr/bin:/bin" }, "/pi/bin").PATH, "/pi/bin:/usr/bin:/bin");
    assert.equal(shellEnv({ PATH: "/usr/bin:/pi/bin" }, "/pi/bin").PATH, "/usr/bin:/pi/bin");
    assert.equal(shellEnv({}, "/pi/bin").PATH, "/pi/bin");
    assert.equal(shellEnv({ Path: "/usr/bin" }, "/pi/bin").Path, "/pi/bin:/usr/bin");
  });

  it("drops session variables inherited from the pi process and sets this call's", () => {
    const env = jobEnv({ model: { provider: "p", id: "m" }, thinkingLevel: "high" }, { PI_SESSION_ID: "stale", PI_SESSION_FILE: "/stale", PI_PROVIDER: "old", PI_MODEL: "old", PI_REASONING_LEVEL: "old" });
    assert.equal(env.PI_SESSION_ID, undefined);
    assert.equal(env.PI_SESSION_FILE, undefined);
    assert.equal(env.PI_PROVIDER, "p");
    assert.equal(env.PI_MODEL, "m");
    assert.equal(env.PI_REASONING_LEVEL, "high");
  });
});

describe("the toriel-jobs extension", () => {
  type Tool = { name: string; description: string; parameters: { properties: Record<string, unknown> }; execute: (...a: unknown[]) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> };

  const load = () => {
    const tools = new Map<string, Tool>();
    const handlers = new Map<string, (e: unknown, c: Record<string, never>) => void>();
    const messages: Array<{ customType: string; content: string }> = [];
    extension({
      registerTool: (t) => tools.set(t.name as string, t as unknown as Tool),
      on: (ev, h) => handlers.set(ev, h),
      sendMessage: (m) => {
        messages.push(m);
      },
    });
    return { tools, handlers, messages };
  };

  beforeEach(() => {
    process.env.TORIEL_CHILD = "1";
  });
  afterEach(() => {
    delete process.env.TORIEL_CHILD;
  });

  it("gives a job the same session variables pi's own bash tool sets", async () => {
    const { tools, handlers, messages } = load();
    const ctx = { cwd: tmpdir(), model: { provider: "p", id: "m" }, sessionManager: { getSessionId: () => "sess-9", getSessionFile: () => "/f.jsonl" } };
    await tools.get("bash")?.execute("c1", { command: "echo $PI_SESSION_ID $PI_MODEL; echo path=$PATH", run_in_background: true }, undefined, undefined, ctx);
    await until(() => messages.length === 1);
    assert.match(messages[0]?.content ?? "", /sess-9 m/);
    // presence, not position: when the test runner's PATH already has the directory, pi (and shellEnv) leave it where it is
    const path = /^path=(.*)$/m.exec(messages[0]?.content ?? "")?.[1] ?? "";
    assert.ok(path.split(":").includes(join(getAgentDir(), "bin")), "pi's bin directory is on PATH, as in a foreground call");
    handlers.get("session_shutdown")?.({}, {});
  });

  it("registers nothing in a plain pi session", () => {
    delete process.env.TORIEL_CHILD;
    assert.equal(load().tools.size, 0);
  });

  it("keeps the name bash (so permission rules apply) and adds run_in_background", () => {
    const { tools } = load();
    const bash = tools.get("bash");
    assert.ok(bash);
    assert.ok("run_in_background" in bash.parameters.properties);
    assert.ok("command" in bash.parameters.properties);
    assert.ok(tools.has("toriel_job"));
  });

  it("starts a background job, lists it, reads its output, and tells the agent when it ends", async () => {
    const { tools, handlers, messages } = load();
    const ctx = { cwd: tmpdir() };
    const started = await tools.get("bash")?.execute("c1", { command: "echo from-job", run_in_background: true }, undefined, undefined, ctx);
    assert.match(started?.content[0]?.text ?? "", /Started background job j1/);
    await until(() => messages.length === 1);
    assert.equal(messages[0]?.customType, "toriel-job");
    assert.match(messages[0]?.content ?? "", /j1 \(echo from-job\) exited with code 0/);
    assert.match(messages[0]?.content ?? "", /from-job/);
    const listed = await tools.get("toriel_job")?.execute("c2", { action: "list" });
    assert.match(listed?.content[0]?.text ?? "", /j1 {2}exited \(code 0\)/);
    const out = await tools.get("toriel_job")?.execute("c3", { action: "output", id: "j1" });
    assert.match(out?.content[0]?.text ?? "", /from-job\n\[j1 exited, code 0; continue from byte 9\]/);
    handlers.get("session_shutdown")?.({}, {});
  });

  it("stops a running job on request and answers plainly for an unknown job", async () => {
    const { tools, handlers } = load();
    const ctx = { cwd: tmpdir() };
    await tools.get("bash")?.execute("c1", { command: "sleep 30", run_in_background: true }, undefined, undefined, ctx);
    const stopped = await tools.get("toriel_job")?.execute("c2", { action: "stop", id: "j1" });
    assert.match(stopped?.content[0]?.text ?? "", /Stopping j1/);
    const missing = await tools.get("toriel_job")?.execute("c3", { action: "output", id: "j9" });
    assert.equal(missing?.isError, true);
    handlers.get("session_shutdown")?.({}, {});
  });

  it("still runs an ordinary command synchronously through pi's own bash", async () => {
    const { tools } = load();
    const ctx = { cwd: tmpdir(), sessionManager: { getSessionId: () => "s1", getSessionFile: () => undefined } };
    const result = await tools.get("bash")?.execute("c1", { command: "echo sync-ok" }, undefined, undefined, ctx);
    assert.match(result?.content[0]?.text ?? "", /sync-ok/);
  });
});
