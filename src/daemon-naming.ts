// The one place session names are decided. The daemon's registry holds the name a session is
// *meant* to have (`wantedName`, unique across sessions); pi's own report is only an observation,
// checked after every write and again whenever the daemon refreshes a session. Writers (fork,
// rename, later spawn, subagents and the auto-namer) are callers of this class, not writers.
// Why: a fork's file is a copy of its parent's, so until the fork's own session_info entry is
// written pi resolves the PARENT's name; a one-shot write nobody verified left forks with the
// parent's name (board 156). Design: docs/naming-design.md.
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ClientHub } from "./daemon-hub.ts";
import { log } from "./log.ts";
import type { DaemonSession, SessionRegistry } from "./daemon-session.ts";
import { uniqueName } from "./session-id.ts";
import { errText } from "./util.ts";

export type NameSource = NonNullable<DaemonSession["nameSource"]>;

export interface ClaimOptions {
  source: NameSource;
  /** Only when the session has no name yet and nobody chose one (the auto-namer): a compare-and-set. */
  ifUnset?: boolean;
}

export interface NamingOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How long one pi request may take before it counts as failed; pi's RpcClient has no timeout of its own. */
  rpcTimeoutMs?: number;
  /** Waits between attempts to set the name: one more attempt than there are waits. */
  retryWaitsMs?: readonly number[];
  /** At least this long between two re-assertions for one session. */
  reassertEveryMs?: number;
  /** Re-assertions in a row without the name sticking before the daemon gives up. */
  maxReasserts?: number;
}

const MAX_NAME_CHARS = 120;

/** The name as stored: one line, trimmed, capped. An empty one is the only validation error. */
export function cleanName(requested: string): string {
  const one = requested.replace(/\s+/g, " ").trim();
  if (!one) {
    throw new Error("name is empty");
  }
  return one.length > MAX_NAME_CHARS ? one.slice(0, MAX_NAME_CHARS).trimEnd() : one;
}

export class DaemonNaming {
  private readonly registry: SessionRegistry;
  private readonly hub: ClientHub;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly rpcTimeoutMs: number;
  private readonly retryWaitsMs: readonly number[];
  private readonly reassertEveryMs: number;
  private readonly maxReasserts: number;
  /** Sessions whose name is being written and verified right now: a refresh must not write over it. */
  private readonly applying = new Set<number>();

  constructor(registry: SessionRegistry, hub: ClientHub, opts: NamingOptions = {}) {
    this.registry = registry;
    this.hub = hub;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.rpcTimeoutMs = opts.rpcTimeoutMs ?? 5000;
    this.retryWaitsMs = opts.retryWaitsMs ?? [100, 300];
    this.reassertEveryMs = opts.reassertEveryMs ?? 30_000;
    this.maxReasserts = opts.maxReasserts ?? 5;
  }

  /** Every name another session holds or has claimed (inactive sessions count; `s` itself does not). */
  private taken(except: DaemonSession | undefined): string[] {
    return this.registry.all().flatMap((x) => (x === except ? [] : [x.wantedName ?? x.sessionName].filter((n): n is string => n !== undefined)));
  }

  /**
   * Decide `s`'s name, synchronously: no await sits between choosing it and recording it, so two
   * requests for the same name cannot both get it. Unique across the registry (` #2`, ` #3`, never a
   * refusal). Returns undefined when `ifUnset` finds the session already named or user-named.
   */
  claim(s: DaemonSession, requested: string, opts: ClaimOptions): string | undefined {
    const wanted = cleanName(requested);
    if (opts.ifUnset && (s.nameSource === "user" || s.wantedName !== undefined || s.sessionName !== undefined)) {
      return undefined;
    }
    // an auto name that arrives after a user's choice is dropped even without ifUnset
    if (opts.source === "auto" && s.nameSource === "user") {
      return undefined;
    }
    const name = uniqueName(wanted, this.taken(s));
    s.wantedName = name;
    s.nameSource = opts.source;
    s.nameAsserts = 0;
    s.nameAssertAt = undefined;
    s.nameGaveUp = false;
    return name;
  }

  /** Forget a claim (the session failed to start, say), so it does not reserve the name for nothing. */
  release(s: DaemonSession): void {
    s.wantedName = undefined;
    s.nameSource = undefined;
    s.nameAsserts = 0;
    s.nameAssertAt = undefined;
    s.nameGaveUp = false;
  }

  private async withTimeout<T>(work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([work, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`pi did not answer within ${this.rpcTimeoutMs} ms`)), this.rpcTimeoutMs)))]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Make pi report `s.wantedName`. With a child: set it, ask pi what it now reports, up to three
   * attempts. A child that never takes it leaves the name "pending" (not an error: a fork must not be
   * orphaned over this); the refresh guard keeps asserting it. Without a child the file is written
   * directly and read back, and a failure there is a real error (disk, missing file).
   * Publishes the wanted name to controllers either way.
   */
  async apply(s: DaemonSession): Promise<{ name: string; verified: boolean }> {
    const name = s.wantedName;
    if (name === undefined) {
      throw new Error("no name was claimed for this session");
    }
    this.applying.add(s.id);
    try {
      let verified = false;
      if (s.child && !s.dead) {
        verified = await this.applyToChild(s, name);
      } else {
        this.applyToFile(s, name);
        verified = true;
      }
      s.sessionName = name;
      this.hub.broadcastSessions();
      return { name, verified };
    } catch (err) {
      this.release(s);
      throw err;
    } finally {
      this.applying.delete(s.id);
    }
  }

  /** `apply` without waiting: for a name `--name` already carried, where the check must not delay the first paint. A failure is logged, not thrown. */
  applyInBackground(s: DaemonSession): void {
    this.apply(s).catch((err: unknown) => log(`session ${s.id}: could not apply its name: ${errText(err)}`));
  }

  private async applyToChild(s: DaemonSession, name: string): Promise<boolean> {
    let seen: string | undefined;
    for (let attempt = 0; attempt <= this.retryWaitsMs.length; attempt++) {
      if (attempt > 0) {
        await this.sleep(this.retryWaitsMs[attempt - 1] as number);
      }
      const child = s.child;
      if (!child) {
        break; // it died meanwhile: the next refresh or start settles it
      }
      try {
        await this.withTimeout(child.setSessionName(name));
        seen = (await this.withTimeout(child.getState())).sessionName;
        if (seen === name) {
          return true;
        }
      } catch (err) {
        log(`session ${s.id}: setting its name failed (attempt ${attempt + 1}): ${errText(err)}`);
      }
    }
    log(`session ${s.id}: pi reports the name ${JSON.stringify(seen ?? null)}, not the wanted ${JSON.stringify(name)}; it stays pending and is re-asserted on refresh`);
    return false;
  }

  /** Append the name to the session file through pi's own writer, then read the latest name back. */
  private applyToFile(s: DaemonSession, name: string): void {
    if (!s.sessionFile) {
      throw new Error("nothing to rename yet (the session has no file): send a message first");
    }
    this.writeFileName(s.sessionFile, name);
  }

  private writeFileName(file: string, name: string): void {
    SessionManager.open(file).appendSessionInfo(name);
    const back = SessionManager.open(file).getSessionName();
    if (back !== name) {
      throw new Error(`wrote the name to ${file} but it reads back as ${JSON.stringify(back ?? null)}`);
    }
  }

  /** Rename a session toriel has no record of (a bare file): unique among the registry, written to the file. */
  renameFile(file: string, requested: string): string {
    const name = uniqueName(cleanName(requested), this.taken(undefined));
    this.writeFileName(file, name);
    return name;
  }

  /**
   * Called with what pi reports whenever the daemon refreshes a session. When that is not the wanted
   * name, tell pi again: at most once per `reassertEveryMs`, at most `maxReasserts` in a row, never
   * while a write is being verified or the session is starting. Fire and forget: the next refresh is
   * the verification. Costs one comparison when the names match.
   */
  noteObserved(s: DaemonSession, observed: string | undefined): void {
    if (s.wantedName === undefined) {
      return;
    }
    if (observed === s.wantedName) {
      s.nameAsserts = 0;
      s.nameGaveUp = false;
      return;
    }
    if (s.spawning || this.applying.has(s.id) || s.nameGaveUp || !s.child) {
      return;
    }
    const now = this.now();
    if (s.nameAssertAt !== undefined && now - s.nameAssertAt < this.reassertEveryMs) {
      return;
    }
    if ((s.nameAsserts ?? 0) >= this.maxReasserts) {
      s.nameGaveUp = true;
      log(`session ${s.id}: pi keeps reporting ${JSON.stringify(observed ?? null)} instead of ${JSON.stringify(s.wantedName)}; giving up until the name is set again`);
      return;
    }
    s.nameAssertAt = now;
    s.nameAsserts = (s.nameAsserts ?? 0) + 1;
    log(`session ${s.id}: pi reports ${JSON.stringify(observed ?? null)}, not the wanted ${JSON.stringify(s.wantedName)}; setting it again (${s.nameAsserts}/${this.maxReasserts})`);
    this.withTimeout(s.child.setSessionName(s.wantedName)).catch((err: unknown) => log(`session ${s.id}: re-asserting its name failed: ${errText(err)}`));
  }
}
