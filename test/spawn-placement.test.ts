import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applySpawnGroup, groupForSpawn } from "../src/spawn-placement.ts";
import type { GroupsFile } from "../src/groups.ts";

describe("groupForSpawn", () => {
  it("takes a group header's title", () => {
    assert.equal(groupForSpawn({ kind: "header", title: "Work" }), "Work");
  });

  it("takes a session row's group", () => {
    assert.equal(groupForSpawn({ kind: "session", group: "Work" }), "Work");
  });

  it("leaves the session ungrouped when nothing is highlighted", () => {
    assert.equal(groupForSpawn(undefined), undefined);
  });

  it("leaves the session ungrouped on the (ungrouped) pseudo-group", () => {
    assert.equal(groupForSpawn({ kind: "header", title: "(ungrouped)" }), undefined);
  });

  it("leaves the session ungrouped when the session has no group", () => {
    assert.equal(groupForSpawn({ kind: "session" }), undefined);
    assert.equal(groupForSpawn({ kind: "session", group: "" }), undefined);
  });
});

describe("applySpawnGroup", () => {
  it("assigns the uuid to the captured group and touches nothing else", () => {
    const groups: GroupsFile = { groups: ["Work"], assignments: { a: "Work", b: null }, order: ["a"], collapsed: ["X"] };
    applySpawnGroup(groups, "uuid-1", "Work");
    assert.equal(groups.assignments["uuid-1"], "Work");
    assert.equal(groups.assignments.a, "Work");
    assert.equal(groups.assignments.b, null);
    assert.deepEqual(groups.groups, ["Work"]);
    assert.deepEqual(groups.order, ["a"]);
    assert.deepEqual(groups.collapsed, ["X"]);
  });

  it("creates the group when it no longer exists", () => {
    const groups: GroupsFile = { groups: [], assignments: {} };
    applySpawnGroup(groups, "uuid-1", "Gone");
    assert.deepEqual(groups.groups, ["Gone"]);
    assert.equal(groups.assignments["uuid-1"], "Gone");
  });

  it("resolves the title to the existing group's casing", () => {
    const groups: GroupsFile = { groups: ["Work"], assignments: {} };
    applySpawnGroup(groups, "uuid-1", "work");
    assert.equal(groups.assignments["uuid-1"], "Work");
    assert.equal(groups.groups.length, 1);
  });
});
