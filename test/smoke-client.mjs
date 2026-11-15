// Daemon smoke test: start a THROWAWAY daemon (a temp dir, the fake pi: test/helpers.ts), connect, spawn a session in the current
// directory, prompt it, wait for the run to settle. It never talks to your real daemon (ticket 214: a smoke run once typed
// "Reply with exactly: SMOKE-OK" into a live session).
// Usage: node test/smoke-client.mjs
//        SMOKE_SOCK=/path/to/sock node test/smoke-client.mjs   (a daemon you started yourself, on purpose; it prompts a session there)
// SMOKE_SOCK may not name the real daemon's default socket ($XDG_RUNTIME_DIR/toriel.sock or an --isolated profile's under it is fine).
import net from "node:net";
import path from "node:path";
import { startDaemon } from "./helpers.ts";

const explicit = process.env.SMOKE_SOCK;
if (explicit !== undefined && process.env.XDG_RUNTIME_DIR && path.resolve(explicit) === path.join(process.env.XDG_RUNTIME_DIR, "toriel.sock")) {
  throw new Error(`SMOKE_SOCK is your real daemon's socket (${explicit}); a smoke run would prompt one of your live sessions. Leave SMOKE_SOCK unset to use a throwaway daemon.`);
}
const harness = explicit === undefined ? await startDaemon() : undefined;
const SOCK = explicit ?? harness.sock;
/** Stop the throwaway daemon (and delete its dir), then exit. */
const finish = async (code) => {
  await harness?.stop().catch(() => {});
  process.exit(code);
};
const sock = net.connect(SOCK);
let buf = "";
const messages = [];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (msg) => sock.write(`${JSON.stringify(msg)}\n`);
const fail = (why) => {
  console.error(`SMOKE FAIL: ${why}`);
  finish(1);
};

sock.on("data", (d) => {
  buf += d.toString("utf8");
  for (let idx = buf.indexOf("\n"); idx !== -1; idx = buf.indexOf("\n")) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (line) {
      messages.push(JSON.parse(line));
    }
  }
});

sock.on("error", (err) => fail(`socket: ${err.message}`));

/** The latest session list the daemon sent. */
const sessions = () => [...messages].reverse().find((m) => m.type === "sessions")?.sessions ?? [];

sock.on("connect", async () => {
  send({ type: "list" }); // announces this connection as a controller
  await wait(1000);
  let session = explicit === undefined ? undefined : sessions().find((s) => s.active && !s.dead); // a throwaway daemon has none: always spawn
  if (!session) {
    send({ id: "spawn-1", type: "spawn", cwd: process.cwd() });
    for (let i = 0; i < 40 && !session; i++) {
      await wait(250);
      const reply = messages.find((m) => m.type === "response" && m.id === "spawn-1");
      if (reply && !reply.ok) {
        fail(`spawn: ${reply.error}`);
      }
      session = sessions().find((s) => s.active && !s.dead);
    }
  }
  if (!session) {
    fail("no live session");
  }
  console.error("SESSION:", JSON.stringify({ id: session.id, name: session.name, model: session.model }));
  send({ id: "prompt-1", type: "prompt", session: session.id, message: "Reply with exactly: SMOKE-OK" });

  const start = Date.now();
  const timer = setInterval(() => {
    const events = messages.filter((m) => m.type === "event" && m.session === session.id);
    if (events.some((m) => m.event.type === "agent_settled")) {
      const assistant = events
        .filter((m) => m.event.type === "message_end" && m.event.message?.role === "assistant")
        .map((m) =>
          (m.event.message.content ?? [])
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join(""),
        )
        .join(" || ");
      console.error("ASSISTANT TEXT:", assistant.slice(0, 300));
      console.error("SMOKE PASS");
      clearInterval(timer);
      finish(0);
    }
    if (Date.now() - start > 120_000) {
      console.error("event types seen:", [...new Set(messages.map((m) => m.event?.type ?? m.type))].join(","));
      fail("timeout");
    }
  }, 500);
});
