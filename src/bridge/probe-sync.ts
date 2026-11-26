// The chat-server probe as doctor calls it: synchronous, a few seconds at most, never throws (probe-cli.ts does the asking).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ChattoSettings } from "../settings.ts";

/** Problems with the chat server as the bridge would meet it; a probe that could not run is itself one. */
export type ChatProbe = (chatto: ChattoSettings) => string[];

const CLI = fileURLToPath(new URL("./probe-cli.ts", import.meta.url));

export const probeChatServer: ChatProbe = (chatto) => {
  try {
    const r = spawnSync(process.execPath, [CLI], { encoding: "utf8", timeout: 20_000, env: { ...process.env, TORIEL_CHAT_PROBE: JSON.stringify(chatto) } });
    const line = r.stdout?.trim().split("\n").pop();
    if (r.status !== 0 || !line) {
      const why = r.error ? r.error.message : r.signal ? `stopped (${r.signal})` : (r.stderr?.trim().split("\n").pop() ?? `exit ${r.status}`);
      return [`could not ask the chat server at ${chatto.url} (${why}): check chatto.url and that the server is up`];
    }
    const parsed = JSON.parse(line) as { problems?: unknown };
    return Array.isArray(parsed.problems) ? parsed.problems.map(String) : [];
  } catch (err) {
    return [`could not ask the chat server at ${chatto.url}: ${err instanceof Error ? err.message : String(err)}`];
  }
};
