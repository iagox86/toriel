import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { pruneSessionState, uuidOfFileName } from "../src/state-prune.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

describe("state-prune", () => {
  let dir: string;
  let agents: string;
  let handled: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-prune-"));
    agents = path.join(dir, "session-agents.json");
    handled = path.join(dir, "handled-files.json");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads the uuid from a session or trash file name", () => {
    assert.equal(uuidOfFileName(`/s/2026-11-01T10-00-00-000Z_${A}.jsonl`), A);
    assert.equal(uuidOfFileName(`/trash/1700000000-2026-11-01T10-00-00-000Z_${A}.jsonl`), A);
    assert.equal(uuidOfFileName("/s/notes.jsonl"), undefined);
  });

  it("drops profiles of sessions that are neither in place nor in the trash", () => {
    fs.writeFileSync(agents, JSON.stringify({ [A]: { name: "a" }, [B]: { name: "b" }, [C]: { name: "c" } }));
    const live = path.join(dir, `2026_${A}.jsonl`);
    const result = pruneSessionState({ files: [{ path: live, id: A }], trashed: [`/trash/2026_${B}.jsonl`] }, agents, handled);
    assert.equal(result.agents, 1);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(agents, "utf8"))).sort(), [A, B]);
  });

  it("drops handled paths that no longer exist", () => {
    const here = path.join(dir, "here.jsonl");
    fs.writeFileSync(here, "");
    fs.writeFileSync(handled, JSON.stringify([here, path.join(dir, "gone.jsonl")]));
    const result = pruneSessionState({ files: [{ path: here }], trashed: [] }, agents, handled);
    assert.equal(result.handled, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(handled, "utf8")), [here]);
  });

  it("does nothing when the listing is empty (probably a misconfigured sessions dir)", () => {
    fs.writeFileSync(agents, JSON.stringify({ [A]: { name: "a" } }));
    const result = pruneSessionState({ files: [], trashed: [] }, agents, handled);
    assert.deepEqual(result, { agents: 0, handled: 0 });
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(agents, "utf8"))), [A]);
  });

  it("leaves the files alone when there is nothing to drop", () => {
    fs.writeFileSync(agents, JSON.stringify({ [A]: { name: "a" } }));
    const before = fs.statSync(agents).mtimeMs;
    pruneSessionState({ files: [{ path: `/x/2026_${A}.jsonl`, id: A }], trashed: [] }, agents, handled);
    assert.equal(fs.statSync(agents).mtimeMs, before);
  });
});
