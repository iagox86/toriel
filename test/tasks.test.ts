import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { counts, describeTodos, listing, MAX_TODOS, parseReport, parseTodos, reconstructTodos, STALE_AFTER_MS, STATUS_KEY, staleNote, stripLines, TOOL_NAME, type Todo } from "../pi/extensions/lib/tasks.ts";
import tasksExtension from "../pi/extensions/toriel-tasks.ts";

const t = (content: string, status: Todo["status"] = "pending", activeForm?: string): Todo => ({ content, status, ...(activeForm ? { activeForm } : {}) });

describe("parseTodos", () => {
  it("accepts a list and trims it", () => {
    const r = parseTodos([{ content: "  Run the tests ", status: "in_progress", activeForm: " Running the tests " }, { content: "Ship", status: "pending" }]);
    assert.deepEqual(r, { ok: true, todos: [t("Run the tests", "in_progress", "Running the tests"), t("Ship")] });
  });

  it("says what is wrong, so the agent can send it again", () => {
    assert.match((parseTodos("nope") as { error: string }).error, /must be an array/);
    assert.match((parseTodos([{ content: "", status: "pending" }]) as { error: string }).error, /task 1 has no content/);
    assert.match((parseTodos([{ content: "a", status: "pending" }, { content: "b", status: "doing" }]) as { error: string }).error, /task 2 \("b"\) needs a status of pending, in_progress or completed/);
    assert.match((parseTodos(Array.from({ length: MAX_TODOS + 1 }, (_, i) => t(`t${i}`))) as { error: string }).error, /at most 50/);
  });

  it("takes an empty list: it clears", () => {
    assert.deepEqual(parseTodos([]), { ok: true, todos: [] });
  });
});

describe("describeTodos", () => {
  it("numbers the list and counts what is done", () => {
    const text = describeTodos([t("a", "completed"), t("b", "in_progress"), t("c")]);
    assert.match(text, /^Task list updated: 1 of 3 done\./);
    assert.match(text, /2\. \[in_progress\] b/);
  });

  it("nudges when the shape is off, and only then", () => {
    assert.match(describeTodos([t("a", "in_progress"), t("b", "in_progress")]), /More than one task is in_progress/);
    assert.match(describeTodos([t("a", "completed"), t("b")]), /No task is in_progress/);
    assert.doesNotMatch(describeTodos([t("a", "completed"), t("b", "in_progress")]), /in_progress:|More than one|No task/);
    assert.doesNotMatch(describeTodos([t("a", "completed")]), /No task is in_progress/, "all done is fine");
    assert.equal(describeTodos([]), "The task list is empty.");
  });
});

describe("reconstructTodos", () => {
  const result = (todos: unknown, toolName = TOOL_NAME) => ({ type: "message", message: { role: "toolResult", toolName, details: { todos } } });

  it("is the list of the last todo_write result in the branch", () => {
    const branch = [result([t("first")]), { type: "message", message: { role: "assistant" } }, result([t("second", "in_progress")])];
    assert.deepEqual(reconstructTodos(branch), [t("second", "in_progress")]);
  });

  it("ignores other tools, other entries and a malformed result; no result is an empty list", () => {
    assert.deepEqual(reconstructTodos([result([t("x")], "bash"), { type: "compaction" }]), []);
    assert.deepEqual(reconstructTodos([result([t("kept")]), result("garbage")]), [t("kept")]);
    assert.deepEqual(reconstructTodos([]), []);
  });

  it("follows a rewind: a branch cut before a call has the list from before it", () => {
    const full = [result([t("one")]), result([t("one", "completed"), t("two")])];
    assert.deepEqual(reconstructTodos(full.slice(0, 1)), [t("one")]);
  });
});

describe("the status record", () => {
  it("is read back, and anything else is not ours", () => {
    assert.deepEqual(parseReport(JSON.stringify({ v: 1, todos: [t("a")] })), [t("a")]);
    assert.equal(parseReport(JSON.stringify({ v: 2, todos: [] })), undefined);
    assert.equal(parseReport("not json"), undefined);
    assert.equal(parseReport(JSON.stringify({ v: 1, todos: [{ content: "", status: "pending" }] })), undefined);
  });
});

describe("stripLines", () => {
  it("is nothing for no tasks, and the header alone when everything is done", () => {
    assert.deepEqual(stripLines([]), []);
    assert.deepEqual(stripLines([t("a", "completed"), t("b", "completed")]), ["tasks 2/2 done"]);
  });

  it("counts the finished, shows the one under way by its active form, then what is next", () => {
    assert.deepEqual(stripLines([t("a", "completed"), t("Write tests", "in_progress", "Writing tests"), t("Ship")]), ["tasks 1/3 done", "▸ Writing tests", "○ Ship"]);
  });

  it("keeps to its height and says how many more there are", () => {
    const lines = stripLines([t("a", "in_progress"), ...["b", "c", "d", "e", "f", "g"].map((x) => t(x))], 5);
    assert.equal(lines.length, 5);
    assert.equal(lines[0], "tasks 0/7 done");
    assert.match(lines[4] ?? "", /\+4 more/);
  });
});

describe("a stale list (ticket 251)", () => {
  const open = [t("a", "in_progress"), t("b")];

  it("says nothing until five minutes of work have passed, then how long", () => {
    assert.equal(staleNote(0), "");
    assert.equal(staleNote(STALE_AFTER_MS - 1), "");
    assert.equal(staleNote(STALE_AFTER_MS), "not updated 5m");
    assert.equal(staleNote(12 * 60_000 + 30_000), "not updated 12m");
    assert.equal(staleNote(65 * 60_000), "not updated 1h05m");
  });

  it("puts it in the strip's header, and leaves a fresh or finished list alone", () => {
    assert.equal(stripLines(open, 6, 12 * 60_000)[0], "tasks 0/2 done - not updated 12m");
    assert.equal(stripLines(open, 6, 1000)[0], "tasks 0/2 done");
    assert.deepEqual(stripLines([t("a", "completed")], 6, 99 * 60_000), ["tasks 1/1 done"]);
  });

  it("puts it in /tasks too", () => {
    assert.equal(listing(open, 7 * 60_000)[0], "Tasks: 0 of 2 done - not updated 7m");
    assert.equal(listing(open)[0], "Tasks: 0 of 2 done");
  });
});

describe("listing", () => {
  it("marks each task and counts", () => {
    assert.deepEqual(listing([t("a", "completed"), t("b", "in_progress"), t("c")]), ["Tasks: 1 of 3 done", "", "✓ a", "▸ b", "○ c"]);
    assert.match(listing([])[0] ?? "", /No tasks/);
  });
});

describe("toriel-tasks extension", () => {
  const saved = process.env.TORIEL_CHILD;
  afterEach(() => {
    if (saved === undefined) {
      delete process.env.TORIEL_CHILD;
    } else {
      process.env.TORIEL_CHILD = saved;
    }
  });

  type Handler = (event: unknown, ctx: unknown) => void;
  function load(branch: unknown[] = []) {
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
    const statuses: Array<string | undefined> = [];
    const ctx = { sessionManager: { getBranch: () => branch }, ui: { setStatus: (key: string, text: string | undefined) => statuses.push(key === STATUS_KEY ? text : "wrong key") } };
    return { handlers, tool, ctx, statuses };
  }

  it("does nothing outside a toriel child", () => {
    delete process.env.TORIEL_CHILD;
    let registered = false;
    tasksExtension({
      on: () => undefined,
      registerTool: () => {
        registered = true;
      },
    } as never);
    assert.equal(registered, false);
  });

  it("replaces the list, tells toriel, and answers with the list", async () => {
    const { tool, ctx, statuses } = load();
    const r = await tool.execute("c1", { todos: [{ content: "a", status: "in_progress" }, { content: "b", status: "pending" }] }, undefined, undefined, ctx);
    assert.match(r.content[0].text, /Task list updated: 0 of 2 done/);
    assert.deepEqual(r.details.todos, [t("a", "in_progress"), t("b")]);
    assert.deepEqual(JSON.parse(statuses.at(-1) as string), { v: 1, todos: [t("a", "in_progress"), t("b")] });
  });

  it("leaves the list alone when the call is wrong, and says why", async () => {
    const { tool, ctx, statuses } = load();
    const r = await tool.execute("c1", { todos: [{ content: "a", status: "later" }] }, undefined, undefined, ctx);
    assert.match(r.content[0].text, /The task list was not changed: task 1 \("a"\) needs a status/);
    assert.equal(statuses.length, 0, "toriel was told nothing");
  });

  it("reports the branch's list when a session starts or the tree changes, and an empty one when there is none", () => {
    const branch = [{ type: "message", message: { role: "toolResult", toolName: TOOL_NAME, details: { todos: [t("kept", "in_progress")] } } }];
    const first = load(branch);
    first.handlers.get("session_start")?.({}, first.ctx);
    assert.deepEqual(JSON.parse(first.statuses[0] as string).todos, [t("kept", "in_progress")]);
    const bare = load([]);
    bare.handlers.get("session_tree")?.({}, bare.ctx);
    assert.deepEqual(JSON.parse(bare.statuses[0] as string).todos, []);
  });

  it("counts match what it reports", () => {
    assert.deepEqual(counts([t("a", "completed"), t("b", "in_progress"), t("c")]), { done: 1, active: 1, total: 3 });
  });
});
