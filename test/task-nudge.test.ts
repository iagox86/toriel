// Reminders to keep the task list current (ticket 250).
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import tasksExtension from "../pi/extensions/toriel-tasks.ts";
import { END_OF_RUN_CALLS, MID_RUN_CALLS, reminderText, TaskNudges } from "../pi/extensions/lib/task-nudge.ts";
import type { Todo } from "../pi/extensions/lib/tasks.ts";

const t = (content: string, status: Todo["status"] = "pending"): Todo => ({ content, status });
const OPEN: Todo[] = [{ content: "Read the diff", status: "in_progress", activeForm: "Reading the diff" }, t("Run gates"), t("Review")];
const calls = (n: TaskNudges, count: number, tool = "bash"): Array<string | undefined> => Array.from({ length: count }, () => n.afterToolCall(tool));

describe("reminderText", () => {
  it("names the task in progress and what is still open", () => {
    const text = reminderText(OPEN);
    assert.match(text, /0 of 3 done/);
    assert.match(text, /"Reading the diff" in progress, 2 more open/);
    assert.match(text, /todo_write/);
  });

  it("says how many are open when none is in progress", () => {
    assert.match(reminderText([t("a", "completed"), t("b"), t("c")]), /1 of 3 done\) still shows 2 open/);
  });
});

describe("TaskNudges mid-run", () => {
  it("reminds on the Nth tool call without a todo_write, and then only every N calls", () => {
    const n = new TaskNudges();
    n.setList(OPEN);
    const out = calls(n, MID_RUN_CALLS * 2 + 1);
    const at = out.flatMap((r, i) => (r === undefined ? [] : [i + 1]));
    assert.deepEqual(at, [MID_RUN_CALLS, MID_RUN_CALLS * 2]);
  });

  it("starts counting again whenever the list is written", () => {
    const n = new TaskNudges();
    n.setList(OPEN);
    calls(n, MID_RUN_CALLS - 1);
    n.setList(OPEN); // todo_write
    assert.deepEqual(calls(n, MID_RUN_CALLS - 1).filter(Boolean), []);
    assert.ok(n.afterToolCall("bash"), "the full count after the write reminds");
  });

  it("never nags about an empty or finished list", () => {
    const n = new TaskNudges();
    assert.deepEqual(calls(n, MID_RUN_CALLS * 2).filter(Boolean), []);
    n.setList([t("a", "completed"), t("b", "completed")]);
    assert.deepEqual(calls(n, MID_RUN_CALLS * 2).filter(Boolean), []);
  });

  it("does not count todo_write itself", () => {
    const n = new TaskNudges();
    n.setList(OPEN);
    for (let i = 0; i < MID_RUN_CALLS * 2; i++) {
      assert.equal(n.afterToolCall("todo_write"), undefined);
    }
  });
});

describe("TaskNudges at the end of a run", () => {
  it("asks for one more turn when the model did real work since it last wrote the list, once per run", () => {
    const n = new TaskNudges();
    n.setList(OPEN);
    calls(n, END_OF_RUN_CALLS);
    assert.match(n.beforeRunEnds(false) ?? "", /Reminder: your task list/);
    assert.equal(n.beforeRunEnds(false), undefined, "the second time the run ends, it ends");
    n.runStarted();
    assert.ok(n.beforeRunEnds(false), "a new run gets its own allowance");
  });

  it("leaves a run alone that did little, was aborted, or has nothing open", () => {
    const n = new TaskNudges();
    n.setList(OPEN);
    calls(n, END_OF_RUN_CALLS - 1);
    assert.equal(n.beforeRunEnds(false), undefined, "a plan followed by a call or two is not a forgotten list");
    calls(n, 5);
    assert.equal(n.beforeRunEnds(true), undefined, "esc ends it");
    n.setList([t("a", "completed")]);
    calls(n, 5);
    assert.equal(n.beforeRunEnds(false), undefined);
  });

  it("is quiet after the model updated the list during the run", () => {
    const n = new TaskNudges();
    n.setList(OPEN);
    calls(n, 10);
    n.setList([t("a", "completed"), t("b", "in_progress")]); // todo_write, still open
    calls(n, END_OF_RUN_CALLS - 1);
    assert.equal(n.beforeRunEnds(false), undefined);
  });
});

describe("toriel-tasks extension reminders", () => {
  const saved = process.env.TORIEL_CHILD;
  afterEach(() => {
    if (saved === undefined) {
      delete process.env.TORIEL_CHILD;
    } else {
      process.env.TORIEL_CHILD = saved;
    }
  });

  type Handler = (event: unknown, ctx: unknown) => unknown;
  function load() {
    process.env.TORIEL_CHILD = "1";
    const handlers = new Map<string, Handler>();
    // biome-ignore lint/suspicious/noExplicitAny: a stand-in for pi's tool registration
    let tool: any;
    tasksExtension({
      on: (event: string, h: Handler) => void handlers.set(event, h),
      registerTool: (def: unknown) => {
        tool = def;
      },
    } as never);
    const ctx = { sessionManager: { getBranch: () => [] }, ui: { setStatus: () => undefined } };
    const result = (toolName: string, text = "ok") => handlers.get("tool_result")?.({ toolName, content: [{ type: "text", text }] }, ctx) as { content: Array<{ text: string }> } | undefined;
    return { handlers, tool, ctx, result };
  }

  it("appends the reminder to a tool result after enough calls, keeping what the tool said", async () => {
    const { tool, ctx, result } = load();
    await tool.execute("c1", { todos: [{ content: "a", status: "in_progress" }, { content: "b", status: "pending" }] }, undefined, undefined, ctx);
    for (let i = 1; i < MID_RUN_CALLS; i++) {
      assert.equal(result("bash"), undefined);
    }
    const patched = result("bash", "the output");
    assert.equal(patched?.content[0]?.text, "the output");
    assert.match(patched?.content.at(-1)?.text ?? "", /Reminder: your task list \(0 of 2 done\)/);
  });

  it("asks for another turn before the run ends, as a hidden entry, once", async () => {
    const { handlers, tool, ctx, result } = load();
    await tool.execute("c1", { todos: [{ content: "a", status: "in_progress" }] }, undefined, undefined, ctx);
    handlers.get("agent_start")?.({}, ctx);
    for (let i = 0; i < END_OF_RUN_CALLS; i++) {
      result("bash");
    }
    const first = handlers.get("agent_before_settle")?.({ outcome: "completed" }, ctx) as { entries: Array<Record<string, unknown>>; continue: boolean } | undefined;
    assert.equal(first?.continue, true);
    assert.equal(first?.entries[0]?.type, "custom_message");
    assert.equal(first?.entries[0]?.display, false);
    assert.match(String(first?.entries[0]?.content), /todo_write/);
    assert.equal(handlers.get("agent_before_settle")?.({ outcome: "completed" }, ctx), undefined);
  });

  it("does nothing with no list, and never throws into pi", () => {
    const { handlers, result, ctx } = load();
    assert.equal(result("bash"), undefined);
    assert.equal(handlers.get("agent_before_settle")?.({ outcome: "completed" }, ctx), undefined);
    assert.equal(handlers.get("tool_result")?.(undefined, ctx), undefined);
    assert.equal(handlers.get("agent_before_settle")?.(undefined, ctx), undefined);
  });
});
