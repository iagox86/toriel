import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { mayWake, WakeOnType, wantsWake } from "../src/wake-on-type.ts";
import { type Harness, startDaemon } from "./helpers.ts";

describe("wantsWake", () => {
  it("is true for the start of a /command or !command, false for prose and the empty editor", () => {
    for (const text of ["/", "/mc", "/mcp explore ", "!ls", "!", "  /think", "\t!pwd"]) {
      assert.equal(wantsWake(text), true, text);
    }
    for (const text of ["", " ", "hello", "what is /etc/passwd", "a ! b", "fix this\n/mcp"]) {
      assert.equal(wantsWake(text), false, JSON.stringify(text));
    }
  });
});

describe("mayWake", () => {
  const file = "/home/u/.pi/agent/sessions/x/s.jsonl";
  it("wakes a sleeping or not-yet-registered session file", () => {
    assert.equal(mayWake(file, undefined, false), true);
    assert.equal(mayWake(file, { active: false }, false), true);
  });

  it("never wakes what must not wake", () => {
    assert.equal(mayWake(file, { active: true }, false), false, "already up");
    assert.equal(mayWake(file, { active: false, attachedElsewhere: true }, false), false, "view-only");
    assert.equal(mayWake(file, { active: false, externallyLive: true }, false), false, "open in another pi");
    assert.equal(mayWake(file, { active: false, subagent: { state: "done", delivered: true, parent: "p", tokens: 0, budget: 1, turns: 0 } }, false), false, "a parent owns it");
    assert.equal(mayWake(file, { active: false }, true), false, "the session list is open");
    assert.equal(mayWake(undefined, { active: false }, false), false, "no session on screen");
    assert.equal(mayWake("new-session", { active: false }, false), false, "nothing on disk to start");
  });
});

describe("WakeOnType", () => {
  /** Timers the test fires by hand. */
  function fakeTimers() {
    const pending = new Map<number, { fn: () => void; ms: number }>();
    let next = 1;
    return {
      pending,
      set: (fn: () => void, ms: number) => {
        pending.set(next, { fn, ms });
        return next++;
      },
      clear: (h: unknown) => void pending.delete(h as number),
      fire: () => {
        const all = [...pending.values()];
        pending.clear();
        for (const t of all) {
          t.fn();
        }
      },
    };
  }

  function setup(opts: { allowed?: () => boolean } = {}) {
    const timers = fakeTimers();
    let text = "";
    let wakes = 0;
    const w = new WakeOnType({ text: () => text, allowed: opts.allowed ?? (() => true), wake: () => wakes++, delayMs: 400, timers });
    const type = (t: string) => {
      text = t;
      w.onText(t);
    };
    return { timers, w, type, wakes: () => wakes };
  }

  it("wakes once, after a pause, for a command", () => {
    const { timers, type, wakes } = setup();
    type("/");
    type("/m");
    type("/mc");
    assert.equal(timers.pending.size, 1, "each keystroke restarts one timer");
    assert.equal([...timers.pending.values()][0]?.ms, 400);
    assert.equal(wakes(), 0, "nothing before the pause");
    timers.fire();
    assert.equal(wakes(), 1);
  });

  it("does nothing for prose, or when the text is deleted before the pause ends", () => {
    const a = setup();
    a.type("hello there");
    assert.equal(a.timers.pending.size, 0);
    a.timers.fire();
    assert.equal(a.wakes(), 0);

    const b = setup();
    b.type("/");
    b.type("");
    assert.equal(b.timers.pending.size, 0, "the pending wake was cancelled");
    b.timers.fire();
    assert.equal(b.wakes(), 0);
  });

  it("looks again when the timer fires: text, session and state may have changed", () => {
    let allowed = true;
    const { timers, type, wakes } = setup({ allowed: () => allowed });
    type("!ls");
    allowed = false; // e.g. the user switched to another session meanwhile
    timers.fire();
    assert.equal(wakes(), 0);
  });

  it("cancel drops a pending wake (the text was sent, or the view changed)", () => {
    const { timers, w, type, wakes } = setup();
    type("/mcp");
    w.cancel();
    timers.fire();
    assert.equal(wakes(), 0);
  });
});

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

/** A session file that looks like one pi wrote `ageMs` ago. */
function sessionFile(h: Harness, name: string, ageMs: number): string {
  const file = path.join(h.dir, name);
  fs.writeFileSync(file, `${JSON.stringify({ type: "session", id: name })}\n`);
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(file, when, when);
  return file;
}

describe("daemon: waking a sleeping session by typing (ticket 68)", () => {
  it("starts a quiet old session file once, and joins a start already in flight", async () => {
    harness = await startDaemon({ FAKE_PI_STARTUP_MS: "300" });
    const c = await harness.connect();
    const file = sessionFile(harness, "old.jsonl", 10 * 60_000);
    const [a, b] = await Promise.all([
      c.request({ type: "spawn", cwd: harness.dir, sessionFile: file, ready: true, wake: true }),
      c.request({ type: "spawn", cwd: harness.dir, sessionFile: file, ready: true, wake: true }),
    ]);
    assert.equal((a as { woke?: boolean }).woke, true);
    assert.equal((b as { woke?: boolean }).woke, true);
    assert.equal((a as { sessionId: number }).sessionId, (b as { sessionId: number }).sessionId);
    const mine = c.sessions().filter((s) => s.sessionFile === file);
    assert.equal(mine.length, 1, "one session for the file");
    assert.equal(mine[0]?.active, true);
  });

  it("shares one start between a wake and the prompt that follows it, delivering the prompt once", async () => {
    harness = await startDaemon({ FAKE_PI_STARTUP_MS: "300" });
    const c = await harness.connect();
    const file = sessionFile(harness, "old2.jsonl", 10 * 60_000);
    const wake = c.request({ type: "spawn", cwd: harness.dir, sessionFile: file, ready: true, wake: true });
    // a moment later, while pi is still coming up: the user presses Enter
    await new Promise((r) => setTimeout(r, 100));
    const sent = c.request({ type: "prompt", sessionFile: file, cwd: harness.dir, message: "hello after wake" });
    await Promise.all([wake, sent]);
    let users = 0;
    for (let i = 0; i < 50 && users === 0; i++) {
      users = fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l.includes('"role":"user"') && l.includes("hello after wake")).length;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(users, 1, "one delivery");
    assert.equal(c.sessions().filter((s) => s.sessionFile === file).length, 1);
  });

  it("refuses a file written in the last minute that toriel never ran: another pi may have it open", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const file = sessionFile(harness, "fresh.jsonl", 5_000);
    const r = (await c.request({ type: "spawn", cwd: harness.dir, sessionFile: file, ready: true, wake: true })) as { woke?: boolean; reason?: string };
    assert.equal(r.woke, false);
    assert.match(r.reason ?? "", /another pi may be running it/);
    assert.ok(c.sessions().every((s) => s.sessionFile !== file), "nothing was registered or started");
  });

  it("wakes a session toriel already knows even when its file is fresh (a resume makes it look new)", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history" && m.session === sessionId);
    await c.request({ type: "prompt", session: sessionId, message: "hi" });
    await c.waitFor((m) => m.type === "event" && m.event?.type === "agent_settled");
    const file = c.sessions().find((s) => s.id === sessionId)?.sessionFile as string;
    await c.request({ type: "deactivate", session: sessionId });
    const r = (await c.request({ type: "spawn", cwd: harness.dir, sessionFile: file, ready: true, wake: true })) as { woke?: boolean };
    assert.equal(r.woke, true);
    assert.equal(c.sessions().find((s) => s.id === sessionId)?.active, true);
  });
});
