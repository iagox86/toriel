// The chat-server probe as doctor calls it: synchronous, a few seconds at most, never throws (probe-cli.ts does the asking).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ChattoSettings } from "../settings.ts";
import { errText } from "../util.ts";
import { redactUrl } from "./chat-error.ts";

/** Problems with the chat server as the bridge would meet it; a probe that could not run is itself one. */
export type ChatProbe = (chatto: ChattoSettings, env: NodeJS.ProcessEnv) => string[];

const CLI = fileURLToPath(new URL("./probe-cli.ts", import.meta.url));

export const probeChatServer: ChatProbe = (chatto, env) => {
  try {
    // the child's environment is the caller's: the tokenEnv variables it reads a token from travel with it (and TORIEL_CHAT_PROBE holds
    // the settings without any token, as readToken re-resolves them here)
    const r = spawnSync(process.execPath, [CLI], { encoding: "utf8", timeout: 20_000, env: { ...env, TORIEL_CHAT_PROBE: JSON.stringify(chatto) } });
    const line = r.stdout?.trim().split("\n").pop();
    if (r.status !== 0 || !line) {
      const why = r.error ? r.error.message : r.signal ? `stopped (${r.signal})` : (r.stderr?.trim().split("\n").pop() ?? `exit ${r.status}`);
      return [`could not ask the chat server at ${redactUrl(chatto.url)} (${why}): check chatto.url and that the server is up`];
    }
    const parsed = JSON.parse(line) as { problems?: unknown };
    return Array.isArray(parsed.problems) ? parsed.problems.map(String) : [];
  } catch (err) {
    return [`could not ask the chat server at ${redactUrl(chatto.url)}: ${errText(err)}`];
  }
};
