import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { type Client, type Harness, type Msg, startDaemon } from "./helpers.ts";

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const isSettled = (m: Msg) => m.type === "event" && m.event?.type === "agent_settled";

/** A session that has answered once, so it has a UUID to schedule against. */
async function savedSession(h: Harness): Promise<{ c: Client; session: number; uuid: string }> {
  const c = await h.connect();
  const { sessionId } = await c.request({ type: "spawn", cwd: h.dir });
  await c.waitFor((m) => m.type === "history" && m.session === sessionId);
  await c.request({ type: "prompt", session: sessionId, message: "hi" });
  await c.waitFor(isSettled);
  const uuid = await (async () => {
    for (let i = 0; i < 40; i++) {
      const found = c.sessions().find((s) => s.id === sessionId)?.sessionId;
      if (found) {
        return found as string;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("the session never reported an id");
  })();
  return { c, session: sessionId, uuid };
}

describe("daemon: schedules", () => {
  it("fires a one-shot into the session as a labelled prompt, then forgets it", async () => {
    harness = await startDaemon();
    const { c, session } = await savedSession(harness);
    const added = await c.request({ type: "schedule_add", session, mode: "in", when: ["1s"], prompt: "ping the build", name: "nudge" });
    assert.match(added.echo, /^#1 nudge: once, /);
    assert.equal(added.schedule.when.startsWith("once"), true);
    const reply = await c.waitFor((m) => m.type === "event" && m.event?.type === "message_end" && m.event.message?.role === "assistant" && JSON.stringify(m.event.message).includes("[scheduled #1"));
    assert.match(reply.event.message.content[0].text, /echo: \[scheduled #1 "nudge", run 1\]: ping the build/);
    const { schedules } = await c.request({ type: "schedule_list", session });
    assert.deepEqual(schedules, [], "a one-shot is gone once it has fired");
  });

  it("reads the prompt from after the time spec and reports how it understood it", async () => {
    harness = await startDaemon();
    const { c, session } = await savedSession(harness);
    const r = await c.request({ type: "schedule_add", session, mode: "every", when: ["2h", "check", "the", "queue"], max: 3 });
    assert.equal(r.schedule.prompt, "check the queue");
    assert.match(r.echo, /every 2h, next .*\(in 2h\), expires .*, max 3/);
    const listed = await c.request({ type: "schedule_list", session });
    assert.equal(listed.schedules.length, 1);
    assert.equal(listed.schedules[0].when, "every 2h");
  });

  it("answers a dry run with the next fire times and creates nothing", async () => {
    harness = await startDaemon();
    const { c, session } = await savedSession(harness);
    const r = await c.request({ type: "schedule_add", session, mode: "every", when: ["weekday", "9am", "x"], dryRun: true });
    assert.equal(r.dryRun, true);
    assert.equal(r.fires.length, 3);
    assert.deepEqual((await c.request({ type: "schedule_list" })).schedules, []);
  });

  it("explains bad input in words instead of failing opaquely", async () => {
    harness = await startDaemon();
    const { c, session } = await savedSession(harness);
    await assert.rejects(c.request({ type: "schedule_add", session, mode: "at", when: ["5", "x"] }), /ambiguous/);
    await assert.rejects(c.request({ type: "schedule_add", session, mode: "in", when: ["10m"] }), /what should it say/);
    await assert.rejects(c.request({ type: "schedule_add", session, mode: "every", when: ["10s", "x"] }), /shortest repeat interval/);
    await assert.rejects(c.request({ type: "schedule_add", session, mode: "in", when: ["5m"], prompt: "x", expires: "soon" }), /cannot read "soon"/);
    await assert.rejects(c.request({ type: "schedule_add", session, mode: "in", when: ["5m", "extra"], prompt: "x" }), /cannot read "extra"/);
  });

  it("pauses, resumes and cancels by id or name, within a session or across all", async () => {
    harness = await startDaemon();
    const { c, session, uuid } = await savedSession(harness);
    await c.request({ type: "schedule_add", session, mode: "every", when: ["1h", "a"], name: "alpha" });
    await c.request({ type: "schedule_add", session, mode: "every", when: ["2h", "b"] });
    await c.request({ type: "schedule_op", op: "pause", ref: "alpha", session });
    let list = (await c.request({ type: "schedule_list", uuid })).schedules;
    assert.equal(list.find((s: Msg) => s.id === 1).state, "paused");
    await c.request({ type: "schedule_op", op: "resume", ref: "#1", session });
    assert.equal((await c.request({ type: "schedule_list", uuid })).schedules.find((s: Msg) => s.id === 1).state, "active");
    await assert.rejects(c.request({ type: "schedule_op", op: "cancel", ref: "nope", session }), /no schedule named "nope"/);
    await assert.rejects(c.request({ type: "schedule_op", op: "cancel", session }), /which schedule/);
    await c.request({ type: "schedule_op", op: "cancel", ref: "2" });
    list = (await c.request({ type: "schedule_list" })).schedules;
    assert.deepEqual(list.map((s: Msg) => s.id), [1]);
    const all = await c.request({ type: "schedule_op", op: "cancel", all: true, session });
    assert.equal(all.count, 1);
  });

  it("fire runs one now without touching its schedule", async () => {
    harness = await startDaemon();
    const { c, session } = await savedSession(harness);
    await c.request({ type: "schedule_add", session, mode: "every", when: ["1h", "run it"] });
    await c.request({ type: "schedule_op", op: "fire", ref: "1", session });
    await c.waitFor((m) => m.type === "event" && m.event?.type === "message_end" && JSON.stringify(m.event.message).includes("[scheduled #1, run 1]: run it"));
    const listed = (await c.request({ type: "schedule_list", session })).schedules[0];
    assert.equal(listed.fired, 1);
    assert.ok(listed.next > Date.now() + 50 * 60_000, "still due in about an hour");
  });

  it("shows a session's schedule count and next fire in the session list, and says so when one is cancelled", async () => {
    harness = await startDaemon();
    const { c, session } = await savedSession(harness);
    const added = await c.request({ type: "schedule_add", session, mode: "every", when: ["1h", "x"], name: "poll" });
    await c.waitFor((m) => m.type === "sessions" && m.sessions.some((s: Msg) => s.id === session && s.schedules === 1 && s.nextFire === added.schedule.next && /^scheduled: poll, every 1h, next /.test(s.scheduleLines?.[0] ?? "")));
    await c.request({ type: "schedule_op", op: "cancel", ref: "poll", session });
    const notice = await c.waitFor((m) => m.type === "notice");
    assert.deepEqual([notice.session, notice.text], [session, "schedule #1 poll cancelled"]);
    await c.waitFor((m) => m.type === "sessions" && m.sessions.every((s: Msg) => s.id !== session || s.schedules === undefined));
  });

  it("runs --until / --while checks in the session's directory with no model call until they pass", async () => {
    harness = await startDaemon();
    const { c, session } = await savedSession(harness);
    const marker = `${harness.dir}/ready`;
    const added = await c.request({ type: "schedule_add", session, mode: "every", when: ["10s", "go"], until: `test -f ${marker}` });
    assert.match(added.echo, /until `test -f .*ready` succeeds/);
    const before = c.messages.length;
    await new Promise((r) => setTimeout(r, 11_500));
    assert.ok(!c.messages.slice(before).some((m) => m.type === "event" && JSON.stringify(m).includes("[scheduled #")), "nothing was sent while the file was missing");
    await import("node:fs").then((fs) => fs.writeFileSync(marker, ""));
    await c.waitFor((m) => m.type === "event" && m.event?.type === "message_end" && JSON.stringify(m.event.message).includes("[scheduled #1, run 1]: go"), 15_000);
    assert.deepEqual((await c.request({ type: "schedule_list", session })).schedules, []);
    await assert.rejects(c.request({ type: "schedule_add", session, mode: "in", when: ["5m", "x"], until: "true" }), /\/in|until/);
  });

  it("removes a session's schedules when the session is deleted", async () => {
    harness = await startDaemon();
    const { c, session } = await savedSession(harness);
    await c.request({ type: "schedule_add", session, mode: "every", when: ["1h", "x"] });
    await c.request({ type: "delete", session });
    assert.deepEqual((await c.request({ type: "schedule_list" })).schedules, []);
  });
});

describe("daemon: file triggers (board 98)", () => {
  const fires = (c: Client): number => c.messages.filter((m) => m.type === "event" && m.event?.type === "message_end" && m.event.message?.role === "assistant" && JSON.stringify(m.event.message).includes("[scheduled #1")).length;
  const until = async (cond: () => boolean, ms = 8000): Promise<void> => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) {
        throw new Error("timed out waiting");
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const quiet = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("delivers a labelled prompt naming the file when it changes, once per burst, and keeps watching", async () => {
    const { writeFileSync, appendFileSync } = await import("node:fs");
    harness = await startDaemon();
    const { c, session } = await savedSession(harness);
    const target = `${harness.dir}/review.md`;
    const added = await c.request({ type: "watch_add", session, path: "review.md", prompt: "read it and summarize", name: "review", cooldown: "1s" });
    assert.match(added.echo, /^#1 review: on change: .*review\.md, waiting for a change \(quiet 1s first\), expires /);
    assert.equal(added.schedule.when, `on change: ${target}`);
    for (let i = 0; i < 4; i++) {
      appendFileSync(target, `line ${i}\n`);
      await quiet(20);
    }
    writeFileSync(target, "done\n");
    const reply = await c.waitFor((m) => m.type === "event" && m.event?.type === "message_end" && m.event.message?.role === "assistant" && JSON.stringify(m.event.message).includes("[scheduled #1"));
    assert.match(JSON.stringify(reply.event.message), /\[scheduled #1 \\"review\\", run 1\]: \(File trigger: .*review\.md changed\.\)\\n\\nread it and summarize/);
    await quiet(2500);
    assert.equal(fires(c), 1, "one burst of writes is one prompt");
    appendFileSync(target, "again\n");
    await until(() => fires(c) === 2);
    const listed = (await c.request({ type: "schedule_list", session })).schedules[0];
    assert.equal(listed.fired, 2);
    assert.equal(listed.state, "active", "a watch keeps waiting after it fires");
  });

  it("sees an atomic save (a temp file renamed over the target)", async () => {
    const { writeFileSync, renameSync } = await import("node:fs");
    harness = await startDaemon();
    const { c, session } = await savedSession(harness);
    writeFileSync(`${harness.dir}/doc.md`, "old");
    await c.request({ type: "watch_add", session, path: `${harness.dir}/doc.md`, prompt: "reread", cooldown: "1s" });
    writeFileSync(`${harness.dir}/.doc.md.tmp`, "new");
    renameSync(`${harness.dir}/.doc.md.tmp`, `${harness.dir}/doc.md`);
    await until(() => fires(c) === 1);
  });

  it("--once ends after the first fire", async () => {
    const { writeFileSync } = await import("node:fs");
    harness = await startDaemon();
    const { c, session } = await savedSession(harness);
    await c.request({ type: "watch_add", session, path: `${harness.dir}/once.txt`, prompt: "p", once: true, cooldown: "1s" });
    writeFileSync(`${harness.dir}/once.txt`, "x");
    await until(() => fires(c) === 1);
    assert.deepEqual((await c.request({ type: "schedule_list", session })).schedules, []);
    writeFileSync(`${harness.dir}/once.txt`, "y");
    await quiet(2500);
    assert.equal(fires(c), 1, "gone means gone: no watch is left behind");
  });

  it("stops while paused and picks up again on resume; cancel stops it for good", async () => {
    const { appendFileSync } = await import("node:fs");
    harness = await startDaemon();
    const { c, session } = await savedSession(harness);
    const target = `${harness.dir}/p.txt`;
    await c.request({ type: "watch_add", session, path: target, prompt: "p", cooldown: "1s" });
    await c.request({ type: "schedule_op", op: "pause", ref: "1", session });
    appendFileSync(target, "a");
    await quiet(2500);
    assert.equal(fires(c), 0, "a paused watch does not fire");
    await c.request({ type: "schedule_op", op: "resume", ref: "1", session });
    await quiet(300);
    assert.equal(fires(c), 0, "and does not replay what it missed while paused");
    appendFileSync(target, "b");
    await until(() => fires(c) === 1);
    await c.request({ type: "schedule_op", op: "cancel", ref: "1", session });
    appendFileSync(target, "c");
    await quiet(2500);
    assert.equal(fires(c), 1);
  });

  it("re-arms the watches of the schedules the file brings back when the daemon starts", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-watch-seed-"));
    const seeded = path.join(dir, "schedules.json");
    const now = Date.now();
    fs.writeFileSync(
      seeded,
      JSON.stringify({
        version: 1,
        nextId: 2,
        schedules: [{ id: 1, session: "00000000-0000-4000-8000-000000000000", prompt: "p", trigger: { kind: "watch", path: `${dir}/watched.txt`, dir: false, events: "write", cooldownMs: 1000 }, fired: 0, createdAt: now, expiresAt: now + 86_400_000, catchup: "once", by: "user", state: "active" }],
      }),
    );
    try {
      harness = await startDaemon({ TORIEL_SCHEDULES: seeded });
      const c = await harness.connect();
      assert.equal((await c.request({ type: "schedule_list" })).schedules[0].when, `on change: ${dir}/watched.txt`);
      fs.writeFileSync(`${dir}/watched.txt`, "x");
      // the session does not exist, so the delivery fails: that it was TRIED shows the watch came back with the daemon
      const end = Date.now() + 8000;
      let error: string | undefined;
      while (error === undefined && Date.now() < end) {
        error = (await c.request({ type: "schedule_list" })).schedules[0]?.lastError;
        await quiet(100);
      }
      assert.ok(error, "the change reached the scheduler after a daemon start");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("watches a directory too, and rejects what it cannot watch in words", async () => {
    const { writeFileSync } = await import("node:fs");
    harness = await startDaemon();
    const { c, session } = await savedSession(harness);
    await assert.rejects(c.request({ type: "watch_add", session, path: `${harness.dir}/nope/x.md`, prompt: "p" }), /nope does not exist/);
    await assert.rejects(c.request({ type: "watch_add", session, path: "x.md", prompt: "   " }), /what should it say/);
    await assert.rejects(c.request({ type: "watch_add", session, path: "x.md", prompt: "p", events: "sometimes" as never }), /--on is "write"/);
    await assert.rejects(c.request({ type: "watch_add", session, path: "x.md", prompt: "p", cooldown: "0.1s" }), /--cooldown must be between 1s and 10m/);
    await assert.rejects(c.request({ type: "watch_add", session, path: "x.md", prompt: "p", cooldown: "soon" }), /--cooldown/);
    await assert.rejects(c.request({ type: "watch_add", session, path: `${harness.dir}/x/`, prompt: "p" }), /not an existing directory/);
    assert.deepEqual((await c.request({ type: "schedule_list" })).schedules, [], "a refused watch leaves nothing behind");
    const added = await c.request({ type: "watch_add", session, path: `${harness.dir}/`, prompt: "something changed here", cooldown: "1s" });
    assert.match(added.schedule.when, /^on change: .*\/$/, "a directory is shown with its trailing slash");
    writeFileSync(`${harness.dir}/new-file.txt`, "x");
    await until(() => fires(c) === 1);
  });
});
