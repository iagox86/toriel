import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { DaemonMessage } from "../src/shared.ts";

// config.ts reads the socket path when it is first imported
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-link-"));
const sock = path.join(dir, "toriel.sock");
process.env.TORIEL_SOCK = sock;
process.env.XDG_DATA_HOME = path.join(dir, "data");
const { DaemonLink } = await import("../src/daemon-link.ts");

/** A stand-in daemon: answers `list` with a session list and every other command per `reply`. */
function fakeDaemon(reply: (cmd: Record<string, unknown>) => Record<string, unknown> | undefined) {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
    s.on("error", () => {});
    let buf = "";
    s.on("data", (d) => {
      buf += d;
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const cmd = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
        buf = buf.slice(nl + 1);
        const out = cmd.type === "list" ? { type: "sessions", sessions: [] } : reply(cmd);
        if (out) {
          s.write(`${JSON.stringify(out)}\n`);
        }
      }
    });
  });
  return {
    listen: () => new Promise<void>((r) => server.listen(sock, r)),
    dropClients: () => {
      for (const s of sockets) {
        s.destroy();
      }
    },
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        for (const s of sockets) {
          s.destroy();
        }
      }),
  };
}

function hooks() {
  const seen = { messages: [] as DaemonMessage[], lost: 0, reconnected: 0, retrying: 0, gaveUp: 0, notices: [] as string[], loaded: false };
  return {
    seen,
    hooks: {
      message: (m: DaemonMessage) => {
        seen.messages.push(m);
        if (m.type === "sessions") {
          seen.loaded = true;
        }
      },
      loaded: () => seen.loaded,
      lost: () => void seen.lost++,
      retrying: () => {
        seen.retrying++;
        seen.loaded = false;
      },
      reconnected: () => void seen.reconnected++,
      gaveUp: () => void seen.gaveUp++,
      notify: (t: string) => void seen.notices.push(t),
    },
  };
}

let daemon: ReturnType<typeof fakeDaemon>;
before(async () => {
  daemon = fakeDaemon((cmd) => {
    if (cmd.type === "model") {
      return { type: "response", id: cmd.id, ok: true, data: { models: ["a"] } };
    }
    if (cmd.type === "think") {
      return { type: "response", id: cmd.id, ok: false, error: "no such session" };
    }
    return undefined; // never answers: for the timeout case
  });
  await daemon.listen();
});
after(async () => {
  await daemon.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("DaemonLink", () => {
  it("opens once the first session list has arrived, and matches each response to its request", async () => {
    const { hooks: h, seen } = hooks();
    const link = new DaemonLink(h);
    await link.open();
    assert.ok(seen.messages.some((m) => m.type === "sessions"));
    assert.deepEqual(await link.request({ type: "model", session: 1 }), { models: ["a"] });
    link.close();
  });

  it("rejects a request the daemon answers with an error, using the daemon's text", async () => {
    const { hooks: h } = hooks();
    const link = new DaemonLink(h);
    await link.open();
    await assert.rejects(link.request({ type: "think", session: 1 }), /no such session/);
    link.close();
  });

  it("rejects a request that gets no answer within its timeout", async () => {
    const { hooks: h } = hooks();
    const link = new DaemonLink(h);
    await link.open();
    await assert.rejects(link.request({ type: "abort", session: 1 }, 50), /timed out/);
    link.close();
  });

  it("fails what is waiting when the connection drops, tells the controller once, and reconnects by itself", async () => {
    const { hooks: h, seen } = hooks();
    const link = new DaemonLink(h);
    await link.open();
    const waiting = link.request({ type: "abort", session: 1 }, 5000);
    daemon.dropClients();
    await assert.rejects(waiting, /daemon connection lost/);
    assert.equal(seen.lost, 1);
    assert.equal(link.down, true);
    link.send({ type: "list" });
    assert.deepEqual(seen.notices, ["daemon is not connected - reconnecting"]);
    const deadline = Date.now() + 5000;
    while (link.down && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(link.down, false);
    assert.deepEqual([seen.retrying, seen.reconnected, seen.gaveUp], [1, 1, 0]);
    assert.deepEqual(await link.request({ type: "model", session: 1 }), { models: ["a"] });
    link.close();
  });

  it("does not reconnect after close", async () => {
    const { hooks: h, seen } = hooks();
    const link = new DaemonLink(h);
    await link.open();
    link.close();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(seen.lost, 0);
  });
});
