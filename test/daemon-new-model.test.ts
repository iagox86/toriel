// /new -m: spawn's `model` (ticket 247). The fake pi lists fake/fake-model, fake/fake-big and other/fake-big.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { afterEach, describe, it } from "node:test";
import { type Harness, startDaemon } from "./helpers.ts";

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

/** Spawn with `extra`, wait for the history, and read the argv the fake pi recorded. */
async function spawnArgv(h: Harness, extra: Record<string, unknown>): Promise<string[]> {
  const c = await h.connect();
  const r = await c.request({ type: "spawn", cwd: h.dir, ...extra });
  await c.waitFor((m) => m.type === "history" && m.session === r.sessionId);
  const f = c.sessions().find((x) => x.id === r.sessionId)?.sessionFile;
  return JSON.parse(fs.readFileSync(`${f}.argv.json`, "utf8")) as string[];
}
const flagged = (argv: string[], flag: string): string[] => argv.flatMap((a, i) => (a === flag ? [argv[i + 1] as string] : []));

describe("daemon: /new -m (ticket 247)", () => {
  it("starts the first session, with nothing running to ask, on a full provider/id as given", async () => {
    harness = await startDaemon();
    const argv = await spawnArgv(harness, { model: "fake/fake-big" });
    assert.deepEqual(flagged(argv, "--model"), ["fake/fake-big"]);
  });

  it("refuses a bare name when no session is running to look it up in, and creates nothing", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    await assert.rejects(c.request({ type: "spawn", cwd: harness.dir, model: "fake-big" }), /no running session to look "fake-big" up in/);
    assert.equal(c.sessions().length, 0);
  });

  it("takes what /model takes once a session is running: a bare id, words, an exact provider/id", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const first = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history" && m.session === first.sessionId);
    const a = await spawnArgv(harness, { model: "fake-model" });
    assert.deepEqual(flagged(a, "--model"), ["fake/fake-model"], "a bare id that only one provider has");
    const b = await spawnArgv(harness, { model: "other big" });
    assert.deepEqual(flagged(b, "--model"), ["other/fake-big"], "words that pick one model");
    const d = await spawnArgv(harness, { model: "other/fake-big" });
    assert.deepEqual(flagged(d, "--model"), ["other/fake-big"]);
  });

  it("errors on an unknown or ambiguous model before anything is spawned", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const first = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history" && m.session === first.sessionId);
    const before = c.sessions().length;
    await assert.rejects(c.request({ type: "spawn", cwd: harness.dir, model: "fake/fake-bigg" }), /no model "fake\/fake-bigg" \(did you mean fake\/fake-big/);
    await assert.rejects(c.request({ type: "spawn", cwd: harness.dir, model: "fake-big" }), /"fake-big" matches 2 models: fake\/fake-big, other\/fake-big/);
    await assert.rejects(c.request({ type: "spawn", cwd: harness.dir, model: "  " }), /model is empty/);
    assert.equal(c.sessions().length, before);
  });

  it("does not pass the settings' default model as well, so pi sees one --model", async () => {
    harness = await startDaemon();
    const argv = await spawnArgv(harness, { model: "fake/fake-big" });
    assert.equal(flagged(argv, "--model").length, 1);
    assert.equal(flagged(argv, "--provider").length, 0);
  });

  it("only applies to a new session: one with a file is refused", async () => {
    harness = await startDaemon();
    const c = await harness.connect();
    const first = await c.request({ type: "spawn", cwd: harness.dir });
    await c.waitFor((m) => m.type === "history" && m.session === first.sessionId);
    const file = c.sessions().find((x) => x.id === first.sessionId)?.sessionFile;
    await assert.rejects(c.request({ type: "spawn", cwd: harness.dir, sessionFile: file, model: "fake/fake-big" }), /only be chosen for a new session/);
  });
});
