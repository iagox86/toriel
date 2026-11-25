// The daemon's part of showing a session's past in chat: read_history, and published sessions nobody has opened (tickets 279, 280).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { DaemonContext } from "../src/daemon-context.ts";
import { registerPublished } from "../src/daemon-published.ts";
import { SessionRegistry } from "../src/daemon-session.ts";
import { type Harness, startDaemon } from "./helpers.ts";

let harness: Harness | undefined;
const dirs: string[] = [];
const saved = process.env.PI_CODING_AGENT_DIR;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
  if (saved === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = saved;
  }
});

describe("daemon: read_history (ticket 279)", () => {
  it("answers with the conversation's turns for a live session, and does not attach or replace anyone's view", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history" && m.session === sessionId);
    await c.request({ type: "prompt", session: sessionId, message: "hello there" });
    await c.waitFor((m) => m.type === "event" && m.event?.type === "agent_settled");
    const other = await harness.connect();
    await other.request({ type: "list" });
    await other.waitFor((m) => m.type === "history" && m.session === sessionId); // a new controller is given the live transcripts
    const before = other.messages.filter((m) => m.type === "history").length;
    const r = await other.request({ type: "read_history", session: sessionId, last: 10 });
    assert.ok(r.total >= 2, `a user turn and a reply, got ${r.total}`);
    assert.equal(r.turns[0].role, "user");
    assert.equal(r.turns[0].text, "hello there");
    assert.ok(r.turns.some((t: { role: string; text: string }) => t.role === "assistant" && t.text.length > 0));
    assert.equal(other.messages.filter((m) => m.type === "history").length, before, "read_history sends the reader no history to replace its view with");
    assert.equal(other.sessions().find((x) => x.id === sessionId)?.attachedElsewhere, true, "the first controller keeps the attach");
    assert.equal((await other.request({ type: "read_history", session: sessionId, last: 1 })).turns.length, 1);
  });
  it("refuses a session that does not exist", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    await assert.rejects(c.request({ type: "read_history", session: 999 }), /no session 999/);
  });
});

describe("daemon: published sessions nobody has opened (ticket 280)", () => {
  const uuid = "0b4e7c9e-1f59-4a6a-9d2b-5a1f0c3d7e11";

  /** A pi sessions directory holding one session file, as pi names it. */
  function piDirWith(id: string): { agent: string; cwd: string; file: string } {
    const agent = fs.mkdtempSync(path.join(os.tmpdir(), "published-agent-"));
    dirs.push(agent);
    const cwd = path.join(agent, "project");
    const proj = path.join(agent, "sessions", "--project--");
    fs.mkdirSync(proj, { recursive: true });
    const file = path.join(proj, `2026-11-25T10-00-00-000Z_${id}.jsonl`);
    const lines = [
      { type: "session", version: 3, id, timestamp: "2026-11-25T10:00:00.000Z", cwd },
      { type: "message", id: "a1", parentId: null, timestamp: "2026-11-25T10:00:01.000Z", message: { role: "user", content: "an old question", timestamp: 1 } },
      { type: "session_info", id: "a2", parentId: "a1", timestamp: "2026-11-25T10:00:02.000Z", name: "Old Session" },
    ];
    fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    process.env.PI_CODING_AGENT_DIR = agent;
    return { agent, cwd, file };
  }

  function ctxFor(ids: string[]): { ctx: DaemonContext; registry: SessionRegistry; broadcasts: number } {
    const registry = new SessionRegistry();
    const state = { broadcasts: 0 };
    const ctx = { registry, published: { ids: () => ids }, hub: { broadcastSessions: () => void state.broadcasts++ } } as unknown as DaemonContext;
    return { ctx, registry, get broadcasts() { return state.broadcasts; } };
  }

  it("registers a published session from its file, asleep, so the session list carries it", async () => {
    const { cwd, file } = piDirWith(uuid);
    const t = ctxFor([uuid]);
    assert.equal(await registerPublished(t.ctx), 1);
    const s = t.registry.all()[0];
    assert.equal(s.sessionId, uuid);
    assert.equal(s.sessionFile, file);
    assert.equal(s.cwd, cwd);
    assert.equal(s.child, undefined, "nothing was started");
    assert.equal(t.broadcasts, 1);
  });
  it("leaves alone a session the daemon already holds, and one whose file is gone", async () => {
    piDirWith(uuid);
    const t = ctxFor([uuid, "ffffffff-ffff-4fff-8fff-ffffffffffff"]);
    assert.equal(await registerPublished(t.ctx), 1, "only the one with a file");
    assert.equal(await registerPublished(t.ctx), 0, "and not twice");
    assert.equal(t.registry.all().length, 1);
  });
});

describe("daemon: what the bridge reports (ticket 283)", () => {
  it("shows a problem and the channel of a published session in the session list, and clears the problem", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.request({ type: "prompt", session: sessionId, message: "hi" });
    let uuid: string | undefined;
    for (let i = 0; i < 80 && !uuid; i++) {
      uuid = c.sessions().find((x) => x.id === sessionId)?.sessionId;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(uuid);
    await c.request({ type: "publish", sessionId: uuid, on: true });
    const bridge = await harness.connect();
    await bridge.request({ type: "list" });
    await bridge.request({ type: "chat_status", up: true, problem: "could not open the channel for \"X\": boom", session: sessionId });
    await c.waitFor((m) => m.type === "sessions" && m.sessions.some((x: { id: number; chatProblem?: string }) => x.id === sessionId && /boom/.test(x.chatProblem ?? "")));
    await c.waitFor((m) => m.type === "notice" && m.session === sessionId && /^chat bridge: could not open/.test(m.text) && m.durable === true);
    await bridge.request({ type: "chat_channels", channels: { [uuid]: "fix-the-build" } });
    await c.waitFor((m) => m.type === "sessions" && m.sessions.some((x: { id: number; chatChannel?: string }) => x.id === sessionId && x.chatChannel === "fix-the-build"));
    await bridge.request({ type: "chat_status", up: true });
    await c.waitFor((m) => m.type === "sessions" && m.sessions.some((x: { id: number; chatProblem?: string; chatUp?: boolean }) => x.id === sessionId && x.chatProblem === undefined && x.chatUp === true));
  });
});
