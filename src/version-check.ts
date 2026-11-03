// Compares the code a controller runs with the code of the daemon it reached.
// Pure, so the notice texts and the three outcomes are tested without a socket.
import { type BuildInfo, type DaemonMessage, PROTOCOL } from "./shared.ts";

export type Hello = Extract<DaemonMessage, { type: "hello" }>;

export type DaemonVerdict =
  | { level: "ok" }
  /** Works, probably: the code differs but the protocol is the same, or the daemon is too old to say. */
  | { level: "warn"; text: string }
  /** Cannot be trusted: the protocols differ, so the controller sends nothing but `list` and `shutdown`. */
  | { level: "blocked"; text: string };

const FIX = "toriel kill-server stops it (running sessions stop too; nothing is restarted for you)";

function where(b: BuildInfo): string {
  return `${b.label} from ${b.dir}`;
}

/** `hello` is undefined when the daemon answered the first `list` without sending one. */
export function compareDaemon(local: BuildInfo, hello: Hello | undefined): DaemonVerdict {
  if (!hello) {
    return { level: "warn", text: `the daemon is older than this toriel (${where(local)}): it predates the version check. ${FIX}` };
  }
  if (hello.protocol !== PROTOCOL) {
    return { level: "blocked", text: `the daemon speaks protocol ${hello.protocol}, this toriel ${PROTOCOL} (daemon ${where(hello.build)}, pid ${hello.pid}); nothing is sent to it until it is restarted. ${FIX}` };
  }
  if (hello.build.fingerprint !== local.fingerprint) {
    return { level: "warn", text: `the daemon runs ${where(hello.build)} (pid ${hello.pid}), this toriel ${where(local)}. ${FIX}` };
  }
  return { level: "ok" };
}

/** The "Daemon" block of /doctor and `toriel doctor`: what runs where, then what differs. */
export function describeDaemon(local: BuildInfo, hello: Hello | undefined, verdict: DaemonVerdict): string {
  const lines = ["Daemon"];
  if (hello) {
    lines.push(`  runs ${where(hello.build)} (pid ${hello.pid}, protocol ${hello.protocol}), socket ${hello.sock}${hello.profile ? `, isolated instance "${hello.profile}"` : ""}`);
  } else {
    lines.push("  did not say which code it runs (it predates the version check)");
  }
  lines.push(`  this toriel runs ${where(local)} (protocol ${PROTOCOL})`);
  lines.push(verdict.level === "ok" ? "  same code and protocol: OK" : `  ${verdict.level === "blocked" ? "PROBLEM" : "WARNING"}  ${verdict.text}`);
  return lines.join("\n");
}
