import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-agentsext-"));
const sock = path.join(dir, "d.sock");
process.env.TORIEL_CHILD = "1";
process.env.TORIEL_SOCK = sock;
process.env.TORIEL_SESSION_ID = "0b1c2d3e-aaaa-4bbb-8ccc-111111111111";
const ext = await import("../pi/extensions/toriel-agents.ts");

/** A daemon stand-in: answers each command with `reply(cmd)`. */
function fakeDaemon(reply: (cmd: Record<string, unknown>) => { ok: boolean; error?: string; data?: unknown } | undefined): Promise<{ seen: Array<Record<string, unknown>>; close(): void }> {
  const seen: Array<Record<string, unknown>> = [];
  const server = net.createServer((s) => {
    s.on("data", (chunk) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        const cmd = JSON.parse(line) as Record<string, unknown>;
        seen.push(cmd);
        s.write(`${JSON.stringify({ type: "sessions", sessions: [] })}\n`); // noise a real daemon may send first
        const r = reply(cmd);
        if (r) {
          s.write(`${JSON.stringify({ type: "response", id: cmd.id, ...r })}\n`);
        }
      }
    });
  });
  fs.rmSync(sock, { force: true });
  return new Promise((resolve) => server.listen(sock, () => resolve({ seen, close: () => server.close() })));
}

function registered() {
  const tools: Array<{ name: string; description: string; execute(...a: unknown[]): Promise<{ content: Array<{ text: string }> }> }> = [];
  ext.default({ registerTool: (t: never) => tools.push(t) } as never);
  return tools;
}

describe("toriel_message tool", () => {
  it("registers only inside a toriel child, and tells the model to use it only when asked", () => {
    const [tool] = registered();
    assert.equal(tool?.name, "toriel_message");
    assert.match(tool?.description ?? "", /ONLY when the user asks/);
  });

  it("sends the target, text and its own session id to the daemon and reports the delivery", async () => {
    const d = await fakeDaemon(() => ({ ok: true, data: { delivered: true, disposition: "started a turn", to: "Mealie", toId: "abc" } }));
    try {
      const out = await registered()[0]?.execute("t1", { to: "Mealie", text: "hi" }, undefined, undefined, {});
      assert.match(out?.content[0]?.text ?? "", /Delivered to Mealie \(abc\): started a turn/);
      assert.deepEqual([d.seen[0]?.type, d.seen[0]?.to, d.seen[0]?.text, d.seen[0]?.from], ["message", "Mealie", "hi", process.env.TORIEL_SESSION_ID]);
    } finally {
      d.close();
    }
  });

  it("returns the daemon's refusal as text instead of throwing", async () => {
    const d = await fakeDaemon(() => ({ ok: false, error: 'no session matches "zzz"' }));
    try {
      const out = await registered()[0]?.execute("t1", { to: "zzz", text: "hi" }, undefined, undefined, {});
      assert.match(out?.content[0]?.text ?? "", /Not delivered: no session matches "zzz"/);
    } finally {
      d.close();
    }
  });

  it("says so when the daemon is not reachable", async () => {
    fs.rmSync(sock, { force: true });
    const out = await registered()[0]?.execute("t1", { to: "x", text: "hi" }, undefined, undefined, {});
    assert.match(out?.content[0]?.text ?? "", /Not delivered: cannot reach the toriel daemon/);
  });
});

describe("toriel_schedule_* tools", () => {
  const tool = (name: string) => {
    const t = registered().find((x) => x.name === name);
    assert.ok(t, name);
    return t;
  };
  const run = (name: string, params: Record<string, unknown>) => tool(name).execute("t1", params, undefined, undefined, {});

  it("registers create, list and cancel next to the message tool", () => {
    assert.deepEqual(registered().map((t) => t.name), ["toriel_message", "toriel_schedule_create", "toriel_schedule_list", "toriel_schedule_cancel"]);
    assert.match(tool("toriel_schedule_create").description, /Prefer long delays/);
  });

  it("creates a schedule in its own session from one when string, marked as the agent's, and reads back the echo", async () => {
    const d = await fakeDaemon(() => ({ ok: true, data: { echo: "#2: every 2h, next 16:00 (in 2h), expires Nov 7 14:00", notes: [] } }));
    try {
      const out = await run("toriel_schedule_create", { when: "every 2h", prompt: "check the deploy", name: "deploy", max: 4 });
      assert.match(out.content[0]?.text ?? "", /Scheduled #2: every 2h, next 16:00/);
      assert.deepEqual(
        { ...d.seen[0], id: undefined },
        { type: "schedule_add", uuid: process.env.TORIEL_SESSION_ID, mode: "auto", when: ["every", "2h"], prompt: "check the deploy", name: "deploy", max: 4, by: "agent", id: undefined },
      );
    } finally {
      d.close();
    }
  });

  it("passes the daemon's explanation of a bad time back to the model", async () => {
    const d = await fakeDaemon(() => ({ ok: false, error: '"5" is ambiguous - try "5:00" for 24-hour time, or "5am" / "5pm"' }));
    try {
      const out = await run("toriel_schedule_create", { when: "at 5", prompt: "x" });
      assert.match(out.content[0]?.text ?? "", /Not scheduled: "5" is ambiguous/);
    } finally {
      d.close();
    }
  });

  it("lists only its own session's schedules", async () => {
    const d = await fakeDaemon(() => ({ ok: true, data: { schedules: [{ id: 1, name: "poll", when: "every 30m", state: "active", next: 1_800_000_000_000, fired: 2, max: 5, prompt: "look" }] } }));
    try {
      const out = await run("toriel_schedule_list", {});
      assert.match(out.content[0]?.text ?? "", /^#1 poll: every 30m; next .*; 2 run\(s\) of 5; prompt: look$/);
      assert.equal(d.seen[0]?.uuid, process.env.TORIEL_SESSION_ID);
    } finally {
      d.close();
    }
  });

  it("cancels by id or name, or everything with all, always within its own session", async () => {
    const d = await fakeDaemon(() => ({ ok: true, data: { schedules: [{ id: 3, name: "x" }], count: 1 } }));
    try {
      const out = await run("toriel_schedule_cancel", { id: "#3" });
      assert.match(out.content[0]?.text ?? "", /Cancelled #3 x\./);
      await run("toriel_schedule_cancel", { id: "all" });
      assert.deepEqual([d.seen[0]?.ref, d.seen[0]?.all, d.seen[0]?.uuid], ["#3", undefined, process.env.TORIEL_SESSION_ID]);
      assert.deepEqual([d.seen[1]?.ref, d.seen[1]?.all], [undefined, true]);
    } finally {
      d.close();
    }
  });
});
