import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { clearTransient, viewFromHistory } from "../src/resync.ts";
import { newView, noteRow } from "../src/transcript.ts";
import type { Item } from "../src/transcript.ts";

const item = (n: string) => ({ kind: "user", component: {} as never, n }) as unknown as Item;

function stale() {
  const v = newView();
  v.items = [item("old")];
  v.activity = { label: "working", since: 1 };
  v.queue = ["queued"];
  v.dialog = { id: "d", method: "confirm" } as never;
  v.echoes = [{ text: "hi", item: item("echo") as never }];
  return v;
}

describe("viewFromHistory", () => {
  it("replaces the items wholesale and drops all transient state after a reconnect", () => {
    const v = viewFromHistory(stale(), [item("new")], true);
    assert.equal(v.items.length, 1);
    assert.equal((v.items[0] as unknown as { n: string }).n, "new");
    assert.equal(v.activity, undefined);
    assert.deepEqual(v.queue, []);
    assert.equal(v.dialog, undefined);
    assert.deepEqual(v.echoes, []);
  });

  it("keeps what raced ahead of the replay on a live connection", () => {
    const v = viewFromHistory(stale(), [item("new")], false);
    assert.equal(v.activity?.label, "working");
    assert.deepEqual(v.queue, ["queued"]);
    assert.ok(v.dialog);
    assert.equal(v.echoes.length, 1);
    assert.equal(v.items.length, 2);
  });

  it("puts back the rows toriel added (a grant answered a prompt), which pi's history does not have", () => {
    const old = stale();
    const note = noteRow("allowed by permission grant #3: /p/a.md");
    old.notes = [note];
    const v = viewFromHistory(old, [item("new")], false);
    assert.ok(v.items.includes(note));
    assert.deepEqual(v.notes, [note]);
    assert.equal(viewFromHistory(old, [item("new")], true).items.includes(note), false, "a reconnect starts clean");
  });
});

describe("noteRow", () => {
  it("is a dim 'toriel:' row, so it reads as the daemon's, not the model's", () => {
    const row = noteRow("allowed by permission grant #3: /p/a.md");
    assert.equal(row.kind, "other");
    assert.match(stripTerminalSequences(row.component.render(80).join("\n")), /toriel: allowed by permission grant #3: \/p\/a\.md/);
  });
});

describe("clearTransient", () => {
  it("empties activity, queue, dialog and echoes but keeps the items", () => {
    const v = stale();
    clearTransient(v);
    assert.equal(v.items.length, 1);
    assert.equal(v.activity, undefined);
    assert.deepEqual(v.queue, []);
    assert.equal(v.dialog, undefined);
    assert.deepEqual(v.echoes, []);
  });
});
