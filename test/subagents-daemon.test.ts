import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { type Client, type Harness, type Msg, startDaemon } from "./helpers.ts";

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const isSettled = (m: Msg) => m.type === "event" && m.event?.type === "agent_settled";

/** Project agent profiles for the temp project the sessions run in. */
function writeAgents(h: Harness): void {
  const dir = path.join(h.dir, ".toriel", "agents");
  fs.mkdirSync(dir, { recursive: true });
  const agent = (name: string, extra = "") => fs.writeFileSync(path.join(dir, `${name}.md`), `---\nname: ${name}\ndescription: test agent ${name}\n${extra}---\nBe brief.\n`);
  agent("worker");
  agent("tiny", "budget: 25\n");
  agent("short", "maxTurns: 3\n");
}

/** A session that has answered once, so it has a UUID to spawn from. */
async function parentSession(h: Harness): Promise<{ c: Client; session: number; uuid: string }> {
  writeAgents(h);
  const c = await h.connect();
  const { sessionId } = await c.request({ type: "spawn", cwd: h.dir });
  await c.waitFor((m) => m.type === "history" && m.session === sessionId);
  await c.request({ type: "prompt", session: sessionId, message: "hi" });
  await c.waitFor(isSettled);
  for (let i = 0; i < 40; i++) {
    const uuid = c.sessions().find((s) => s.id === sessionId)?.sessionId as string | undefined;
    if (uuid) {
      return { c, session: sessionId, uuid };
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("the session never reported an id");
}

const spawn = (c: Client, from: string, over: Msg = {}) => c.request({ type: "agent_spawn", from, agent: "worker", task: "look around", description: "look", ...over });
const lineage = (h: Harness): Msg => JSON.parse(fs.readFileSync(path.join(h.dir, "data", "toriel", "lineage.json"), "utf8"));

describe("daemon: subagents", () => {
  it("runs a foreground subagent to its final text, nests it under the parent and parks its session", async () => {
    harness = await startDaemon();
    const { c, uuid } = await parentSession(harness);
    const r = await spawn(c, uuid, { task: "count the files" });
    assert.equal(r.state, "done");
    assert.equal(r.text, "echo: count the files");
    const entries = Object.values(lineage(harness)).filter((e) => e.kind === "subagent");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].parent.id, uuid);
    assert.match(entries[0].parent.name ?? "", /.*/);
    const listed = await c.request({ type: "agents_op", from: uuid, action: "list" });
    assert.match(listed.text, /^#1 worker: look \[done, 1 turn\(s\)/);
    const child = c.sessions().find((s) => s.sessionName?.startsWith("worker: look"));
    assert.ok(child, "the subagent is a session with a readable name");
    assert.equal(child.active, false);
  });

  it("runs several foreground calls in parallel and answers each with its own result", async () => {
    harness = await startDaemon({ FAKE_PI_RUN_MS: "300" });
    const { c, uuid } = await parentSession(harness);
    const started = Date.now();
    const [a, b] = await Promise.all([spawn(c, uuid, { task: "one" }), spawn(c, uuid, { task: "two" })]);
    assert.deepEqual([a.text, b.text], ["echo: one", "echo: two"]);
    assert.ok(Date.now() - started < 3000);
  });

  it("refuses a nested spawn, and a fourth concurrent subagent, with text the model can act on", async () => {
    harness = await startDaemon();
    const { c, uuid } = await parentSession(harness);
    for (const n of [1, 2, 3]) {
      await spawn(c, uuid, { task: `[hang] ${n}`, background: true });
    }
    await assert.rejects(spawn(c, uuid), /3 subagents are already running/);
    const childId = Object.entries(lineage(harness)).find(([, e]) => e.kind === "subagent")?.[0] as string;
    await assert.rejects(spawn(c, childId), /may not start subagents/);
    await c.request({ type: "agents_op", from: uuid, action: "stop", ref: "#1" });
    await c.request({ type: "agents_op", from: uuid, action: "stop", ref: "#2" });
    await c.request({ type: "agents_op", from: uuid, action: "stop", ref: "#3" });
  });

  it("cuts a subagent off at its token budget and returns what it had", async () => {
    harness = await startDaemon();
    const { c, uuid } = await parentSession(harness);
    const r = await spawn(c, uuid, { agent: "tiny", task: "[turns 9] dig" });
    assert.equal(r.state, "limit");
    assert.match(r.text, /over its budget of 25/);
    assert.match(r.text, /Partial result:\nstep \d/);
  });

  it("cuts a subagent off at its maxTurns", async () => {
    harness = await startDaemon();
    const { c, uuid } = await parentSession(harness);
    const r = await spawn(c, uuid, { agent: "short", task: "[turns 9] dig" });
    assert.equal(r.state, "limit");
    assert.match(r.text, /limit of 3 turns/);
  });

  it("stops a foreground subagent when the call is cancelled", async () => {
    harness = await startDaemon();
    const { c, uuid } = await parentSession(harness);
    const caller = await harness.connect();
    caller.send({ type: "agent_spawn", id: "x", from: uuid, agent: "worker", task: "[hang]", description: "wait" });
    for (let i = 0; i < 100; i++) {
      const t = (await c.request({ type: "agents_op", from: uuid, action: "list" })).text as string;
      if (t.includes("[running")) {
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    caller.close();
    const done = await c.request({ type: "agents_op", from: uuid, action: "wait", ref: "#1", timeoutMs: 5000 });
    assert.match(done.text, /cancelled the call/);
  });

  it("answers a background spawn at once and delivers the result to the parent as a message", async () => {
    harness = await startDaemon();
    const { c, uuid } = await parentSession(harness);
    const r = await spawn(c, uuid, { task: "dig", background: true });
    assert.equal(r.state, "running");
    assert.match(r.text, /Started subagent #1/);
    const got = await c.waitFor((m) => m.type === "event" && m.event?.type === "message_end" && JSON.stringify(m.event.message).includes("Subagent #1 (worker: look) finished"));
    assert.match(JSON.stringify(got.event.message), /echo: dig/);
  });

  it("waits for, reads and stops subagents by id, and only for the session that started them", async () => {
    harness = await startDaemon();
    const { c, uuid } = await parentSession(harness);
    await spawn(c, uuid, { task: "[hang]", background: true });
    const timedOut = await c.request({ type: "agents_op", from: uuid, action: "wait", ref: "#1", timeoutMs: 200 });
    assert.match(timedOut.text, /Timed out; still running/);
    const stopped = await c.request({ type: "agents_op", from: uuid, action: "stop", ref: "#1" });
    assert.equal(stopped.state, "stopped");
    assert.match(stopped.text, /stopped by its parent/);
    await assert.rejects(c.request({ type: "agents_op", from: "00000000-0000-4000-8000-000000000000", action: "result", ref: "#1" }), /you have no subagent #1/);
    await assert.rejects(c.request({ type: "agents_op", from: uuid, action: "status", ref: "#9" }), /no subagent #9 \(yours: #1\)/);
  });

  it("reports an unknown agent type and an unsaved caller as refusals", async () => {
    harness = await startDaemon();
    const { c, uuid } = await parentSession(harness);
    await assert.rejects(spawn(c, uuid, { agent: "nope" }), /no agent called "nope"/);
    await assert.rejects(spawn(c, "00000000-0000-4000-8000-000000000000"), /not running here/);
  });

  it("stops a foreground subagent when its parent's process stops, but lets a background one run", async () => {
    harness = await startDaemon();
    const { c, session, uuid } = await parentSession(harness);
    const caller = await harness.connect();
    await spawn(c, uuid, { task: "[hang]", background: true, description: "bg" });
    caller.send({ type: "agent_spawn", id: "x", from: uuid, agent: "worker", task: "[hang]", description: "fg" });
    for (let i = 0; i < 100 && !((await c.request({ type: "agents_op", from: uuid, action: "list" })).text as string).includes("#2"); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await c.request({ type: "deactivate", session });
    // the parent's stop ends its foreground subagent asynchronously (abort, last text, process stop)
    await c.request({ type: "agents_op", from: uuid, action: "wait", ref: "#2", timeoutMs: 5000 });
    const list = (await c.request({ type: "agents_op", from: uuid, action: "list" })).text as string;
    assert.match(list, /#2 worker: fg \[stopped/);
    assert.match(list, /#1 worker: bg \[running, background/);
    await c.request({ type: "agents_op", from: uuid, action: "stop", ref: "#1" });
  });

  it("gives the tools to a session the user started, with the agent types, and not to a subagent", async () => {
    harness = await startDaemon();
    const { c, session, uuid } = await parentSession(harness);
    const file = (n: number) => c.sessions().find((x) => x.id === n)?.sessionFile as string;
    const parentEnv = JSON.parse(fs.readFileSync(`${file(session)}.env.json`, "utf8"));
    assert.equal(parentEnv.TORIEL_CAN_SPAWN, "1");
    assert.match(parentEnv.TORIEL_AGENT_TYPES, /- worker: test agent worker/);
    assert.match(fs.readFileSync(`${file(session)}.argv.json`, "utf8"), /\+toriel_agent,\+toriel_agents/);
    await spawn(c, uuid, { task: "[hang]", background: true });
    const child = c.sessions().find((x) => x.sessionName?.startsWith("worker: look"));
    const childEnv = JSON.parse(fs.readFileSync(`${child?.sessionFile}.env.json`, "utf8"));
    assert.equal(childEnv.TORIEL_CAN_SPAWN, null);
    assert.doesNotMatch(fs.readFileSync(`${child?.sessionFile}.argv.json`, "utf8"), /toriel_agent/);
    await c.request({ type: "agents_op", from: uuid, action: "stop", ref: "#1" });
  });

  it("marks a finished subagent delivered, then deletes it after the grace window: file in the trash, link cut, result still readable", async () => {
    harness = await startDaemon({ TORIEL_SUBAGENT_KEEP_MS: "1500" });
    const { c, uuid } = await parentSession(harness);
    const r = await spawn(c, uuid, { task: "short job" });
    assert.equal(r.state, "done");
    const named = () => c.sessions().find((x) => x.sessionName?.startsWith("worker: look"));
    for (let i = 0; i < 40 && !named()?.subagent?.delivered; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.deepEqual(named()?.subagent, { state: "done", delivered: true, parent: uuid });
    const file = named()?.sessionFile as string;
    assert.ok(fs.existsSync(file));
    for (let i = 0; i < 100 && named(); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(named(), undefined, "the session left the switcher");
    assert.equal(fs.existsSync(file), false);
    assert.ok(fs.readdirSync(path.join(harness.dir, "trash")).length > 0, "the file is in the trash");
    assert.equal(Object.values(lineage(harness)).filter((e) => e.kind === "subagent").length, 0, "the subagent link is gone");
    assert.equal((await c.request({ type: "agents_op", from: uuid, action: "result", ref: "#1" })).text, "echo: short job");
    assert.ok(c.sessions().some((x) => x.sessionId === uuid), "the parent stays");
  });

  it("does not delete a subagent that is still running", async () => {
    harness = await startDaemon({ TORIEL_SUBAGENT_KEEP_MS: "300" });
    const { c, uuid } = await parentSession(harness);
    await spawn(c, uuid, { task: "[hang]", background: true });
    await new Promise((r) => setTimeout(r, 1500));
    assert.ok(c.sessions().some((x) => x.sessionName?.startsWith("worker: look")));
    await c.request({ type: "agents_op", from: uuid, action: "stop", ref: "#1" });
  });

  it("keeps a waiting subagent's dialog pending, tells its parent's controllers, and takes the answer without an attach", async () => {
    harness = await startDaemon({ FAKE_PI_ASK_MS: "0" });
    const { c, uuid } = await parentSession(harness);
    const r = await spawn(c, uuid, { task: "/ask", background: true });
    assert.equal(r.state, "running");
    const asked = await c.waitFor((m) => m.type === "ui_request" && m.request?.method === "confirm");
    const child = c.sessions().find((x) => x.sessionName?.startsWith("worker: look"));
    assert.equal(asked.session, child?.id);
    assert.equal(child?.subagent?.parent, uuid, "the meta says whose subagent it is, so the parent's controller can show the dialog");
    for (let i = 0; i < 40 && !c.sessions().find((x) => x.id === child?.id)?.pendingDialog; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(c.sessions().find((x) => x.id === child?.id)?.pendingDialog, true, "the badge");
    assert.equal(c.sessions().find((x) => x.id === child?.id)?.attachedToYou, false);
    // a controller that connects later is shown the dialog too, and nothing was denied meanwhile
    const late = await harness.connect();
    await late.request({ type: "list" });
    const again = await late.waitFor((m) => m.type === "ui_request" && m.session === child?.id);
    assert.equal(again.request.id, asked.request.id);
    await late.request({ type: "ui_response", session: child?.id, response: { type: "extension_ui_response", id: asked.request.id, confirmed: true } });
    for (let i = 0; i < 40 && c.sessions().find((x) => x.id === child?.id)?.pendingDialog; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(c.sessions().find((x) => x.id === child?.id)?.pendingDialog, false);
    await c.request({ type: "agents_op", from: uuid, action: "stop", ref: "#1" });
  });

  it("does not bring a swept subagent back to life when a controller that still shows it sends a prompt", async () => {
    harness = await startDaemon({ TORIEL_SUBAGENT_KEEP_MS: "0" });
    const { c, uuid } = await parentSession(harness);
    await spawn(c, uuid, { task: "short job" });
    const named = () => c.sessions().find((x) => x.sessionName?.startsWith("worker: look"));
    const file = named()?.sessionFile as string;
    for (let i = 0; i < 100 && named(); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(fs.existsSync(file), false);
    const before = c.sessions().length;
    await assert.rejects(c.request({ type: "prompt", sessionFile: file, cwd: harness.dir, message: "still there?" }), /was deleted \(its file is gone\)/);
    assert.equal(c.sessions().length, before, "no ghost session was created");
  });
});
