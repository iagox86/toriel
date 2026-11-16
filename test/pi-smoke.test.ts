// The pinned pi still behaves the way toriel assumes (ticket 75). These run the real pi in toriel's node_modules, with no model and no
// network and an empty config directory, so they are what a pi bump (`toriel update pi`) runs into first: a change that breaks one of
// toriel's assumptions fails here, in one place, instead of as a live bug.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_PI_CLI } from "../src/config.ts";

const ROOT = join(import.meta.dirname, "..");
const agentDir = mkdtempSync(join(tmpdir(), "pi-smoke-"));
const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };

function pi(args: string[]): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [DEFAULT_PI_CLI, ...args], { env, encoding: "utf8", timeout: 30_000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("the pinned pi", () => {
  it("is the version package.json pins", () => {
    const pinned = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { dependencies: Record<string, string> }).dependencies["@earendil-works/pi-coding-agent"];
    assert.equal(pi(["--version"]).out.trim(), pinned);
  });

  it("refuses a --tools list that mixes bare names with +name (profileArgs relies on it never being built)", () => {
    const r = pi(["--tools", "read,+grep", "--no-extensions", "-p", "hi"]);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /tool names cannot be mixed with \+name or -name entries/);
  });

  it("answers a get_state request over RPC (the daemon's handshake with every child)", async () => {
    const child = spawn(process.execPath, [DEFAULT_PI_CLI, "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--offline"], { env, stdio: ["pipe", "pipe", "pipe"] });
    try {
      const reply = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("pi did not answer get_state in 20s")), 20_000);
        let buf = "";
        child.stdout.on("data", (d: Buffer) => {
          buf += d.toString();
          for (const line of buf.split("\n")) {
            try {
              const msg = JSON.parse(line) as Record<string, unknown>;
              if (msg.type === "response" && msg.id === "smoke") {
                clearTimeout(timer);
                resolve(msg);
              }
            } catch {
              // a partial or non-JSON line
            }
          }
        });
        child.on("error", reject);
        child.stdin.write(`${JSON.stringify({ type: "get_state", id: "smoke" })}\n`);
      });
      assert.equal(reply.success, true);
      assert.equal(reply.command, "get_state");
      assert.equal(typeof (reply.data as Record<string, unknown>).sessionId, "string", "the controller keys a session by the sessionId in get_state");
    } finally {
      child.kill();
    }
  });
});
