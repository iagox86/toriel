// The pinned pi still behaves the way toriel assumes (ticket 75). These run the real pi in toriel's node_modules, with no model and no
// network and an empty config directory, so they are what a pi bump (`toriel update pi`) runs into first: a change that breaks one of
// toriel's assumptions fails here, in one place, instead of as a live bug.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createEditToolDefinition } from "@earendil-works/pi-coding-agent";
import { DEFAULT_PI_CLI } from "../src/config.ts";
import { EDIT_SCHEMA } from "../pi/extensions/toriel-files.ts";

const ROOT = join(import.meta.dirname, "..");
const agentDir = mkdtempSync(join(tmpdir(), "pi-smoke-"));
const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };

function pi(args: string[]): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [DEFAULT_PI_CLI, ...args], { env, encoding: "utf8", timeout: 30_000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("the pinned pi", () => {
  it("is the version package.json pins", () => {
    const pinned = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { dependencies: Record<string, string> }).dependencies["@earendil-works/pi-coding-agent"];
    assert.equal(pi(["--version"]).out.trim(), pinned);
  });

  it("refuses a --tools list that mixes bare names with +name (profileArgs relies on it never being built)", () => {
    const r = pi(["--tools", "read,+grep", "--no-extensions", "-p", "hi"]);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /tool names cannot be mixed with \+name or -name entries/);
  });

  it("loads the bundled permission package by -e under --no-extensions (it is the gate every session needs)", async () => {
    const reply = await rpc("get_commands", ["-e", join(ROOT, "node_modules", "@gotgenes", "pi-permission-system")]);
    const names = ((reply.data as { commands: Array<{ name: string }> }).commands ?? []).map((c) => c.name);
    assert.ok(names.includes("permission-system"), `the package's command is registered (got ${names.join(", ")})`);
  });

  it("lets an extension replace the built-in edit tool under the same name (toriel-files adds replaceAll that way)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-smoke-edit-"));
    const dump = join(dir, "tools.json");
    const probe = join(dir, "probe.ts");
    writeFileSync(probe, `import { writeFileSync } from "node:fs";\nexport default function (pi: any) {\n  pi.on("session_start", () => writeFileSync(${JSON.stringify(dump)}, JSON.stringify(pi.getAllTools().map((t: any) => ({ name: t.name, replaceAll: Boolean(t.parameters?.properties?.edits?.items?.properties?.replaceAll) })))));\n}\n`);
    await rpc("get_state", ["-e", join(ROOT, "pi", "extensions", "toriel-files.ts"), "-e", probe], { TORIEL_CHILD: "1" });
    await new Promise((r) => setTimeout(r, 300));
    const tools = JSON.parse(readFileSync(dump, "utf8")) as Array<{ name: string; replaceAll: boolean }>;
    assert.equal(tools.filter((t) => t.name === "edit").length, 1, "one edit tool, not two");
    assert.equal(tools.find((t) => t.name === "edit")?.replaceAll, true, "and it is the extension's");
  });

  it("has an edit schema that toriel-files' override still matches apart from replaceAll (ticket 241)", () => {
    // pi's schema is a typebox object: round-trip it to plain JSON for comparison
    interface EditSchema {
      properties: { edits: { items: { required: string[]; properties: Record<string, { type?: string; description?: string }> } } };
    }
    const theirs = JSON.parse(JSON.stringify(createEditToolDefinition(process.cwd()).parameters)) as EditSchema;
    const ours = JSON.parse(JSON.stringify(EDIT_SCHEMA)) as EditSchema;
    const item = (schema: EditSchema) => schema.properties.edits.items;
    const hint = "Update EDIT_SCHEMA in pi/extensions/toriel-files.ts to pi's current edit parameters (keeping replaceAll), and check pi's edit.js for behavior changes the override would shadow.";

    // replaceAll is the one addition; it must be optional, a boolean, and nothing else may differ in what is required
    assert.equal(item(ours).properties.replaceAll?.type, "boolean", "replaceAll is a boolean");
    assert.ok(!item(ours).required.includes("replaceAll"), "and optional");
    const withoutAddition = structuredClone(ours);
    delete item(withoutAddition).properties.replaceAll;

    // the oldText description is ours with a clause about replaceAll appended: it must still START with pi's sentence
    const theirOld = item(theirs).properties.oldText?.description ?? "";
    const ourOld = item(withoutAddition).properties.oldText?.description ?? "";
    assert.ok(ourOld.startsWith(theirOld.replace(/\.$/, "")), `oldText description drifted from pi's: ${theirOld}\n${hint}`);
    (item(withoutAddition).properties.oldText ?? {}).description = theirOld;

    assert.deepEqual(withoutAddition, theirs, `the edit schema differs from pi's built-in.\n${hint}`);
  });

  it("answers a get_state request over RPC (the daemon's handshake with every child)", async () => {
    const reply = await rpc("get_state");
    assert.equal(reply.success, true);
    assert.equal(reply.command, "get_state");
    assert.equal(typeof (reply.data as Record<string, unknown>).sessionId, "string", "the controller keys a session by the sessionId in get_state");
  });
});

/** One RPC request to a fresh pi (no model, no network, an empty config directory) and its reply. */
async function rpc(command: string, extra: string[] = [], moreEnv: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const child = spawn(process.execPath, [DEFAULT_PI_CLI, "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--offline", ...extra], { env: { ...env, ...moreEnv }, stdio: ["pipe", "pipe", "pipe"] });
  try {
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`pi did not answer ${command} in 20s`)), 20_000);
      let buf = "";
      child.stdout.on("data", (d: Buffer) => {
        buf += d.toString();
        for (const line of buf.split("\n")) {
          try {
            const msg = JSON.parse(line) as Record<string, unknown>;
            if (msg.type === "response" && msg.id === "smoke") {
              clearTimeout(timer);
              resolve(msg);
            }
          } catch {
            // a partial or non-JSON line
          }
        }
      });
      child.on("error", reject);
      child.stdin.write(`${JSON.stringify({ type: command, id: "smoke" })}\n`);
    });
  } finally {
    child.kill();
  }
}

describe("the pinned pi runs a session for a stub endpoint", () => {
  // A local openai-completions endpoint whose replies script a todo_write, three reads and then text, so the real pi runs a
  // run with tool calls and no network. The task extension is loaded with it (it needs TORIEL_CHILD), and a probe records the
  // extension events to a file by poll, since the extension's reminders (ticket 250) assume pi's event behavior exactly:
  // before_agent_start once per user prompt, agent_start also for a continued turn, agent_before_settle honoring continue.
  const dumpFile = () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-smoke-tasks-"));
    const dump = join(dir, "events.txt");
    // runs second (alphabetical vs pi/extensions/toriel-tasks.ts), after the task extension's own boundary handler
    const probe = join(dir, "zz-probe.ts");
    writeFileSync(probe, [
      "import { writeFileSync } from \"node:fs\";",
      `const dump = ${JSON.stringify(dump)};`,
      "const lines: string[] = [];",
      "function record(line: string): void {",
      "  lines.push(line);",
      "  writeFileSync(dump, lines.join(\"\\n\"));",
      "}",
      "export default function (pi: any) {",
      "  pi.on(\"before_agent_start\", () => record(\"before_agent_start\"));",
      "  pi.on(\"agent_start\", () => record(\"agent_start\"));",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the probe's own template literal, which is a string here
      "  pi.on(\"tool_result\", (e: any) => record(`tool_result:${e?.toolName}`));",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the probe's own template literal, which is a string here
      "  pi.on(\"agent_before_settle\", (e: any) => record(`settle outcome=${e?.outcome} entries=${e?.entries?.length} cont=${e?.continue}`));",
      "  pi.on(\"agent_settled\", () => record(\"settled\"));",
      "}",
    ].join("\n"));
    return { dir, probe, dump };
  };

  it("fires before_agent_start, agent_start, tool_result and agent_before_settle; a continue buys one turn with agent_start again", async () => {
    const files = dumpFile();
    const sse = (payload: object) => `data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", model: "stub", choices: [payload] })}\n\n`;
    const toolCall = (name: string, argObj: object) => [
      sse({ index: 0, delta: { role: "assistant" }, finish_reason: null }),
      sse({ index: 0, delta: { tool_calls: [{ index: 0, id: "call-stub", type: "function", function: { name, arguments: "" } }] }, finish_reason: null }),
      sse({ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(argObj) } }] }, finish_reason: null }),
      sse({ index: 0, delta: {}, finish_reason: "tool_calls" }),
      "data: [DONE]\n\n",
    ].join("");
    const text = (content: string) => [
      sse({ index: 0, delta: { role: "assistant" }, finish_reason: null }),
      sse({ index: 0, delta: { content }, finish_reason: null }),
      sse({ index: 0, delta: {}, finish_reason: "stop" }),
      "data: [DONE]\n\n",
    ].join("");
    // todo_write, three reads, text: the turn count the nudge needs (END_OF_RUN_CALLS) is already past when pi settles
    const replies = [
      toolCall("todo_write", { todos: [{ content: "a", status: "in_progress" }] }),
      toolCall("read", { path: `${files.dir}/missing-1` }),
      toolCall("read", { path: `${files.dir}/missing-2` }),
      toolCall("read", { path: `${files.dir}/missing-3` }),
      text("All work is done."),
    ];
    let hits = 0;
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        if (req.method === "GET") {
          res.writeHead(200).end(JSON.stringify({ data: [{ id: "stub" }] }));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(replies[hits++] ?? text("unexpected: no reply scripted"));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as import("node:net").AddressInfo).port;
    const readDump = (): string => {
      try {
        return readFileSync(files.dump, "utf8");
      } catch {
        return ""; // not written yet
      }
    };
    writeFileSync(join(files.dir, "models.json"), JSON.stringify({ providers: { stub: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "stub-key", models: [{ id: "stub", contextWindow: 64000, maxTokens: 8000 }] } } }));
    const child = spawn(process.execPath, [DEFAULT_PI_CLI, "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--offline", "-e", join(ROOT, "pi", "extensions", "toriel-tasks.ts"), "-e", files.probe, "--provider", "stub", "--model", "stub"], { cwd: ROOT, env: { ...env, TORIEL_CHILD: "1", PI_CODING_AGENT_DIR: files.dir }, stdio: ["pipe", "pipe", "pipe"] });
        try {
      await new Promise((r) => setTimeout(r, 400));
      child.stdin.write(`${JSON.stringify({ type: "prompt", id: "smoke", message: "Work through the list, then report." })}\n`);
      // the events dump is the result: settle detection is a bounded poll over real streaming (never a fixed wait)
      const deadline = Date.now() + 30_000;
      while (!readDump().includes("settled")) {
        if (Date.now() > deadline) {
          throw new Error(`the run did not settle in 30s; events: ${readDump()}`);
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      const events = readDump().split("\n").filter((l) => l.length > 0);
      assert.equal(events.filter((e) => e === "before_agent_start").length, 1, `before_agent_start fires once per user prompt; got: ${events.join(" | ")}`);
      assert.equal(events.filter((e) => e === "agent_start").length, 2, "agent_start for the prompt and again for the turn the nudge's continue bought");
      assert.equal(events.filter((e) => e === "tool_result:todo_write").length, 1);
      assert.equal(events.filter((e) => e === "tool_result:read").length, 3);
      assert.equal(events.filter((e) => e.startsWith("settle outcome=completed")).length, 2, "two settle boundaries: the nudge's and the settled run's");
      assert.equal(events[0], "before_agent_start");
      assert.match(events[6], /^settle outcome=completed entries=1 cont=true/, "the nudge's boundary asks for one more turn");
      assert.equal(events[7], "agent_start", "pi re-emits agent_start for the continued turn (the loop trigger the wiring guards against)");
      assert.match(events[8], /^settle outcome=completed entries=0 cont=false/, "and the next settle stays silent, once per run");
      assert.equal(events[9], "settled", "the run then ends");
      assert.equal(hits, 6, "todo_write, three reads, the model's own text turn, then exactly one continued turn - no loop");
    } finally {
      child.kill("SIGKILL");
      server.close();
    }
  });
});
