// The bridge process: started by the daemon (daemon-chat.ts) with the daemon's socket in TORIEL_SOCK. Reads the `chatto` settings,
// connects to the chat server and the daemon, and runs until either goes away. Everything it says goes to stderr, which the daemon
// copies into its log (never the token).
import * as path from "node:path";
import { DATA_DIR, SOCK } from "../config.ts";
import { loadSettings } from "../settings.ts";
import { Bridge } from "./bridge.ts";
import { connectChatto } from "./chatto-adapter.ts";
import { connectDaemon } from "./daemon-client.ts";
import { readToken } from "./token.ts";

const say = (text: string): void => void process.stderr.write(`${text}\n`);

async function main(): Promise<void> {
  const { settings } = loadSettings();
  if (!settings.chatto) {
    say("no chatto settings: nothing to do");
    process.exit(0);
  }
  const token = readToken(settings.chatto);
  if (!token.ok) {
    say(`cannot start: ${token.problem}`);
    process.exit(2); // a setup problem: the daemon does not retry it in a loop
  }
  const daemon = await connectDaemon(SOCK);
  daemon.onClose(() => {
    say("the daemon went away: bridge exits");
    process.exit(0);
  });
  const adapter = await connectChatto({ url: settings.chatto.url, token: token.token });
  const bridge = new Bridge({ adapter, daemon, settings: settings.chatto, stateFile: path.join(DATA_DIR, "toriel", "chat-bridge.json"), log: say });
  await bridge.start();
  const stop = (): void => {
    bridge.stop();
    setTimeout(() => process.exit(0), 200).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((err: unknown) => {
  say(`bridge failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
