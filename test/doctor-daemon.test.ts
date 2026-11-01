import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { type Harness, startDaemon } from "./helpers.ts";

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

describe("daemon: start-up self-check", () => {
  it("logs every finding with its level, so a broken setup is visible in the log", async () => {
    const piDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "toriel-nopi-")), "agent");
    harness = await startDaemon({ PI_CODING_AGENT_DIR: piDir });
    const log = fs.readFileSync(path.join(harness.dir, "daemon.log"), "utf8");
    assert.match(log, /WARNING \[required\]: pi has no config at .*agent: run pi once and log in/);
    assert.match(log, /WARNING \[recommended\]: pi-permission-system is not in pi's packages/);
    fs.rmSync(path.dirname(piDir), { recursive: true, force: true });
  });
});
