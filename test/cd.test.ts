import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { dirCompletions } from "../src/dir-completion.ts";
import { setSessionFileCwd, withHeaderCwd } from "../src/session-header.ts";
import { type Harness, type Msg, startDaemon } from "./helpers.ts";

describe("withHeaderCwd", () => {
  it("sets the cwd on the first line and leaves every other byte alone", () => {
    const rest = '{"type":"message","message":{"role":"user","content":"é  spaced"}}\n';
    const r = withHeaderCwd(`{"type":"session","id":"x","cwd":"/old"}\n${rest}`, "/new");
    assert.equal(r.previous, "/old");
    assert.equal(r.text, `{"type":"session","id":"x","cwd":"/new"}\n${rest}`);
  });

  it("adds a cwd to a header that had none", () => {
    assert.equal(withHeaderCwd('{"type":"session","id":"x"}\n', "/new").text, '{"type":"session","id":"x","cwd":"/new"}\n');
  });

  it("refuses a file that does not start with a session header", () => {
    assert.throws(() => withHeaderCwd('{"type":"message"}\n', "/new"), /session header/);
    assert.throws(() => withHeaderCwd("not json\n", "/new"), /session header/);
  });
});

describe("setSessionFileCwd", () => {
  it("rewrites the file in place and keeps its permissions", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-cd-"));
    const file = path.join(dir, "s.jsonl");
    fs.writeFileSync(file, '{"type":"session","cwd":"/old"}\nbody\n', { mode: 0o600 });
    assert.equal(setSessionFileCwd(file, "/new"), "/old");
    assert.equal(fs.readFileSync(file, "utf8"), '{"type":"session","cwd":"/new"}\nbody\n');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir), ["s.jsonl"]);
  });
});

describe("dirCompletions", () => {
  const tree = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-dirs-"));
    for (const d of ["alpha", "alps", "beta", ".hidden"]) {
      fs.mkdirSync(path.join(dir, d));
    }
    fs.writeFileSync(path.join(dir, "alfile"), "");
    return dir;
  };

  it("offers the subdirectories that continue the typed path, not files or hidden ones", () => {
    const dir = tree();
    assert.deepEqual(dirCompletions(`${dir}/al`).map((c) => c.value), [`${dir}/alpha/`, `${dir}/alps/`]);
    assert.deepEqual(dirCompletions(`${dir}/`).map((c) => c.value), [`${dir}/alpha/`, `${dir}/alps/`, `${dir}/beta/`]);
    assert.deepEqual(dirCompletions(`${dir}/.h`).map((c) => c.value), [`${dir}/.hidden/`]);
  });

  it("completes only absolute and ~ paths, and nothing for a missing directory", () => {
    assert.deepEqual(dirCompletions("src"), []);
    assert.deepEqual(dirCompletions(""), []);
    assert.deepEqual(dirCompletions("/no/such/dir/x"), []);
    assert.ok(dirCompletions("~/").every((c) => c.value.startsWith("~/")));
  });
});

describe("daemon: cd", () => {
  let harness: Harness | undefined;
  afterEach(async () => {
    await harness?.stop();
    harness = undefined;
  });
  const isSettled = (m: Msg) => m.type === "event" && m.event?.type === "agent_settled";

  async function savedSession() {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history" && m.session === sessionId);
    await c.request({ type: "prompt", session: sessionId, message: "hi" });
    await c.waitFor(isSettled);
    const meta = () => c.sessions().find((s) => s.id === sessionId);
    return { c, sessionId, meta, dir: harness.dir };
  }

  it("moves an idle session: the file's cwd, the session's cwd and the restarted child all follow", async () => {
    const { c, sessionId, meta, dir } = await savedSession();
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-cd-target-"));
    const file = meta()?.sessionFile as string;
    const r = await c.request({ type: "cd", session: sessionId, dir: target });
    assert.deepEqual([r.cwd, r.changed], [target, true]);
    assert.equal(meta()?.cwd, target);
    assert.equal((JSON.parse(fs.readFileSync(file, "utf8").split("\n")[0] as string) as { cwd: string }).cwd, target);
    assert.equal((JSON.parse(fs.readFileSync(`${file}.env.json`, "utf8")) as { cwd: string }).cwd, fs.realpathSync(target));
    assert.equal(meta()?.active, true);
    assert.notEqual(dir, target);
    // the conversation survives
    const history = await c.waitFor((m) => m.type === "history" && m.session === sessionId && JSON.stringify(m.messages).includes('"hi"'));
    assert.ok(history);
  });

  it("resolves a relative directory from the session's own, and says when nothing changes", async () => {
    const { c, sessionId, meta, dir } = await savedSession();
    fs.mkdirSync(path.join(dir, "sub"));
    assert.equal((await c.request({ type: "cd", session: sessionId, dir: "sub" })).cwd, path.join(dir, "sub"));
    assert.equal((await c.request({ type: "cd", session: sessionId, dir: ".." })).cwd, dir);
    assert.equal((await c.request({ type: "cd", session: sessionId, dir: "." })).changed, false);
    assert.equal(meta()?.cwd, dir);
  });

  it("refuses a missing directory, a file and an empty argument, and leaves the session where it was", async () => {
    const { c, sessionId, meta, dir } = await savedSession();
    await assert.rejects(c.request({ type: "cd", session: sessionId, dir: path.join(dir, "nope") }), /is not a directory/);
    fs.writeFileSync(path.join(dir, "afile"), "");
    await assert.rejects(c.request({ type: "cd", session: sessionId, dir: path.join(dir, "afile") }), /is not a directory/);
    await assert.rejects(c.request({ type: "cd", session: sessionId, dir: "  " }), /needs a directory/);
    assert.equal(meta()?.cwd, dir);
  });

  it("refuses a session with no messages yet", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const { sessionId } = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history" && m.session === sessionId);
    await assert.rejects(c.request({ type: "cd", session: sessionId, dir: os.tmpdir() }), /nothing to move yet/);
  });
});
