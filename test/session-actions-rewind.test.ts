import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { Host } from "../src/host.ts";
import { SessionActions } from "../src/session-actions.ts";

const msg = (id: string, role: string, text: string) => ({ type: "message", id, timestamp: new Date().toISOString(), message: { role, content: text, timestamp: 1 } });

function sessionFile(lines: Array<Record<string, unknown>>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-rw-"));
  const file = path.join(dir, "s.jsonl");
  fs.writeFileSync(file, `${[{ type: "session", version: 3, id: "s", timestamp: new Date().toISOString(), cwd: dir }, ...lines].map((l) => JSON.stringify(l)).join("\n")}\n`);
  return file;
}

function setup(file: string, view: Record<string, unknown> | undefined, meta: Record<string, unknown> | undefined = { id: 1, streaming: false }) {
  const reloaded: string[] = [];
  const notices: string[] = [];
  const opened: Array<Array<{ text: string }>> = [];
  const host = {
    viewing: file,
    views: new Map(view ? [[file, { echoes: [], queue: [], ...view }]] : []),
    metaForPath: () => meta,
    reloadView: (k: string) => {
      reloaded.push(k);
    },
    notify: (m: string) => {
      notices.push(m);
    },
    rewindPicker: { open: (t: Array<{ text: string }>) => opened.push(t) },
    tui: { requestRender() {} },
  };
  const open = () => (new SessionActions(host as unknown as Host) as unknown as { openRewind(): void }).openRewind();
  return { open, reloaded, notices, opened };
}

describe("opening the rewind picker (ticket 127)", () => {
  // the view saw two messages; another instance appended a second turn to the file
  const foreign = [msg("a", "user", "mine"), msg("b", "assistant", "ok"), msg("c", "user", "from the other instance"), msg("d", "assistant", "hi")];

  it("re-reads the transcript from the file first when the file holds messages the view never showed", () => {
    const t = setup(sessionFile(foreign), { messages: 2 });
    t.open();
    assert.equal(t.reloaded.length, 1);
    assert.match(t.notices[0] ?? "", /2 messages this transcript had not shown/);
    assert.equal(t.opened[0]?.length, 2, "the picker still opens, now over what is on screen");
  });

  it("leaves a view that agrees with its file alone", () => {
    const t = setup(sessionFile(foreign), { messages: 4 });
    t.open();
    assert.deepEqual(t.reloaded, []);
    assert.deepEqual(t.notices, []);
  });

  it("leaves a running session alone, since its file lags the stream, and a view with no count", () => {
    const file = sessionFile(foreign);
    for (const [view, meta] of [
      [{ messages: 2, activity: { label: "working", since: 0 } }, undefined],
      [{ messages: 2 }, { id: 1, streaming: true }],
      [{ messages: 2, echoes: [{}] }, undefined],
      [{}, undefined],
    ] as const) {
      const t = setup(file, view, meta);
      t.open();
      assert.deepEqual(t.reloaded, []);
    }
  });
});
