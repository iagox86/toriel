import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dialogOwner } from "../src/dialog-route.ts";
import { withOrigin, type DialogRequest } from "../src/dialogs.ts";
import type { SessionMeta } from "../src/shared.ts";

const dialog = { id: "d", method: "confirm", title: "Allow?" } as DialogRequest;
const meta = (id: number, over: Partial<SessionMeta> = {}): SessionMeta => ({ id, sessionId: `u${id}`, ...over }) as SessionMeta;
const keyFor = (m: SessionMeta) => `k${m.id}`;
const route = (viewing: string | null, views: Record<string, { dialog?: DialogRequest }>, metas: SessionMeta[]) => dialogOwner(viewing, new Map(Object.entries(views)), metas, keyFor);
const kid = (id: number, parent = "u1", over: Partial<SessionMeta> = {}) => meta(id, { pendingDialog: true, subagent: { state: "running", delivered: false, parent }, ...over });

describe("dialogOwner", () => {
  it("shows a session's own dialog first", () => {
    assert.equal(route("k1", { k1: { dialog }, k2: { dialog } }, [meta(1), kid(2)]), "k1");
  });

  it("shows a waiting subagent's dialog in its parent's view, the lowest session number first", () => {
    assert.equal(route("k1", { k2: {}, k3: { dialog }, k4: { dialog } }, [meta(1), kid(4), kid(3), kid(2, "u1", { pendingDialog: false })]), "k3");
  });

  it("ignores another session's subagents, a subagent whose dialog this controller never saw, and an unknown view", () => {
    assert.equal(route("k1", { k2: { dialog } }, [meta(1), kid(2, "u9")]), undefined);
    assert.equal(route("k1", { k2: {} }, [meta(1), kid(2)]), undefined);
    assert.equal(route("k7", { k2: { dialog } }, [meta(1), kid(2)]), undefined);
    assert.equal(route(null, {}, []), undefined);
  });

  it("does not move a subagent's dialog up another level: only its own parent shows it", () => {
    assert.equal(route("k0", { k2: { dialog } }, [meta(0), meta(1, { subagent: { state: "running", delivered: false, parent: "u0" } }), kid(2)]), undefined);
  });
});

describe("withOrigin", () => {
  it("names a subagent as one so the parent can tell who is asking", () => {
    assert.equal(withOrigin(dialog, 5, "worker: look", "Subagent").origin, "Subagent 5 'worker: look'");
    assert.equal(withOrigin(dialog, 5, "x").origin, "Session 5 'x'");
  });
});
