import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { historyLength, historyOf } from "../src/daemon-history.ts";
import type { DaemonSession } from "../src/daemon-session.ts";

function sessionFile(lines: Array<Record<string, unknown>>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-dhist-"));
  const file = path.join(dir, "s.jsonl");
  const all = [{ type: "session", version: 3, id: "s", timestamp: new Date().toISOString(), cwd: dir }, ...lines];
  fs.writeFileSync(file, `${all.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return file;
}

const msg = (id: string, role: string) => ({ type: "message", id, message: { role, content: "x", timestamp: 1 } });

/** A session whose pi child holds `live` messages; `getMessages` is counted, because the digest must not call it. */
function stub(live: number, file: string | undefined, streaming = false) {
  const calls = { getMessages: 0 };
  const s = {
    streaming,
    sessionFile: file,
    child: {
      getState: async () => ({ messageCount: live }),
      getMessages: async () => {
        calls.getMessages++;
        return Array.from({ length: live }, () => ({ role: "user" }));
      },
    },
  } as unknown as DaemonSession;
  return { s, calls };
}

describe("historyLength (the settle digest, ticket 181)", () => {
  it("is pi's own count for a session that was never compacted, without fetching the messages", async () => {
    const file = sessionFile([msg("a", "system"), msg("b", "user"), msg("c", "assistant")]);
    const { s, calls } = stub(3, file);
    assert.equal(await historyLength(s), 3);
    assert.equal(await historyLength(s), (await historyOf(s)).length);
    assert.equal(calls.getMessages, 1, "only the historyOf call above fetched");
  });

  it("is the file's length, marker included, once the file holds a compaction", async () => {
    const file = sessionFile([
      msg("a", "user"),
      msg("b", "assistant"),
      msg("c", "user"),
      { type: "compaction", id: "d", summary: "s", firstKeptEntryId: "c", tokensBefore: 9, timestamp: new Date().toISOString() },
      msg("e", "assistant"),
    ]);
    // pi's live list after compacting: the summary plus what it kept, shorter than the file's
    const { s, calls } = stub(3, file);
    assert.equal(await historyLength(s), 5);
    assert.equal(await historyLength(s), (await historyOf(s)).length);
    assert.equal(calls.getMessages, 1);
  });

  it("is pi's count while a run is streaming, with no file, or when the file cannot be read", async () => {
    const file = sessionFile([msg("a", "user")]);
    assert.equal(await historyLength(stub(7, file, true).s), 7);
    assert.equal(await historyLength(stub(7, undefined).s), 7);
    assert.equal(await historyLength(stub(7, path.join(os.tmpdir(), "toriel-no-such-file.jsonl")).s), 7);
  });

  it("does not take a compaction word inside a message for a compaction entry", async () => {
    const file = sessionFile([{ type: "message", id: "a", message: { role: "user", content: 'the "type": "compaction" entry', timestamp: 1 } }]);
    assert.equal(await historyLength(stub(1, file).s), 1);
  });
});
