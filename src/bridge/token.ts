// Where the bridge's chat token comes from: a file only its owner can read, or an environment variable of the daemon. Never logged,
// never in an argument, never passed on to the pi sessions (they are started from the daemon's own environment, which only holds a
// tokenEnv variable if the user put it there).
import * as fs from "node:fs";
import * as os from "node:os";
import type { ChattoSettings } from "../settings.ts";

/** Whether the chat package can be loaded (the doctor's check; the bridge process imports it, the daemon never does). */
export function chatClientInstalled(): boolean {
  try {
    import.meta.resolve("@chatto/client");
    return true;
  } catch {
    return false;
  }
}

export type TokenResult = { ok: true; token: string } | { ok: false; problem: string };

export function readToken(s: Pick<ChattoSettings, "tokenFile" | "tokenEnv">, env: NodeJS.ProcessEnv = process.env): TokenResult {
  if (s.tokenEnv) {
    const v = env[s.tokenEnv]?.trim();
    return v ? { ok: true, token: v } : { ok: false, problem: `the environment variable ${s.tokenEnv} is empty or unset in the daemon's environment` };
  }
  if (!s.tokenFile) {
    return { ok: false, problem: "chatto has neither tokenFile nor tokenEnv" };
  }
  const file = s.tokenFile.replace(/^~(?=\/|$)/, os.homedir());
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return { ok: false, problem: `the token file ${file} does not exist` };
  }
  if (!st.isFile()) {
    return { ok: false, problem: `the token file ${file} is not a file` };
  }
  if ((st.mode & 0o077) !== 0) {
    return { ok: false, problem: `the token file ${file} is readable by others: chmod 600 it` };
  }
  const token = fs.readFileSync(file, "utf8").trim();
  return token ? { ok: true, token } : { ok: false, problem: `the token file ${file} is empty` };
}
