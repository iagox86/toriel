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
    // the socket exists a moment before the check has logged its findings
    const logFile = path.join(harness.dir, "daemon.log");
    const deadline = Date.now() + 5000;
    while (!fs.readFileSync(logFile, "utf8").includes("WARNING [recommended]") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const log = fs.readFileSync(logFile, "utf8");
    assert.match(log, /WARNING \[required\]: pi has no config at .*agent: run pi once and log in/);
    assert.match(log, /WARNING \[recommended\]: pi-permission-system is not in pi's packages/);
    fs.rmSync(path.dirname(piDir), { recursive: true, force: true });
  });
});
