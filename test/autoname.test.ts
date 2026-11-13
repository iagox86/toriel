import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { AutoNamer, cleanTitle, firstRequest, TITLE_MAX } from "../src/daemon-autoname.ts";
import { DaemonNaming } from "../src/daemon-naming.ts";
import type { ClientHub } from "../src/daemon-hub.ts";
import { SessionRegistry } from "../src/daemon-session.ts";

function sessionFile(messages: Array<[string, string]>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-autoname-"));
  const file = path.join(dir, "s.jsonl");
  const lines = [JSON.stringify({ type: "session", version: 3, id: "11111111-1111-4111-8111-111111111111", timestamp: new Date().toISOString(), cwd: dir })];
  let parent: string | null = null;
  messages.forEach(([role, text], i) => {
    const id = `m${i}`;
    lines.push(JSON.stringify({ type: "message", id, parentId: parent, timestamp: new Date().toISOString(), message: { role, content: text, timestamp: Date.now() } }));
    parent = id;
  });
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

function setup(generate: (request: string) => Promise<string>, over: { enabled?: () => boolean } = {}) {
  const registry = new SessionRegistry();
  const hub = { broadcastSessions: () => {} } as unknown as ClientHub;
  const naming = new DaemonNaming(registry, hub, { sleep: async () => {} });
  const logs: string[] = [];
  const namer = new AutoNamer(naming, { generate, log: (l) => logs.push(l), ...over });
  const session = (file?: string) => {
    const s = registry.create("/tmp", file);
    return s;
  };
  return { registry, naming, namer, logs, session };
}

describe("cleanTitle", () => {
  it("keeps one plain line, without quotes, a label, markdown or a final period", () => {
    assert.equal(cleanTitle('"Fix the login bug."'), "Fix the login bug");
    assert.equal(cleanTitle("Title: Fix login\nbecause reasons"), "Fix login");
    assert.equal(cleanTitle("\n\n**Refactor naming**\n"), "Refactor naming");
    assert.equal(cleanTitle("# Plan the release"), "Plan the release");
    assert.equal(cleanTitle("   "), "");
  });

  it("caps a long title", () => {
    const out = cleanTitle("word ".repeat(50));
    assert.ok(out.length <= TITLE_MAX);
    assert.ok(out.endsWith("..."));
  });
});

describe("firstRequest", () => {
  it("is the first user message that is real text, skipping /commands and !commands", () => {
    const file = sessionFile([
      ["user", "/model sonnet"],
      ["user", "!ls"],
      ["user", "  why   does\nthe build fail? "],
      ["assistant", "because"],
      ["user", "later"],
    ]);
    assert.equal(firstRequest(file), "why does the build fail?");
  });

  it("is undefined when there is no such message yet", () => {
    assert.equal(firstRequest(sessionFile([["user", "/help"]])), undefined);
  });
});

describe("AutoNamer", () => {
  it("names an unnamed session from its first message, through the naming authority", async () => {
    const seen: string[] = [];
    const t = setup(async (request) => {
      seen.push(request);
      return '"Fix build"';
    });
    const s = t.session(sessionFile([["user", "the build fails on main"], ["assistant", "ok"]]));
    // no child and no real file entries to write through pi here: the claim is what matters
    await t.namer.onSettled(s).catch(() => {});
    assert.deepEqual(seen, ["the build fails on main"]);
    assert.equal(s.wantedName, "Fix build");
    assert.equal(s.nameSource, "auto");
  });

  it("is unique against other sessions' names", async () => {
    const t = setup(async () => "Fix build");
    const other = t.session();
    t.naming.claim(other, "Fix build", { source: "user" });
    const s = t.session(sessionFile([["user", "x"]]));
    await t.namer.onSettled(s);
    assert.equal(s.wantedName, "Fix build #2");
  });

  it("tries a session once, even when the model fails, and logs rather than throws", async () => {
    let calls = 0;
    const t = setup(async () => {
      calls++;
      throw new Error("model not found");
    });
    const s = t.session(sessionFile([["user", "hello there"]]));
    await t.namer.onSettled(s);
    await t.namer.onSettled(s);
    assert.equal(calls, 1);
    assert.equal(s.wantedName, undefined);
    assert.match(t.logs.join("\n"), /auto-name for session \d+ failed: model not found/);
  });

  it("leaves a session alone that is named, or was named while the model thought", async () => {
    let release: (title: string) => void = () => {};
    const t = setup(() => new Promise((resolve) => (release = resolve)));
    const named = t.session(sessionFile([["user", "a"]]));
    named.sessionName = "Mine";
    await t.namer.onSettled(named);
    assert.equal(named.wantedName, undefined);

    const racing = t.session(sessionFile([["user", "b"]]));
    const done = t.namer.onSettled(racing);
    t.naming.claim(racing, "Chosen by hand", { source: "user" });
    release("Auto title");
    await done;
    assert.equal(racing.wantedName, "Chosen by hand");
  });

  it("does nothing when disabled, without a file, or with only /commands so far", async () => {
    let calls = 0;
    const gen = async () => {
      calls++;
      return "T";
    };
    const off = setup(gen, { enabled: () => false });
    await off.namer.onSettled(off.session(sessionFile([["user", "hi"]])));
    const on = setup(gen);
    await on.namer.onSettled(on.session());
    const s = on.session(sessionFile([["user", "/help"]]));
    await on.namer.onSettled(s);
    assert.equal(calls, 0);
    // the first real message comes later: now it is tried
    fs.appendFileSync(s.sessionFile as string, `${JSON.stringify({ type: "message", id: "z", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "real", timestamp: 1 } })}\n`);
    await on.namer.onSettled(s);
    assert.equal(calls, 1);
  });
});
