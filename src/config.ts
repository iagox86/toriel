// Paths and constants shared by the daemon and the controller. Everything is
// derived from the environment at import time, so tests isolate a daemon by
// setting TORIEL_SOCK / TORIEL_LOG / TORIEL_TRASH / XDG_DATA_HOME before spawning.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { rotateLog } from "./util.ts";

function sockPath(): string {
  if (process.env.TORIEL_SOCK) {
    return process.env.TORIEL_SOCK;
  }
  // No /tmp fallback: the socket takes unauthenticated commands, so it only ever
  // lives in a per-user directory.
  if (!process.env.XDG_RUNTIME_DIR) {
    throw new Error("XDG_RUNTIME_DIR is not set; set it or set TORIEL_SOCK to a path in a private (0700) directory");
  }
  return `${process.env.XDG_RUNTIME_DIR}/toriel.sock`;
}
export const SOCK = sockPath();
export const DATA_DIR = process.env.XDG_DATA_HOME ?? path.join(process.env.HOME ?? "", ".local", "share");
/** Daemon lock and pidfile: per state directory, so only one daemon runs against it whatever the socket is called. */
export const PID_FILE = path.join(DATA_DIR, "toriel", "daemon.pid");
export const TRASH_DIR = process.env.TORIEL_TRASH ?? path.join(DATA_DIR, "toriel", "trash");
export const HISTORY_FILE = process.env.TORIEL_HISTORY ?? path.join(DATA_DIR, "toriel", "history.jsonl");
export const LINEAGE_FILE = process.env.TORIEL_LINEAGE ?? path.join(DATA_DIR, "toriel", "lineage.json");
export const SESSION_AGENTS_FILE = process.env.TORIEL_SESSION_AGENTS ?? path.join(DATA_DIR, "toriel", "session-agents.json");
export const HANDLED_FILE = process.env.TORIEL_HANDLED ?? path.join(DATA_DIR, "toriel", "handled-files.json");
export const FEEDBACK_FILE = process.env.TORIEL_FEEDBACK ?? path.join(DATA_DIR, "toriel", "feedback.jsonl");
/** Logs and other state that is not user data (XDG_STATE_HOME), kept out of the source tree. */
export const STATE_DIR = path.join(process.env.XDG_STATE_HOME ?? path.join(process.env.HOME ?? "", ".local", "state"), "toriel");
export const LOG = process.env.TORIEL_LOG ?? path.join(STATE_DIR, "daemon.log");

/**
 * Key/UI debug log, enabled by setting TORIEL_KEYS to anything (e.g. 1). It goes
 * to logs/key-debug.log in the repo (git-ignored); a value containing "/" is
 * used as the file path instead. Empty string = off.
 */
function keyLogPath(): string {
  const v = process.env.TORIEL_KEYS;
  if (!v) {
    return "";
  }
  if (v.includes("/")) {
    return v;
  }
  const dir = path.join(import.meta.dirname, "..", "logs");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "key-debug.log");
  rotateLog(file);
  return file;
}
export const KEY_LOG = keyLogPath();
// The pi that npm installed next to toriel. The package's exports map hides
// dist/cli.js, so resolve its entry (dist/index.js) and take the sibling.
export const DEFAULT_PI_CLI = path.join(
  path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
  "cli.js",
);

// Extension dialog methods block the child until answered; the rest are
// fire-and-forget (notify/setStatus/setWidget/setTitle/set_editor_text).
export const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
