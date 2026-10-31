// Daemon smoke test: connect, pick a live session (or spawn one in the current
// directory), prompt it, wait for the run to settle.
// Usage: node test/smoke-client.mjs     (TORIEL_SOCK / XDG_RUNTIME_DIR pick the daemon)
import net from "node:net";

const SOCK = process.env.TORIEL_SOCK ?? (process.env.XDG_RUNTIME_DIR ? `${process.env.XDG_RUNTIME_DIR}/toriel.sock` : undefined);
if (!SOCK) {
  throw new Error("XDG_RUNTIME_DIR is not set; set it or TORIEL_SOCK");
}
const sock = net.connect(SOCK);
let buf = "";
const messages = [];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (msg) => sock.write(`${JSON.stringify(msg)}\n`);
const fail = (why) => {
  console.error(`SMOKE FAIL: ${why}`);
  process.exit(1);
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
  let session = sessions().find((s) => s.active && !s.dead);
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
      process.exit(0);
    }
    if (Date.now() - start > 120_000) {
      console.error("event types seen:", [...new Set(messages.map((m) => m.event?.type ?? m.type))].join(","));
      fail("timeout");
    }
  }, 500);
});
