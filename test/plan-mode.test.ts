import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { APPROVE, approvalTitle, ENTER_TOOL, EXIT_TOOL, mcpServerOf, PLAN_DIR_ENV, PLAN_OFF_NOTE, PLAN_ON_NOTE, planFile, planOn, planVerdict, planWrap, REJECT, REVISE, setPlanOn, STATUS_KEY } from "../pi/extensions/lib/plan-mode.ts";
import planExtension, { readOnlyServers } from "../pi/extensions/toriel-plan.ts";
import { parseMcpYaml, piConfig } from "../pi/extensions/lib/mcp-config.ts";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-plan-test-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the marker file", () => {
  it("is on while the file exists, per session, and refuses an id that is not a plain name", () => {
    assert.equal(planOn(dir, "abc"), false);
    setPlanOn(dir, "abc", true);
    assert.equal(planOn(dir, "abc"), true);
    assert.equal(planOn(dir, "other"), false, "another session is not in plan mode");
    setPlanOn(dir, "abc", false);
    assert.equal(planOn(dir, "abc"), false);
    assert.equal(planFile(dir, "../escape"), undefined);
    assert.equal(planFile(dir, "a/b"), undefined);
    assert.equal(planFile(undefined, "abc"), undefined);
    assert.equal(planOn(undefined, "abc"), false, "no directory, no mode");
    assert.throws(() => setPlanOn(dir, "../x", true), /nowhere to keep its state/);
  });

  it("makes the directory private and does not mind switching off twice", () => {
    const nested = path.join(dir, "deeper");
    setPlanOn(nested, "abc", true);
    assert.equal(fs.statSync(nested).mode & 0o777, 0o700);
    setPlanOn(nested, "abc", false);
    setPlanOn(nested, "abc", false);
  });
});

describe("planVerdict", () => {
  it("lets the read-only tools and the way out through", () => {
    for (const tool of ["read", "grep", "find", "ls", "bash", "codemode", "web_search", "todo_write", "ask_user_question", ENTER_TOOL, EXIT_TOOL]) {
      assert.equal(planVerdict(tool), undefined, tool);
    }
  });

  it("refuses the tools that change files, and says what to do instead", () => {
    const why = planVerdict("write") ?? "";
    assert.match(why, /Plan mode is on, so write is not available \(the write tool changes files\)/);
    assert.match(why, new RegExp(EXIT_TOOL));
    assert.match(planVerdict("edit") ?? "", /edit tool changes files/);
  });

  it("refuses what it does not know, including the tools that start other agents and schedule things", () => {
    for (const tool of ["toriel_agent", "toriel_message", "toriel_schedule_create", "toriel_watch_create", "some_memory_save"]) {
      assert.match(planVerdict(tool) ?? "", /may change something/, tool);
    }
  });

  it("lets an MCP tool through only when its server is marked readOnly", () => {
    assert.equal(mcpServerOf("mcp__git__git_diff"), "git");
    assert.equal(mcpServerOf("mcp__some_server__do__thing"), "some_server");
    assert.equal(mcpServerOf("bash"), undefined);
    assert.match(planVerdict("mcp__vikunja__tasks_update") ?? "", /"vikunja" MCP server is not marked readOnly in mcp\.yaml/);
    assert.equal(planVerdict("mcp__git__git_diff", new Set(["git"])), undefined);
    assert.match(planVerdict("mcp__vikunja__tasks_update", new Set(["git"])) ?? "", /vikunja/);
  });
});

describe("planWrap", () => {
  it("runs the command with nothing writable: a read-only root and no other bind", () => {
    const spec = planWrap("echo hi", "/work", undefined, () => false, () => false);
    assert.equal(spec.file, "bwrap");
    const args = spec.args;
    assert.deepEqual(args.slice(0, 3), ["--ro-bind", "/", "/"]);
    assert.equal(args.includes("--bind"), false, "there is nothing to write to");
    assert.deepEqual(args.slice(-3), ["bash", "-c", "echo hi"]);
    assert.equal(args[args.indexOf("--chdir") + 1], "/work");
    assert.match(spec.failure ?? "", /plan mode runs commands read-only through bubblewrap/);
  });

  it("empties the socket directories and hides the daemon's socket", () => {
    const sock = path.join(dir, "toriel.sock");
    fs.writeFileSync(sock, "");
    const spec = planWrap("true", "/work", sock, () => true, fs.existsSync);
    assert.ok(spec.args.join(" ").includes("--tmpfs /run/user"));
    assert.ok(spec.args.join(" ").includes(`--ro-bind /dev/null ${sock}`));
  });

  const haveBwrap = spawnSync("bwrap", ["--ro-bind", "/", "/", "true"]).status === 0;
  it("really stops a write and still lets a read through (bubblewrap)", { skip: !haveBwrap && "bubblewrap cannot run here" }, () => {
    // not under /tmp: the sandbox's /tmp is its own, so a directory there does not exist inside it
    const here = fs.mkdtempSync(path.join(process.cwd(), ".plan-test-"));
    try {
      const target = path.join(here, "made");
      const write = planWrap(`touch ${target}`, here);
      const failed = spawnSync(write.file, write.args, { encoding: "utf8" });
      assert.notEqual(failed.status, 0);
      assert.equal(fs.existsSync(target), false, "the file was not made");
      assert.match(failed.stderr, /Read-only file system/);
      const read = planWrap("ls /usr >/dev/null && echo fine", here);
      const ok = spawnSync(read.file, read.args, { encoding: "utf8" });
      assert.equal(ok.stdout.trim(), "fine");
    } finally {
      fs.rmSync(here, { recursive: true, force: true });
    }
  });
});

describe("approvalTitle", () => {
  it("leads with the question, then the plan, and caps a runaway plan", () => {
    assert.match(approvalTitle("1. do it"), /^Plan mode: approve this plan\?\n\n1\. do it$/);
    assert.match(approvalTitle("x".repeat(5000)), /the plan is 5000 characters/);
  });
});

describe("mcp.yaml readOnly", () => {
  it("is a toriel key: accepted, checked, and never passed on to pi", () => {
    const { servers, problems } = parseMcpYaml("servers:\n  git:\n    command: toriel-git-mcp\n    readOnly: true\n  other:\n    command: x\n    readOnly: maybe\n");
    assert.equal(servers.git?.readOnly, true);
    assert.equal(servers.other, undefined);
    assert.match(problems.join("\n"), /"other": readOnly must be true or false/);
    assert.equal("readOnly" in piConfig(servers.git as never), false);
  });

  it("is read from the file named in the environment, at the moment of the call", () => {
    const file = path.join(dir, "mcp.yaml");
    assert.deepEqual([...readOnlyServers(undefined)], []);
    assert.deepEqual([...readOnlyServers(file)], [], "no file");
    fs.writeFileSync(file, "servers:\n  git:\n    command: g\n    readOnly: true\n  vikunja:\n    command: v\n");
    assert.deepEqual([...readOnlyServers(file)], ["git"]);
  });
});

describe("toriel-plan extension", () => {
  const saved = { child: process.env.TORIEL_CHILD, dir: process.env[PLAN_DIR_ENV], id: process.env.TORIEL_SESSION_ID };
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  };
  afterEach(() => {
    restore("TORIEL_CHILD", saved.child);
    restore(PLAN_DIR_ENV, saved.dir);
    restore("TORIEL_SESSION_ID", saved.id);
  });

  type Block = { block: true; reason: string } | undefined;
  function load(answers: { select?: string; input?: string; hasUI?: boolean } = {}) {
    process.env.TORIEL_CHILD = "1";
    process.env[PLAN_DIR_ENV] = dir;
    process.env.TORIEL_SESSION_ID = "sess-1";
    // biome-ignore lint/suspicious/noExplicitAny: stand-ins for pi's registration calls
    const handlers: Record<string, (...a: any[]) => any> = {};
    // biome-ignore lint/suspicious/noExplicitAny: the same
    const tools: Record<string, any> = {};
    planExtension({
      on: (event: string, h: never) => {
        handlers[event] = h;
      },
      registerTool: (def: { name: string }) => {
        tools[def.name] = def;
      },
    } as never);
    const statuses: Array<{ on: boolean }> = [];
    const asked: string[] = [];
    const ctx = {
      hasUI: answers.hasUI ?? true,
      ui: {
        setStatus: (key: string, text: string) => {
          assert.equal(key, STATUS_KEY);
          statuses.push(JSON.parse(text));
        },
        select: async (title: string) => {
          asked.push(title);
          return answers.select;
        },
        input: async () => answers.input,
      },
    };
    return { handlers, tools, ctx, statuses, asked };
  }

  it("does nothing outside a toriel child, or without a directory", () => {
    delete process.env.TORIEL_CHILD;
    let n = 0;
    planExtension({ on: () => void n++, registerTool: () => void n++ } as never);
    assert.equal(n, 0);
    process.env.TORIEL_CHILD = "1";
    delete process.env[PLAN_DIR_ENV];
    planExtension({ on: () => void n++, registerTool: () => void n++ } as never);
    assert.equal(n, 0);
  });

  it("blocks write and edit only while the mode is on, and reads the marker at each call", () => {
    const { handlers, ctx } = load();
    const call = (toolName: string): Block => handlers.tool_call({ toolName }, ctx);
    assert.equal(call("write"), undefined, "off: nothing is blocked");
    setPlanOn(dir, "sess-1", true);
    assert.match(call("write")?.reason ?? "", /Plan mode is on/);
    assert.equal(call("read"), undefined);
    setPlanOn(dir, "sess-1", false);
    assert.equal(call("write"), undefined, "off again, with nothing to restart");
  });

  it("lets an MCP tool of a readOnly server through", () => {
    const file = path.join(dir, "mcp.yaml");
    fs.writeFileSync(file, "servers:\n  git:\n    command: g\n    readOnly: true\n");
    const savedFile = process.env.TORIEL_MCP_FILE;
    process.env.TORIEL_MCP_FILE = file;
    try {
      const { handlers, ctx } = load();
      setPlanOn(dir, "sess-1", true);
      assert.equal(handlers.tool_call({ toolName: "mcp__git__git_log" }, ctx), undefined);
      assert.match(handlers.tool_call({ toolName: "mcp__other__thing" }, ctx)?.reason ?? "", /not marked readOnly/);
    } finally {
      restore("TORIEL_MCP_FILE", savedFile);
    }
  });

  it("tells the agent the mode with a user prompt, and once when it has ended, never with a background notice", () => {
    const { handlers, ctx } = load();
    const note = (messageType = "user") => handlers.before_agent_start({ messageType }, ctx)?.message?.content;
    assert.equal(note(), undefined, "off, never on: nothing to say");
    setPlanOn(dir, "sess-1", true);
    assert.equal(note("custom"), undefined, "a background notice");
    assert.equal(note(), PLAN_ON_NOTE);
    setPlanOn(dir, "sess-1", false);
    assert.equal(note(), PLAN_OFF_NOTE);
    assert.equal(note(), undefined, "told once");
  });

  it("reports the state when a session starts", () => {
    const { handlers, ctx, statuses } = load();
    handlers.session_start({}, ctx);
    setPlanOn(dir, "sess-1", true);
    handlers.session_start({}, ctx);
    assert.deepEqual(statuses, [{ v: 1, on: false }, { v: 1, on: true }]);
  });

  it("enter_plan_mode turns it on and says so to toriel", async () => {
    const { tools, ctx, statuses } = load();
    const r = await tools[ENTER_TOOL].execute("c", {}, undefined, undefined, ctx);
    assert.equal(planOn(dir, "sess-1"), true);
    assert.match(r.content[0].text, /PLAN MODE ACTIVE/);
    assert.deepEqual(statuses, [{ v: 1, on: true }]);
    assert.match((await tools[ENTER_TOOL].execute("c", {}, undefined, undefined, ctx)).content[0].text, /already on/);
  });

  it("exit_plan_mode asks the user, and only an approval ends the mode", async () => {
    const approve = load({ select: APPROVE });
    setPlanOn(dir, "sess-1", true);
    const r = await approve.tools[EXIT_TOOL].execute("c", { plan: "1. change x\n2. test it" }, undefined, undefined, approve.ctx);
    assert.match(approve.asked[0] ?? "", /^Plan mode: approve this plan\?\n\n1\. change x/);
    assert.equal(planOn(dir, "sess-1"), false);
    assert.match(r.content[0].text, /approved the plan/);
    assert.deepEqual(approve.statuses, [{ v: 1, on: false }]);
    assert.equal(r.details.approved, true);
  });

  it("keeps the mode on for a request for changes (with the user's words), a rejection and a dialog nobody answered", async () => {
    for (const [answers, expect] of [
      [{ select: REVISE, input: "also cover the tests" }, /wants the plan changed: also cover the tests/],
      [{ select: REVISE, input: "" }, /did not say how/],
      [{ select: REJECT }, /did not approve/],
      [{ select: undefined }, /did not approve.*nobody answered/],
    ] as const) {
      const { tools, ctx, statuses } = load(answers);
      setPlanOn(dir, "sess-1", true);
      const r = await tools[EXIT_TOOL].execute("c", { plan: "p" }, undefined, undefined, ctx);
      assert.match(r.content[0].text, expect);
      assert.equal(planOn(dir, "sess-1"), true, JSON.stringify(answers));
      assert.deepEqual(statuses, []);
    }
  });

  it("exit_plan_mode refuses an empty plan, does nothing when the mode is off, and stays on when there is no user", async () => {
    const { tools, ctx } = load({ select: APPROVE });
    assert.match((await tools[EXIT_TOOL].execute("c", { plan: "p" }, undefined, undefined, ctx)).content[0].text, /not on/);
    setPlanOn(dir, "sess-1", true);
    assert.match((await tools[EXIT_TOOL].execute("c", { plan: "  " }, undefined, undefined, ctx)).content[0].text, /plan was empty/);
    const headless = load({ hasUI: false });
    assert.match((await headless.tools[EXIT_TOOL].execute("c", { plan: "p" }, undefined, undefined, headless.ctx)).content[0].text, /no user to approve/);
    assert.equal(planOn(dir, "sess-1"), true);
  });
});
