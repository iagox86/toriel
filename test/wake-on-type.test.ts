import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { SESSION_COMMANDS } from "../src/commands.ts";
import type { Host } from "../src/host.ts";
import { SessionCommands } from "../src/session-commands.ts";
import { mayWake, NO_CHILD_COMMANDS, WakeOnType, wantsWake } from "../src/wake-on-type.ts";
import { type Harness, startDaemon } from "./helpers.ts";

describe("wantsWake", () => {
  it("is true for the start of a /command or !command, false for prose and the empty editor", () => {
    for (const text of ["/", "/mc", "/mcp explore ", "!ls", "!", "  /think", "\t!pwd"]) {
      assert.equal(wantsWake(text), true, text);
    }
    for (const text of ["/help", "/exit", "/park", "/in 5m check", "/Name x", "  /watch notes.md"]) {
      assert.equal(wantsWake(text), false, `${text}: toriel's own, no child needed`);
    }
    for (const text of ["", " ", "hello", "what is /etc/passwd", "a ! b", "fix this\n/mcp"]) {
      assert.equal(wantsWake(text), false, JSON.stringify(text));
    }
  });
});

describe("NO_CHILD_COMMANDS", () => {
  it("only names commands that exist, so a rename cannot leave a stale entry", () => {
    const names = new Set(SESSION_COMMANDS.map((c) => c.name));
    for (const n of NO_CHILD_COMMANDS) {
      assert.ok(names.has(n), `/${n} is not a session command`);
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

const WAKE_KEY = "/home/u/.pi/agent/sessions/dir/s.jsonl";

/** A Host stub for SessionCommands.wakeForTyping; `meta` is what the controller knows about the viewed session. */
function wakeHost(meta: unknown, request: (cmd: Record<string, unknown>) => Promise<unknown>) {
  const requests: Array<Record<string, unknown>> = [];
  const notices: string[] = [];
  const host = {
    viewing: WAKE_KEY,
    local: new Map(),
    switching: { isOpen: false },
    metaForPath: () => (meta === undefined ? undefined : (meta as object)),
    notify: (m: string) => void notices.push(m),
    request: async (cmd: Record<string, unknown>) => {
      requests.push(cmd);
      return request(cmd);
    },
    refreshPiCommands: () => {},
  } as unknown as Host;
  return { host, requests, notices };
}

describe("wakeForTyping", () => {
  it("sends the wake for a session the controller knows", async () => {
    const { host, requests, notices } = wakeHost({ id: 7, active: false, cwd: "/work/proj" }, async () => ({ woke: true }));
    await new SessionCommands(host).wakeForTyping();
    assert.deepEqual(requests, [{ type: "spawn", sessionFile: WAKE_KEY, cwd: "/work/proj", ready: true, wake: true }]);
    assert.equal(notices.length, 1);
  });

  it("sends the wake for a session file the controller has no meta for, using the cwd from the file's header (ticket 202)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-wake-"));
    const file = path.join(dir, "s.jsonl");
    const hostOf = () => {
      const wake = wakeHost(undefined, async () => ({ woke: true }));
      (wake.host as { viewing: string }).viewing = file;
      return wake;
    };
    fs.writeFileSync(file, `${JSON.stringify({ type: "session", id: "s1", cwd: "/work/proj-from-header" })}\n`);
    const known = hostOf();
    await new SessionCommands(known.host).wakeForTyping();
    assert.equal(known.requests[0]?.cwd, "/work/proj-from-header");
    // an unreadable header falls back to the file's directory
    fs.writeFileSync(file, "not json\n");
    const unknown = hostOf();
    await new SessionCommands(unknown.host).wakeForTyping();
    assert.equal(unknown.requests[0]?.cwd, dir);
  });

  it("notifies the reason on a refused wake, and swallows a thrown error silently", async () => {
    const refused = wakeHost(undefined, async () => ({ woke: false, reason: "another pi may be running it" }));
    await new SessionCommands(refused.host).wakeForTyping();
    assert.deepEqual(refused.notices, ["starting session...", "session not started: another pi may be running it"]);

    const broken = wakeHost(undefined, async () => {
      throw new Error("socket gone");
    });
    await new SessionCommands(broken.host).wakeForTyping();
    assert.deepEqual(broken.notices, ["starting session..."]);
  });
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
