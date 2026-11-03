import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { type BuildInfo, type DaemonMessage, PROTOCOL } from "../src/shared.ts";
import type { DaemonVerdict } from "../src/version-check.ts";

// config.ts reads the socket path when it is first imported
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-link-"));
const sock = path.join(dir, "toriel.sock");
process.env.TORIEL_SOCK = sock;
process.env.XDG_DATA_HOME = path.join(dir, "data");
const { DaemonLink } = await import("../src/daemon-link.ts");

const BUILD: BuildInfo = { fingerprint: "aaaa", label: "1fa724e", dir: "/work/main" };
/** What the stand-in daemon says about itself in its hello; undefined = it sends none (an older daemon). */
let helloOf: Record<string, unknown> | undefined;

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
        if (cmd.type === "list" && helloOf) {
          s.write(`${JSON.stringify({ type: "hello", pid: 4242, sock, ...helloOf })}\n`);
        }
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
  const seen = { messages: [] as DaemonMessage[], lost: 0, reconnected: 0, retrying: 0, gaveUp: 0, notices: [] as string[], loaded: false, verdicts: [] as DaemonVerdict[] };
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
      daemonChecked: (v: DaemonVerdict) => void seen.verdicts.push(v),
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
    const link = new DaemonLink(h, BUILD);
    await link.open();
    assert.ok(seen.messages.some((m) => m.type === "sessions"));
    assert.deepEqual(await link.request({ type: "model", session: 1 }), { models: ["a"] });
    link.close();
  });

  it("rejects a request the daemon answers with an error, using the daemon's text", async () => {
    const { hooks: h } = hooks();
    const link = new DaemonLink(h, BUILD);
    await link.open();
    await assert.rejects(link.request({ type: "think", session: 1 }), /no such session/);
    link.close();
  });

  it("rejects a request that gets no answer within its timeout", async () => {
    const { hooks: h } = hooks();
    const link = new DaemonLink(h, BUILD);
    await link.open();
    await assert.rejects(link.request({ type: "abort", session: 1 }, 50), /timed out/);
    link.close();
  });

  it("fails what is waiting when the connection drops, tells the controller once, and reconnects by itself", async () => {
    const { hooks: h, seen } = hooks();
    const link = new DaemonLink(h, BUILD);
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
    const link = new DaemonLink(h, BUILD);
    await link.open();
    link.close();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(seen.lost, 0);
  });
});

describe("DaemonLink version check", () => {
  const same = { protocol: PROTOCOL, build: BUILD };

  it("says nothing is wrong when the daemon runs the same code", async () => {
    helloOf = same;
    const { hooks: h, seen } = hooks();
    const link = new DaemonLink(h, BUILD);
    await link.open();
    assert.deepEqual(seen.verdicts, [{ level: "ok" }]);
    assert.ok(seen.messages.every((m) => m.type !== "hello"), "hello is for the link, not the controller");
    link.close();
  });

  it("warns, and still sends requests, when only the code differs", async () => {
    helloOf = { ...same, build: { fingerprint: "bbbb", label: "9c0ffee+dirty", dir: "/work/branch" } };
    const { hooks: h, seen } = hooks();
    const link = new DaemonLink(h, BUILD);
    await link.open();
    assert.equal(seen.verdicts.length, 1);
    assert.equal(seen.verdicts[0].level, "warn");
    assert.match((seen.verdicts[0] as { text: string }).text, /9c0ffee\+dirty from \/work\/branch/);
    assert.deepEqual(await link.request({ type: "model", session: 1 }), { models: ["a"] });
    link.close();
  });

  it("blocks everything but list and shutdown when the protocols differ", async () => {
    helloOf = { ...same, protocol: PROTOCOL + 1 };
    const { hooks: h, seen } = hooks();
    const link = new DaemonLink(h, BUILD);
    await link.open();
    assert.equal(seen.verdicts[0].level, "blocked");
    await assert.rejects(link.request({ type: "model", session: 1 }), /protocol/);
    link.send({ type: "prompt", session: 1, text: "hi" });
    assert.match(seen.notices.join("\n"), /not sent: the daemon speaks protocol/);
    link.close();
  });

  it("treats a daemon that sends no hello as older than this controller", async () => {
    helloOf = undefined;
    const { hooks: h, seen } = hooks();
    const link = new DaemonLink(h, BUILD);
    await link.open();
    assert.equal(seen.verdicts.length, 1);
    assert.equal(seen.verdicts[0].level, "warn");
    assert.match((seen.verdicts[0] as { text: string }).text, /older than this toriel/);
    link.close();
  });

  it("compares again after a reconnect, since the daemon may have been replaced", async () => {
    helloOf = same;
    const { hooks: h, seen } = hooks();
    const link = new DaemonLink(h, BUILD);
    await link.open();
    helloOf = { ...same, build: { fingerprint: "cccc", label: "new", dir: "/work/other" } };
    daemon.dropClients();
    const deadline = Date.now() + 5000;
    while (seen.verdicts.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.deepEqual(seen.verdicts.map((v) => v.level), ["ok", "warn"]);
    link.close();
  });
});
