import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import { type Viewport, WindowedContainer } from "../src/windowed-container.ts";

class Item implements Component {
  renders = 0;
  height: number;
  readonly id: number;
  constructor(id: number, height = 3) {
    this.id = id;
    this.height = height;
  }
  render(): string[] {
    this.renders++;
    return Array.from({ length: this.height }, (_, k) => `item ${this.id} line ${k}`);
  }
  invalidate(): void {}
}

function build(count: number, vp: Viewport | undefined, height = 3) {
  const items = Array.from({ length: count }, (_, i) => new Item(i, height));
  const box = new WindowedContainer();
  for (const item of items) {
    box.addChild(item);
  }
  let view = vp;
  box.viewport = () => view;
  const shifts: number[] = [];
  box.onShift = (n) => shifts.push(n);
  return { box, items, shifts, look: (v: Viewport | undefined) => (view = v) };
}

const rendered = (items: Item[]) => items.filter((i) => i.renders > 0).length;

describe("WindowedContainer (ticket 225)", () => {
  it("renders everything, like a plain container, when it does not know the window", () => {
    const { box, items } = build(50, undefined);
    const lines = box.render(80);
    assert.equal(lines.length, 150);
    assert.equal(rendered(items), 50);
    assert.equal(lines[149], "item 49 line 2");
  });

  it("pinned to the end it draws only the last screens, and the rest is blank at the same total height", () => {
    const { box, items } = build(1000, { top: 0, height: 20, following: true });
    box.render(80); // first frame: heights unknown, estimated
    const lines = box.render(80);
    assert.ok(rendered(items) < 40, `drew ${rendered(items)} of 1000`);
    assert.equal(lines.at(-1), "item 999 line 2");
    assert.equal(lines.at(-20), "item 993 line 1");
    assert.ok(items[0]?.renders === 0, "an item far above the window is never asked");
    assert.equal(box.render(80).length, lines.length, "the total does not move from frame to frame");
  });

  it("scrolled up it draws around the window, and reports how far the items above it moved from their estimates", () => {
    const { box, items, shifts, look } = build(500, { top: 0, height: 20, following: true }, 6);
    box.render(80);
    box.render(80); // now the last items are known to be 6 lines, the rest estimated as 6 too
    for (const item of items) {
      item.renders = 0;
    }
    look({ top: 1200, height: 20, following: false });
    const lines = box.render(80);
    assert.equal(lines[1200], "item 200 line 0");
    assert.ok(rendered(items) < 40);
    assert.ok(items[200]?.renders === 1 && items[0]?.renders === 0 && items[499]?.renders === 0);
    assert.deepEqual(shifts, [], "estimates were right, nothing to correct");

    // the items above turn out taller than the average: the viewer must be moved down by the difference to stay on item 200
    for (const item of items.slice(0, 200)) {
      item.height = 8;
    }
    look({ top: 1200, height: 20, following: false });
    box.render(80); // draws items near 200 (still 5 lines each, only those within a screen above were redrawn)
    look({ top: 600, height: 20, following: false });
    box.render(80); // scrolled up into items that really are 8 lines
    assert.ok(shifts.some((s) => s > 0), `expected a positive correction, got ${JSON.stringify(shifts)}`);
  });

  it("a toggle that invalidates everything costs only the items in view", () => {
    const { box, items, look } = build(2000, { top: 0, height: 30, following: true });
    box.render(80);
    box.render(80);
    box.invalidate();
    for (const item of items) {
      item.renders = 0;
    }
    look({ top: 0, height: 30, following: true });
    box.render(80);
    assert.ok(rendered(items) <= 40, `redrew ${rendered(items)}`);
  });

  it("keeps the mouse layout in step with the lines, so a click lands on the item drawn there", () => {
    const { box } = build(100, { top: 0, height: 20, following: true });
    box.render(80);
    const lines = box.render(80);
    const layout = (box as unknown as { mouseLayout: { width: number; children: Array<{ height: number }> } }).mouseLayout;
    assert.equal(layout.width, 80);
    assert.equal(layout.children.reduce((n, c) => n + c.height, 0), lines.length);
  });

  it("fills the screen from the end even when the unseen items are much shorter than estimated", () => {
    const { box, items } = build(300, { top: 0, height: 40, following: true }, 1);
    box.render(80);
    const lines = box.render(80);
    assert.equal(lines.at(-1), "item 299 line 0");
    assert.equal(lines.slice(-40).every((l) => l !== ""), true, "the last screen has no blank rows");
    assert.ok(rendered(items) < 150);
  });
});
