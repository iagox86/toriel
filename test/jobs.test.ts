import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { makeWrap, readSandbox } from "../pi/extensions/lib/sandbox.ts";
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

  it("does not cut a multi-byte character when it returns only the tail", async () => {
    const jobs = make();
    const job = jobs.start("printf 'ab🙂cd'", dir); // 2 + 4 + 2 bytes
    await until(() => ended.length === 1);
    // a 4-byte limit lands inside the emoji: its remaining bytes are skipped, not decoded to U+FFFD
    assert.deepEqual(jobs.output(job.id, 0, 4), { text: "cd", next: 8, skipped: 6 });
    assert.deepEqual(jobs.output(job.id, 0, 6), { text: "🙂cd", next: 8, skipped: 2 });
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

describe("foreground commands", () => {
  let dir: string;
  let ended: Job[];
  const make = (opts: { maxRunning?: number } = {}) => new JobRegistry({ dir, ...opts, onEnd: (j) => ended.push({ ...j }) });
  const collect = () => {
    const chunks: string[] = [];
    return { chunks, onData: (c: Buffer) => chunks.push(c.toString()), text: () => chunks.join("") };
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "toriel-fg-test-"));
    ended = [];
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("run to the end like pi's own: output streamed, exit code returned, no job record and no notice", async () => {
    const jobs = make();
    const out = collect();
    assert.deepEqual(await jobs.runForeground("echo hi; exit 4", dir, process.env, { onData: out.onData }), { exitCode: 4 });
    assert.match(out.text(), /hi/);
    assert.deepEqual(jobs.list(), []);
    assert.deepEqual(ended, []);
    assert.equal(jobs.runningCount(), 0);
  });

  it("are killed with their process group when the call is aborted, and report 'aborted'", async () => {
    const jobs = make();
    const ac = new AbortController();
    const pending = jobs.runForeground("sleep 30 & sleep 30 & wait", dir, process.env, { onData: () => {}, signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    await assert.rejects(pending, /^Error: aborted$/);
    assert.deepEqual(ended, []);
  });

  it("are killed at their timeout, which is reported the way pi's tool expects", async () => {
    const jobs = make();
    await assert.rejects(jobs.runForeground("sleep 30", dir, process.env, { onData: () => {}, timeout: 0.2 }), /^Error: timeout:0\.2$/);
  });

  it("refuse an already-aborted call and a missing directory without starting anything", async () => {
    const jobs = make();
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(jobs.runForeground("true", dir, process.env, { onData: () => {}, signal: ac.signal }), /aborted/);
    await assert.rejects(jobs.runForeground("true", join(dir, "nope"), process.env, { onData: () => {} }), /Working directory does not exist/);
  });

  it("do not count against the background limit", async () => {
    const jobs = make({ maxRunning: 1 });
    const bg = jobs.start("sleep 30", dir);
    assert.deepEqual(await jobs.runForeground("echo still-runs", dir, process.env, { onData: () => {} }), { exitCode: 0 });
    jobs.stop(bg.id);
    await until(() => jobs.runningCount() === 0);
  });

  it("become a job when moved to the background: the call returns, the command keeps running, and its exit is reported", async () => {
    const jobs = make();
    const out = collect();
    const pending = jobs.runForeground("echo before; sleep 0.4; echo after", dir, process.env, { onData: out.onData });
    await until(() => /before/.test(out.text()));
    const { promoted, refused } = jobs.backgroundAll();
    assert.equal(refused, 0);
    assert.equal(promoted.length, 1);
    assert.equal(promoted[0]?.id, "j1");
    assert.deepEqual(await pending, { exitCode: 0 });
    assert.match(out.text(), /moved this command to the background as job j1/);
    assert.equal(jobs.runningCount(), 1);
    assert.equal(jobs.get("j1")?.state, "running");
    await until(() => ended.length === 1);
    assert.equal(ended[0]?.id, "j1");
    assert.equal(ended[0]?.exitCode, 0);
    const log = jobs.output("j1")?.text ?? "";
    assert.match(log, /before/);
    assert.match(log, /after/);
    assert.doesNotMatch(out.text(), /after/, "output after the move goes to the log, not the finished call");
  });

  it("keep their place in the foreground when the background limit is full, and say how many", async () => {
    const jobs = make({ maxRunning: 1 });
    const bg = jobs.start("sleep 30", dir);
    const out = collect();
    const pending = jobs.runForeground("sleep 0.3; echo done", dir, process.env, { onData: out.onData });
    const { promoted, refused } = jobs.backgroundAll();
    assert.equal(promoted.length, 0);
    assert.equal(refused, 1);
    assert.deepEqual(await pending, { exitCode: 0 });
    assert.match(out.text(), /done/);
    jobs.stop(bg.id);
    await until(() => jobs.runningCount() === 0);
  });

  it("stay out of the job list and cannot be read or stopped as jobs while the call waits", async () => {
    const jobs = make();
    const pending = jobs.runForeground("sleep 0.3", dir, process.env, { onData: () => {} });
    assert.deepEqual(jobs.list(), []);
    assert.equal(jobs.get("fg1"), undefined);
    assert.equal(jobs.stop("fg1"), undefined);
    assert.deepEqual(await pending, { exitCode: 0 });
  });

  it("move nothing when nothing is running in the foreground", () => {
    const jobs = make();
    assert.deepEqual(jobs.backgroundAll(), { promoted: [], refused: 0 });
  });

  it("are killed at shutdown like any job, and a moved one honours the lifetime cap", async () => {
    const jobs = new JobRegistry({ dir, maxLifetimeMs: 200, onEnd: (j) => ended.push({ ...j }) });
    const pending = jobs.runForeground("sleep 30", dir, process.env, { onData: () => {} });
    jobs.backgroundAll();
    await pending;
    await until(() => ended.length === 1);
    assert.equal(ended[0]?.state, "timed out");
  });
});

describe("the sandbox wrapper (board 190)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "toriel-wrap-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const collect = () => {
    const chunks: string[] = [];
    return { onData: (c: Buffer) => chunks.push(c.toString()), text: () => chunks.join("") };
  };

  it("spawns what the wrapper says, for a foreground command and a background job", async () => {
    const seen: string[] = [];
    const jobs = new JobRegistry({
      dir,
      onEnd: () => {},
      wrap: (command, cwd) => {
        seen.push(`${command}@${cwd}`);
        return { file: "bash", args: ["-c", `echo wrapped; ${command}`] };
      },
    });
    const out = collect();
    assert.deepEqual(await jobs.runForeground("echo inner", dir, process.env, { onData: out.onData }), { exitCode: 0 });
    assert.match(out.text(), /wrapped\ninner/);
    const job = jobs.start("echo bg", dir);
    await until(() => jobs.get(job.id)?.state === "exited");
    assert.match(jobs.output(job.id, 0, 1000)?.text ?? "", /wrapped\nbg/);
    assert.deepEqual(seen, [`echo inner@${dir}`, `echo bg@${dir}`]);
  });

  it("refuses the command when the wrapper throws: nothing runs, no log file or job is left behind", async () => {
    const jobs = new JobRegistry({
      dir,
      onEnd: () => {},
      wrap: () => {
        throw new Error("sandbox: refused");
      },
    });
    await assert.rejects(jobs.runForeground(`touch ${join(dir, "ran")}`, dir, process.env, { onData: () => {} }), /sandbox: refused/);
    assert.throws(() => jobs.start("true", dir), /sandbox: refused/);
    assert.equal(jobs.list().length, 0);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(existsSync(join(dir, "ran")), false);
  });

  it("says the command was not run when the sandbox program cannot start", async () => {
    const jobs = new JobRegistry({ dir, onEnd: () => {}, wrap: () => ({ file: "definitely-not-a-real-bwrap", args: [] }) });
    await assert.rejects(jobs.runForeground("true", dir, process.env, { onData: () => {} }), /sandbox: could not start definitely-not-a-real-bwrap .*the command was not run/);
  });
});

const bwrapWorks = spawnSync("bwrap", ["--ro-bind", "/", "/", "true"], { stdio: "ignore" }).status === 0;

describe("the registry with the real sandbox (board 190)", { skip: bwrapWorks ? false : "bwrap is not usable here" }, () => {
  let root: string;
  let outside: string;
  beforeEach(() => {
    // not under /tmp: the sandbox hides it
    root = realpathSync(mkdtempSync(join("/var/tmp", "toriel-realwrap-")));
    outside = realpathSync(mkdtempSync(join("/var/tmp", "toriel-realwrap-out-")));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  const registry = () => {
    const cfg = readSandbox({ TORIEL_SANDBOX: "bwrap", TORIEL_SCOPE_ROOT: root });
    assert.equal(cfg.kind, "bwrap");
    return new JobRegistry({ dir: root, onEnd: () => {}, wrap: makeWrap(cfg) });
  };

  it("runs a command that writes inside the root and refuses one that writes outside it", async () => {
    const jobs = registry();
    const out = { text: "" };
    const onData = (c: Buffer) => {
      out.text += c.toString();
    };
    assert.deepEqual(await jobs.runForeground(`echo ok > ${root}/in && echo ok > ${outside}/out`, root, process.env, { onData }), { exitCode: 1 });
    assert.equal(existsSync(join(root, "in")), true);
    assert.equal(existsSync(join(outside, "out")), false);
    assert.match(out.text, /Read-only file system/);
  });

  it("is still killed on timeout and on abort: the process group reaches the sandboxed command", async () => {
    const jobs = registry();
    await assert.rejects(jobs.runForeground("sleep 31.337", root, process.env, { onData: () => {}, timeout: 0.3 }), /timeout:0\.3/);
    const ac = new AbortController();
    const pending = jobs.runForeground("sleep 31.338", root, process.env, { onData: () => {}, signal: ac.signal });
    await new Promise((r) => setTimeout(r, 300));
    ac.abort();
    await assert.rejects(pending, /aborted/);
    await new Promise((r) => setTimeout(r, 300));
    for (const marker of ["sleep 31.337", "sleep 31.338"]) {
      assert.equal(spawnSync("pgrep", ["-f", marker]).status, 1, `no "${marker}" process is left running`);
    }
  });

  it("stops a sandboxed background job on request", async () => {
    const jobs = registry();
    const job = jobs.start("sleep 31.339", root);
    await new Promise((r) => setTimeout(r, 300));
    jobs.stop(job.id);
    await until(() => jobs.get(job.id)?.state !== "running");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(spawnSync("pgrep", ["-f", "sleep 31.339"]).status, 1, "the sandboxed sleep is gone");
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
    const commands = new Map<string, (args: string, ctx: { ui: { notify: (m: string) => unknown } }) => Promise<void> | void>();
    extension({
      registerCommand: (name, o) => commands.set(name, o.handler as never),
      registerTool: (t) => tools.set(t.name as string, t as unknown as Tool),
      on: (ev, h) => handlers.set(ev, h),
      sendMessage: (m) => {
        messages.push(m);
      },
    });
    return { tools, handlers, messages, commands };
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

  it("moves a running foreground bash call to the background on the toriel-background command, and the call returns what it had", async () => {
    const { tools, handlers, messages, commands } = load();
    const ctx = { cwd: tmpdir(), sessionManager: { getSessionId: () => "s1", getSessionFile: () => undefined } };
    const call = tools.get("bash")?.execute("c1", { command: "echo first; sleep 0.5; echo second" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 150));
    const notes: string[] = [];
    await commands.get("toriel-background")?.("", { ui: { notify: (m: string) => notes.push(m) } });
    assert.match(notes[0] ?? "", /Moved to the background: j1 \(echo first/);
    const result = await call;
    assert.match(result?.content[0]?.text ?? "", /first/);
    assert.match(result?.content[0]?.text ?? "", /moved this command to the background as job j1/);
    assert.notEqual(result?.isError, true);
    await until(() => messages.length === 1);
    assert.match(messages[0]?.content ?? "", /Background job j1 .* exited with code 0/);
    assert.match(messages[0]?.content ?? "", /second/);
    handlers.get("session_shutdown")?.({}, {});
  });

  it("says so when the command arrives with nothing running in the foreground", async () => {
    const { handlers, commands } = load();
    const notes: string[] = [];
    await commands.get("toriel-background")?.("", { ui: { notify: (m: string) => notes.push(m) } });
    assert.deepEqual(notes, ["No command is running in the foreground."]);
    handlers.get("session_shutdown")?.({}, {});
  });

  it("says what stayed in the foreground, and not 'nothing running', when the limit refuses the move", async () => {
    const { tools, handlers, commands } = load();
    const ctx = { cwd: tmpdir(), sessionManager: { getSessionId: () => "s1", getSessionFile: () => undefined } };
    for (let i = 0; i < 5; i++) {
      await tools.get("bash")?.execute(`b${i}`, { command: "sleep 30", run_in_background: true }, undefined, undefined, ctx);
    }
    const call = tools.get("bash")?.execute("c1", { command: "sleep 0.4; echo fg-done" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 100));
    const notes: string[] = [];
    await commands.get("toriel-background")?.("", { ui: { notify: (m: string) => notes.push(m) } });
    assert.deepEqual(notes, ["1 stayed in the foreground: already 5 background jobs."]);
    assert.match((await call)?.content[0]?.text ?? "", /fg-done/);
    handlers.get("session_shutdown")?.({}, {});
  });

  it("reports a foreground failure as pi does: output plus the exit code, as an error", async () => {
    const { tools, handlers } = load();
    const ctx = { cwd: tmpdir(), sessionManager: { getSessionId: () => "s1", getSessionFile: () => undefined } };
    const result = await tools.get("bash")?.execute("c1", { command: "echo oops; exit 3" }, undefined, undefined, ctx);
    assert.equal(result?.isError, true);
    assert.match(result?.content[0]?.text ?? "", /oops\s+Command exited with code 3/);
    handlers.get("session_shutdown")?.({}, {});
  });

  it("still runs an ordinary command synchronously through pi's own bash", async () => {
    const { tools } = load();
    const ctx = { cwd: tmpdir(), sessionManager: { getSessionId: () => "s1", getSessionFile: () => undefined } };
    const result = await tools.get("bash")?.execute("c1", { command: "echo sync-ok" }, undefined, undefined, ctx);
    assert.match(result?.content[0]?.text ?? "", /sync-ok/);
  });
});
