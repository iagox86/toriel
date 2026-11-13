// Names a session nobody named: once its first exchange settles, a cheap model reads the first message and
// proposes a short title (ticket 62). The title goes through DaemonNaming like every other name, as an "auto"
// claim that never replaces a name the user chose, so this module only produces text and decides when to try.
import { messageText } from "./format.ts";
import type { DaemonNaming } from "./daemon-naming.ts";
import type { DaemonSession } from "./daemon-session.ts";
import { readActiveEntries, type SessionEntryLike } from "./session-file.ts";
import { loadSettings, resolveChildConfig } from "./settings.ts";
import { runSummarizer, summaryModel } from "./summarize.ts";
import { errText } from "./util.ts";

export const TITLE_MAX = 60;
/** The model only needs the gist; a pasted log would just slow a small model down. */
const INPUT_CHARS = 1200;
const TITLE_TIMEOUT_MS = 90_000;
const PROMPT =
  "Write a title of 2 to 6 words for the coding-assistant session that starts with the message on stdin. " +
  "Reply with only the title: no quotes, no trailing period, no preamble, no markdown.";

/** One line from the model's reply, without the wrapping a chatty model adds ("Title: ...", quotes, a final period, markdown). */
export function cleanTitle(raw: string): string {
  const line = raw.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const bare = line
    .replace(/^(?:session\s+)?title\s*:\s*/i, "")
    .replace(/^[#*_>\s"'`]+|[*_\s"'`]+$/g, "")
    .replace(/\.+$/, "")
    .trim();
  return bare.length > TITLE_MAX ? `${bare.slice(0, TITLE_MAX - 3).trimEnd()}...` : bare;
}

/**
 * What the person first asked: the first user message that is real text, not a /command or a !command (those
 * name nothing). Undefined when there is none yet.
 */
export function firstRequest(file: string): string | undefined {
  for (const entry of readActiveEntries<SessionEntryLike & { message?: { role?: string; content?: unknown } }>(file)) {
    if (entry?.type !== "message" || entry.message?.role !== "user") {
      continue;
    }
    const text = messageText(entry.message as { content?: unknown }).replace(/\s+/g, " ").trim();
    if (text && !text.startsWith("/") && !text.startsWith("!")) {
      return text.slice(0, INPUT_CHARS);
    }
  }
  return undefined;
}

export interface AutoNameOptions {
  /** Turns a message into a title; defaults to one pi print-mode run of the summary model. */
  generate?: (request: string) => Promise<string>;
  enabled?: () => boolean;
  log?: (line: string) => void;
}

export class AutoNamer {
  private readonly tried = new Set<number>();
  private readonly generate: (request: string) => Promise<string>;
  private readonly enabled: () => boolean;
  private readonly log: (line: string) => void;
  private readonly naming: DaemonNaming;

  constructor(naming: DaemonNaming, opts: AutoNameOptions = {}) {
    this.naming = naming;
    this.generate =
      opts.generate ??
      ((request) => runSummarizer({ piCli: resolveChildConfig(loadSettings().settings).piCli, model: summaryModel(), transcript: request, prompt: PROMPT, timeoutMs: TITLE_TIMEOUT_MS }));
    this.enabled = opts.enabled ?? (() => process.env.TORIEL_AUTO_NAME !== "0" && loadSettings().settings.autoName !== false);
    this.log = opts.log ?? (() => {});
  }

  /**
   * A session went idle. If nobody named it, try once, in the background: a failure only leaves the session
   * unnamed (its first message still shows in the switcher), and is logged, never shown.
   * Resolves when the attempt is over, for tests; callers do not wait.
   */
  onSettled(s: DaemonSession): Promise<void> {
    if (!this.eligible(s)) {
      return Promise.resolve();
    }
    let request: string | undefined;
    try {
      request = firstRequest(s.sessionFile as string);
    } catch (err) {
      // the file can be gone (trash sweep, rewind, clear) when the turn settles; this runs inside the settle hook, which must not throw
      this.log(`auto-name for session ${s.id} skipped: ${errText(err)}`);
      return Promise.resolve();
    }
    if (request === undefined) {
      return Promise.resolve();
    }
    this.tried.add(s.id);
    return this.run(s, request);
  }

  private eligible(s: DaemonSession): boolean {
    return this.enabled() && !this.tried.has(s.id) && s.sessionFile !== undefined && s.sessionName === undefined && s.wantedName === undefined && !s.dead;
  }

  private async run(s: DaemonSession, request: string): Promise<void> {
    try {
      const title = cleanTitle(await this.generate(request));
      if (!title) {
        throw new Error("the model gave no usable title");
      }
      // the person may have named it, or a fork or rename may have, while the model thought
      if (this.naming.claim(s, title, { source: "auto", ifUnset: true }) === undefined) {
        return;
      }
      await this.naming.apply(s);
    } catch (err) {
      this.log(`auto-name for session ${s.id} failed: ${errText(err)}`);
    }
  }
}
