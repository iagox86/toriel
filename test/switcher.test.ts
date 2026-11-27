import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type SwitcherSession, Switcher } from "../src/switcher.ts";
import { attention } from "../src/theme.ts";
import { WAITING_NOTE } from "../src/session-tree.ts";

const session = (key: string, group: string | undefined, state: SwitcherSession["state"] = "idle"): SwitcherSession =>
  ({ key, name: key, group, state, age: "1h", ageMs: 3600_000 }) as SwitcherSession;

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

function build(collapsed: string[]): Switcher {
  const sw = new Switcher();
  sw.groups = ["Work"];
  sw.sessions = [session("a", undefined), session("b", "Work"), session("c", "Work", "streaming")];
  sw.collapsed = new Set(collapsed);
  sw.refresh();
  return sw;
}

describe("switcher group folding", () => {
  it("shows a group's sessions under an open-arrow header", () => {
    const text = build([]).render(100).map(strip).join("\n");
    assert.match(text, /▾ Work/);
    assert.match(text, /\bb\b/);
  });

  it("hides a collapsed group's sessions and puts a summary next to its header", () => {
    const lines = build(["Work"]).render(100).map(strip);
    const header = lines.find((l) => l.includes("Work"));
    assert.match(header ?? "", /▸ Work\s+2 sessions - 1 working - 1 idle - newest 1h/);
    assert.ok(!lines.some((l) => /^\S*\s*[*·-]\s+b\b/.test(l)), "session b should be hidden");
  });

  it("keeps the hidden sessions in the order list so reordering does not forget them", () => {
    const sw = build(["Work"]);
    assert.deepEqual(sw.sessions.map((s) => s.key), ["a", "b", "c"]);
  });

  it("moves the cursor to the header when its session gets hidden", () => {
    const sw = build([]);
    sw.selectedKey = "b";
    sw.refresh();
    sw.collapsed = new Set(["Work"]);
    sw.refresh();
    assert.equal(sw.current(), undefined);
    assert.equal(sw.currentHeaderTitle(), "Work");
  });

  it("shows every session while a filter is on", () => {
    const sw = build(["Work"]);
    sw.filterNote = "filter: x";
    sw.refresh();
    assert.match(sw.render(100).map(strip).join("\n"), /\bb\b/);
  });

  it("still folds groups, and still lists empty ones, while only a hidden-sessions note is showing (ticket 248)", () => {
    const sw = new Switcher();
    sw.groups = ["Work", "Empty"];
    sw.sessions = [session("a", undefined), session("b", "Work"), session("c", "Work")];
    sw.collapsed = new Set(["Work"]);
    sw.hiddenNote = "3 outside sessions hidden  -  /external show";
    sw.refresh();
    const lines = sw.render(100).map(strip);
    assert.ok(lines.some((l) => l.includes("3 outside sessions hidden")), "the note is shown");
    assert.match(lines.find((l) => l.includes("Work")) ?? "", /▸ Work\s+2 sessions/);
    assert.ok(!lines.some((l) => /\bb\b/.test(l) && !l.includes("outside")), "session b is folded away");
    assert.ok(lines.some((l) => l.includes("Empty")), "an empty group is still listed");
  });

  it("tells whether the highlighted header is folded, and nothing for a session row", () => {
    const sw = build(["Work"]);
    assert.equal(sw.currentHeaderFolded(), undefined); // the cursor starts on session a
    sw.move(1); // the Work header, folded
    assert.equal(sw.currentHeaderFolded(), true);
    const open = build([]);
    open.move(1);
    assert.equal(open.currentHeaderFolded(), false);
  });

  it("gives an empty group the same arrow and a bold title, so it cannot pass for a session", () => {
    const sw = new Switcher();
    sw.groups = ["Empty"];
    sw.sessions = [session("a", undefined)];
    sw.refresh();
    const line = sw.render(60).find((l) => strip(l).includes("Empty")) ?? "";
    assert.match(strip(line), /\u25be Empty/);
    assert.ok(line.includes("\x1b[1m"), "header should be bold");
  });

  it("marks a compacting session with c and a compacting summary", () => {
    const sw = new Switcher();
    sw.sessions = [session("k", undefined, "compacting")];
    sw.refresh();
    const lines = sw.render(100).map(strip);
    const row = lines.find((l) => l.startsWith("c  k")) ?? "";
    assert.ok(row, `no row with the c marker: ${JSON.stringify(lines)}`);
    assert.match(row, /compacting/);
  });
});

describe("switcher row markers", () => {
  it("marks a badly ended subagent with the dead glyph in the attention style, and still gives the bang to one waiting on permission", () => {
    const sw = new Switcher();
    sw.sessions = [
      { ...session("d", undefined), subagentFail: true },
      { ...session("e", undefined), note: WAITING_NOTE, subagentFail: true },
    ];
    sw.refresh();
    const raw = sw.render(100);
    const failLine = raw.find((l) => strip(l).startsWith("x  d")) ?? "";
    assert.ok(failLine, `no row with the x marker: ${JSON.stringify(raw.map(strip))}`);
    assert.ok(failLine.includes(attention("x")), "the x is drawn in the attention style");
    const waitLine = raw.find((l) => strip(l).startsWith("!  e")) ?? "";
    assert.ok(waitLine, `no row with the ! marker: ${JSON.stringify(raw.map(strip))}`);
  });
});

describe("switcher spawn anchor (ticket 326)", () => {
  it("with no selection it anchors the first shown session (refresh defaults there)", () => {
    assert.deepEqual(build([]).spawnAnchor(), { kind: "session", group: undefined });
  });

  it("an empty list has no anchor", () => {
    assert.equal(new Switcher().spawnAnchor(), undefined);
  });

  it("a highlighted session row anchors its own group, an ungrouped one none", () => {
    const sw = build([]);
    sw.selectedKey = "b";
    sw.refresh();
    assert.deepEqual(sw.spawnAnchor(), { kind: "session", group: "Work" });
    sw.selectedKey = "a";
    sw.refresh();
    assert.deepEqual(sw.spawnAnchor(), { kind: "session", group: undefined });
  });

  it("a highlighted group header anchors that group", () => {
    const sw = build(["Work"]);
    sw.selectedKey = "b";
    sw.refresh(); // the hidden session's header stands in
    assert.deepEqual(sw.spawnAnchor(), { kind: "header", title: "Work" });
  });
});
