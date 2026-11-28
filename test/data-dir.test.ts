// Where toriel's saved files go (ticket 343): an isolated instance keeps them in its profile, never in the real data dir.
import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import { btwDir } from "../src/btw.ts";
import { dataRoot, torielDataDir } from "../src/data-dir.ts";
import { performanceDir } from "../src/performance.ts";
import { infoDir } from "../src/session-info.ts";

describe("dataRoot", () => {
  it("uses XDG_DATA_HOME, else ~/.local/share", () => {
    assert.equal(dataRoot({ XDG_DATA_HOME: "/d", HOME: "/h" }), "/d");
    assert.equal(dataRoot({ HOME: "/h" }), path.join("/h", ".local", "share"));
  });

  it("uses the profile's data directory in an isolated instance, whatever XDG_DATA_HOME says", () => {
    const env = { TORIEL_PROFILE: "dev", XDG_RUNTIME_DIR: "/run/user/1", XDG_DATA_HOME: "/d", HOME: "/h" };
    assert.equal(dataRoot(env), path.join("/run/user/1", "toriel-dev", "data"));
    assert.equal(torielDataDir("info", env), path.join("/run/user/1", "toriel-dev", "data", "toriel", "info"));
  });

  it("puts /btw answers, /info cards and /performance reports under the profile too", () => {
    const env = { TORIEL_PROFILE: "dev", XDG_RUNTIME_DIR: "/run/user/1", XDG_DATA_HOME: "/d" };
    const root = path.join("/run/user/1", "toriel-dev", "data", "toriel");
    assert.equal(btwDir(env), path.join(root, "btw"));
    assert.equal(infoDir(env), path.join(root, "info"));
    assert.equal(performanceDir(env), path.join(root, "performance"));
  });
});
