import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { parseCommandLine } from "../src/cli.ts";
import { SESSION_COMMANDS } from "../src/commands.ts";
import { PublishedStore } from "../src/published.ts";
import { buildStatusLine } from "../src/status.ts";
import type { SessionMeta } from "../src/shared.ts";
import { rowBadge } from "../src/switcher.ts";
import { type Harness, startDaemon } from "./helpers.ts";

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("PublishedStore", () => {
  it("sets and clears, reports whether anything changed, and survives a restart", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "published-"));
    try {
      const file = path.join(dir, "sub", "published.json");
      const a = new PublishedStore(file, () => 42);
      a.load();
      assert.equal(a.has("s1"), false);
      assert.equal(a.set("s1", true), true);
      assert.equal(a.set("s1", true), false);
      assert.equal(a.set("s2", true), true);
      assert.equal(a.set("s2", false), true);
      assert.equal(a.set("s2", false), false);

      const b = new PublishedStore(file);
      b.load();
      assert.deepEqual(b.ids(), ["s1"]);
      assert.equal(b.has("s1"), true);
      assert.equal(b.has(undefined), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parks a published session so using it again publishes it, but not an unpublished one, and an explicit choice forgets it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "published-"));
    try {
      const file = path.join(dir, "published.json");
      const a = new PublishedStore(file);
      a.load();
      assert.equal(a.park("never-published"), false);
      assert.equal(a.takeResume("never-published"), false);
      a.set("s1", true);
      assert.equal(a.park("s1"), true);
      assert.equal(a.has("s1"), false);
      assert.equal(a.hasResume("s1"), true);
      const b = new PublishedStore(file);
      b.load();
      assert.equal(b.hasResume("s1"), true, "kept across a restart");
      assert.equal(b.takeResume("s1"), true);
      assert.equal(b.has("s1"), true);
      assert.equal(b.takeResume("s1"), false, "once");
      b.park("s1");
      b.set("s1", false); // the user's own /publish off while parked
      assert.equal(b.hasResume("s1"), false);
      assert.equal(b.takeResume("s1"), false);
      b.set("s2", true);
      b.park("s2");
      b.set("s2", true); // publishing again by hand
      assert.equal(b.hasResume("s2"), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("starts empty from a missing or damaged file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "published-"));
    try {
      const file = path.join(dir, "published.json");
      fs.writeFileSync(file, "not json");
      const s = new PublishedStore(file);
      s.load();
      assert.deepEqual(s.ids(), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("/publish", () => {
  it("parses with and without off", () => {
    const args = (line: string) => {
      const r = parseCommandLine(SESSION_COMMANDS, line);
      return r.kind === "run" ? { args: r.call.args } : undefined;
    };
    assert.deepEqual(args("/publish"), { args: [] });
    assert.deepEqual(args("/publish off"), { args: ["off"] });
  });
});

function meta(over: Partial<SessionMeta> = {}): SessionMeta {
  return { id: 1, cwd: "/w", model: "prov/model-x", messageCount: 0, streaming: false, compacting: false, dead: false, active: true, pendingDialog: false, attachedToYou: true, attachedElsewhere: false, ...over };
}

describe("where a published session shows", () => {
  const stats = { running: 0, waiting: 0, tokens: 0, cost: 0 };

  it("the status line says chat, and says the bridge is down when it is", () => {
    const line = (m: SessionMeta) => plain(buildStatusLine({ switcherOpen: false, viewing: "k", meta: m, stats, flash: "", width: 200 }));
    assert.doesNotMatch(line(meta()), /chat/);
    assert.match(line(meta({ published: true, chatUp: true })), /chat/);
    assert.doesNotMatch(line(meta({ published: true, chatUp: true })), /bridge down/);
    assert.match(line(meta({ published: true, chatUp: false })), /chat \(bridge down\)/);
  });

  it("the switcher row carries a chat badge after the schedule's", () => {
    const now = new Date();
    assert.equal(rowBadge({}, now), "");
    assert.equal(rowBadge({ published: true }, now), " chat");
    assert.match(rowBadge({ published: true, schedules: 1, nextFire: now.getTime() + 60_000 }, now), /^ @.* chat$/);
  });
});

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

describe("daemon: parking a published session (ticket 269)", () => {
  async function publishedSession(h: Harness) {
    const c = await h.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: h.dir });
    await c.request({ type: "prompt", session: sessionId, message: "hi" });
    let uuid: string | undefined;
    for (let i = 0; i < 80 && !uuid; i++) {
      uuid = c.sessions().find((x) => x.id === sessionId)?.sessionId;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(uuid);
    await c.waitFor((m) => m.type === "event" && m.event?.type === "agent_settled");
    await c.request({ type: "publish", sessionId: uuid, on: true });
    return { c, session: sessionId, uuid };
  }

  it("unpublishes on park and publishes again when the session is next used", async () => {
    harness = await startDaemon();
    const { c, session, uuid } = await publishedSession(harness);
    await c.request({ type: "publish", sessionId: uuid, on: false, resume: true });
    await c.waitFor((m) => m.type === "sessions" && m.sessions.some((x: SessionMeta) => x.id === session && !x.published));
    // parked, it stays unpublished; using it publishes it again
    await c.request({ type: "prompt", session, message: "back again" });
    await c.waitFor((m) => m.type === "sessions" && m.sessions.some((x: SessionMeta) => x.id === session && x.published === true));
  });

  it("/park -u publishes it again at once, but only if it was published when parked", async () => {
    harness = await startDaemon();
    const { c, session, uuid } = await publishedSession(harness);
    await c.request({ type: "publish", sessionId: uuid, on: false, resume: true });
    assert.equal((await c.request({ type: "publish", sessionId: uuid, unpark: true })).published, true);
    await c.waitFor((m) => m.type === "sessions" && m.sessions.some((x: SessionMeta) => x.id === session && x.published === true));
    await c.request({ type: "publish", sessionId: uuid, on: false }); // the user's own /publish off
    assert.equal((await c.request({ type: "publish", sessionId: uuid, unpark: true })).published, false);
  });

  it("a session switched off by hand before it was parked stays off when it is used", async () => {
    harness = await startDaemon();
    const { c, session, uuid } = await publishedSession(harness);
    await c.request({ type: "publish", sessionId: uuid, on: false });
    await c.request({ type: "publish", sessionId: uuid, on: false, resume: true });
    c.messages.length = 0;
    await c.request({ type: "prompt", session, message: "again" });
    await c.waitFor((m) => m.type === "event" && m.event?.type === "agent_settled");
    assert.equal(c.sessions().find((x) => x.id === session)?.published, undefined);
  });
});

describe("daemon: publish (ticket 269)", () => {
  it("sets, toggles and clears the flag, shows it in the session list, and /delete clears it", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.request({ type: "prompt", session: sessionId, message: "hi" });
    let uuid: string | undefined;
    for (let i = 0; i < 80 && !uuid; i++) {
      uuid = c.sessions().find((s) => s.id === sessionId)?.sessionId;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(uuid, "the session got an id");
    const published = () => c.sessions().find((s) => s.id === sessionId)?.published;

    assert.equal(published(), undefined);
    assert.equal((await c.request({ type: "publish", sessionId: uuid, on: true })).published, true);
    await c.waitFor((m) => m.type === "sessions" && m.sessions.some((s: SessionMeta) => s.id === sessionId && s.published === true && s.chatUp === false));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(harness.dir, "published.json"), "utf8")).published[uuid] > 0, true);

    // no argument toggles
    assert.equal((await c.request({ type: "publish", sessionId: uuid })).published, false);
    await c.waitFor((m) => m.type === "sessions" && m.sessions.some((s: SessionMeta) => s.id === sessionId && s.published === undefined));

    await c.request({ type: "publish", sessionId: uuid, on: true });
    await c.request({ type: "delete", session: sessionId });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(harness.dir, "published.json"), "utf8")).published, {});
  });
});
