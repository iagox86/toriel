// /feedback, shared by the session and switcher command sets. A note carries a bundle (ticket 239): a copy of the session, the logs
// around it, the permission rules, the doctor report, the daemon's snapshot of the session's state. See feedback-bundle.ts.
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import type { Invocation } from "./cli.ts";
import { DECISIONS_FILE, FEEDBACK_DIR, FEEDBACK_FILE, LITELLM_CACHE_FILE, LOG } from "./config.ts";
import { mcpYamlFile, yamlSettingsFile } from "./config-dir.ts";
import { renderDoctor, runDoctor } from "./doctor.ts";
import { appendFeedback, formatFeedback, piVersion, readFeedback, sessionPosition, torielRevision } from "./feedback.ts";
import { type BundleSources, writeBundle } from "./feedback-bundle.ts";
import type { Host } from "./host.ts";
import { piAgentDir } from "./pi-dir.ts";
import { loadSettings, resolveChildConfig } from "./settings.ts";
import { errText } from "./util.ts";

/** What only the controller knows: the terminal it runs in and the toriel it is. */
function controllerFacts(piCli: string): Record<string, unknown> {
  const env = process.env;
  return {
    toriel: torielRevision(),
    pi: piVersion(piCli),
    node: process.version,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    term: { TERM: env.TERM, TERM_PROGRAM: env.TERM_PROGRAM, COLORTERM: env.COLORTERM, tmux: env.TMUX !== undefined, kitty: env.KITTY_WINDOW_ID !== undefined, ssh: env.SSH_CONNECTION !== undefined, display: env.WAYLAND_DISPLAY ?? env.DISPLAY },
  };
}

/** The sources for the real machine; tests pass their own. */
export function realSources(h: Host): BundleSources {
  return {
    noteFile: FEEDBACK_FILE,
    feedbackDir: FEEDBACK_DIR,
    daemonLog: LOG,
    decisionsFile: DECISIONS_FILE,
    agentDir: piAgentDir(),
    configFiles: [yamlSettingsFile(), mcpYamlFile()],
    doctor: () => `${renderDoctor(runDoctor({ litellmCacheFile: LITELLM_CACHE_FILE, startup: [] }), { compact: false })}\n\n${h.daemonReport()}`,
  };
}

/** `key` is the session file of the session on screen or highlighted, if any. */
export async function runFeedback(h: Host, call: Invocation, key: string | undefined, sources: BundleSources = realSources(h)): Promise<void> {
  if (call.opts.list === true) {
    h.infoPanel.show(formatFeedback(readFeedback(sources.noteFile)));
    return;
  }
  const text = call.args.join(" ").trim();
  if (!text) {
    h.notify("/feedback: say what went wrong (or -l to list what is recorded)");
    return;
  }
  const meta = key ? h.metaForPath(key) : undefined;
  const file = key?.startsWith("/") ? key : meta?.sessionFile;
  const id = randomUUID();
  const at = new Date().toISOString();
  const piCli = resolveChildConfig(loadSettings().settings).piCli;
  try {
    const record = {
      id,
      at,
      source: "user" as const,
      text,
      category: call.opts.category as string | undefined,
      session: file
        ? {
            file,
            name: meta?.sessionName,
            model: meta?.model,
            provider: meta?.provider,
            ...sessionPosition(file),
          }
        : undefined,
      cwd: meta?.cwd,
      env: { toriel: torielRevision(), pi: piVersion(piCli), daemonLog: LOG },
      bundle: undefined as string | undefined,
    };
    // the daemon holds the modes, scope, grants and any prompt waiting; an older one cannot answer, and the bundle says so
    let snapshot: Record<string, unknown>;
    try {
      snapshot = (await h.request({ type: "feedback_snapshot", session: meta?.id }, 4000)) as Record<string, unknown>;
    } catch (err) {
      snapshot = { source: "controller", note: `no snapshot from the daemon (${errText(err)}): restart it with toriel kill-server if it is older than this toriel`, session: meta };
    }
    snapshot = { ...snapshot, controller: controllerFacts(piCli) };
    let failure: string | undefined;
    try {
      record.bundle = (await writeBundle({ id, at, record, snapshot, sessionFile: file, cwd: meta?.cwd }, sources)).dir;
    } catch (err) {
      failure = errText(err);
    }
    appendFeedback(record, sources.noteFile);
    h.notify(failure === undefined ? `feedback recorded; bundle: ${record.bundle}` : `feedback recorded, but the bundle failed: ${failure}`);
  } catch (err) {
    h.notify(`feedback failed: ${errText(err)}`);
  }
}
