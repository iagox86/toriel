// Run by `toriel doctor` in a child process (src/bridge/probe-sync.ts): connects to the chat server with the bridge's token, looks
// (src/bridge/probe.ts), prints `{"problems": [...]}` on stdout and exits. A child, so doctor stays synchronous and the chat client's
// sockets and timers die with it. The settings come in TORIEL_CHAT_PROBE (no token: it is read here, as the bridge reads it).
import type { ChattoSettings } from "../settings.ts";
import { setupFailureText } from "./chat-error.ts";
import { connectChatto } from "./chatto-adapter.ts";
import { probeChat } from "./probe.ts";
import { readToken } from "./token.ts";

const CONNECT_MS = 12_000;

async function main(): Promise<string[]> {
  const chatto = JSON.parse(process.env.TORIEL_CHAT_PROBE ?? "{}") as ChattoSettings;
  const token = readToken(chatto);
  if (!token.ok) {
    return []; // doctor's token check already says so
  }
  const adapter = await connectChatto({ url: chatto.url, token: token.token });
  const timeout = new Promise<string[]>((resolve) => {
    setTimeout(() => resolve([`the chat server at ${chatto.url} did not answer within ${CONNECT_MS / 1000} s: check chatto.url and that the server is up`]), CONNECT_MS).unref();
  });
  return Promise.race([probeChat(adapter, chatto), timeout]);
}

main().then(
  (problems) => {
    process.stdout.write(`${JSON.stringify({ problems })}\n`);
    process.exit(0);
  },
  (err: unknown) => {
    process.stdout.write(`${JSON.stringify({ problems: [`the chat bridge ${setupFailureText("set up the chat client", err).replace(/^could not/, "cannot")}`] })}\n`);
    process.exit(0);
  },
);
