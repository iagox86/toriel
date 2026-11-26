// The bridge process: started by the daemon (daemon-chat.ts) with the daemon's socket in TORIEL_SOCK. Reads the `chatto` settings,
// connects to the chat server and the daemon, and runs until either goes away. Everything it says goes to stderr, which the daemon
// copies into its log (never the token).
import * as path from "node:path";
import { DATA_DIR, SOCK } from "../config.ts";
import { loadSettings } from "../settings.ts";
import { Bridge, SetupError } from "./bridge.ts";
import { redactUrl, setupFailureText } from "./chat-error.ts";
import { connectChatto } from "./chatto-adapter.ts";
import { connectDaemon } from "./daemon-client.ts";
import { readToken } from "./token.ts";
import { errText } from "../util.ts";

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
  const daemon = await connectDaemon(SOCK).catch((err: unknown) => {
    throw new Error(`could not connect to the daemon at ${SOCK}: ${errText(err)}`);
  });
  let bridge: Bridge | undefined;
  /** Clear the channels (a few seconds at most), then end. */
  let leaving = false;
  const leave = (why: string): void => {
    if (leaving) {
      return;
    }
    leaving = true;
    say(why);
    setTimeout(() => process.exit(0), 10_000).unref();
    void (bridge ? bridge.shutdown() : Promise.resolve()).finally(() => process.exit(0));
  };
  daemon.onClose(() => leave("the daemon went away: clearing the channels and exiting"));
  const url = settings.chatto.url;
  const adapter = await connectChatto({ url, token: token.token }).catch((err: unknown) => {
    // the package failed to load or refused the URL: trying again will not change either
    throw new SetupError(setupFailureText(`set up the chat client for ${redactUrl(url)}`, err, { invalid_argument: "check chatto.url" }));
  });
  bridge = new Bridge({ adapter, daemon, settings: settings.chatto, stateFile: path.join(DATA_DIR, "toriel", "chat-bridge.json"), log: say, ...(settings.permissionGrantDurations ? { grantDurations: settings.permissionGrantDurations } : {}) });
  await bridge.start();
  process.on("SIGTERM", () => leave("told to stop: clearing the channels and exiting"));
  process.on("SIGINT", () => leave("interrupted: clearing the channels and exiting"));
}

main().catch((err: unknown) => {
  say(`bridge failed: ${errText(err)}`);
  process.exit(err instanceof SetupError ? 2 : 1); // a setup problem is not retried in a loop
});
