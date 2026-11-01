// Permission grants (docs/permissions.md): "allow this for N minutes / this session",
// kept by the daemon so they outlive child restarts, /reload and daemon restarts. The
// store is pure apart from its file and an injected clock. A grant is only a record; the
// pi-permission-system authorizer link in each child (pi/extensions/toriel-grants.ts)
// asks the daemon whether an ask is covered, through `covers`.
//
// Grants read back from the file are DORMANT: the file is a stored "yes", and anything
// that can write it could otherwise self-grant across a restart. A dormant grant does
// nothing until the user restores it (`restore`); grants made in the running daemon are
// active at once.
import { readJsonOr, writeJsonAtomic } from "./util.ts";

export interface Grant {
  id: number;
  /** UUID of the session the grant belongs to. */
  session: string;
  /** pi-permission-system surface: bash, mcp, tool, skill ... */
  surface: string;
  /** The pattern pi suggested for the ask (matched exactly), or one typed by hand. */
  pattern: string;
  createdAt: number;
  /** Epoch ms; null = until revoked or the session is deleted. */
  expiresAt: number | null;
  source: "dialog" | "command";
  note?: string;
}

/** A surface and pattern pair, in the shape of pi's `sessionApproval.grants`. */
export interface GrantSpec {
  surface: string;
  pattern: string;
}

export interface GrantLimits {
  /** Most grants one session may hold. */
  perSession: number;
}

export const DEFAULT_GRANT_LIMITS: GrantLimits = { perSession: 100 };

export interface NewGrant {
  session: string;
  surface: string;
  pattern: string;
  /** Lifetime in ms; null or undefined = until revoked. */
  expiresIn?: number | null;
  source?: "dialog" | "command";
  note?: string;
}

interface StoreFile {
  version: 1;
  nextId: number;
  grants: Grant[];
}

/**
 * Surfaces pi's authorizer chain cannot grant: it downgrades a link's `allow` on the
 * `path` and `external_directory` families (and their read/write members) to `defer`.
 */
export function isCappedSurface(surface: string): boolean {
  return /^(path|external_directory)(_|$)/.test(surface);
}

/** Why a grant on `surface` cannot be made, or undefined when it can. */
export function cappedReason(surface: string): string | undefined {
  return isCappedSurface(surface) ? `pi does not let a grant cover "${surface}" (file-path) requests; pi's own "for this session" answer is the only way to allow those` : undefined;
}

/** The grant pi would record for an ask, as the link reported it, waiting for the dialog that follows. */
export interface Suggestion {
  grants: GrantSpec[];
  /** The command or target the ask is about; the dialog's title names it. */
  value?: string;
  at: number;
}

/** A suggestion older than this does not belong to the dialog that just arrived. */
export const SUGGESTION_TTL_MS = 60_000;

/**
 * A pi `select` dialog carrying the grant it could record, as `toriel: { grants }`, when
 * the remembered suggestion is fresh and the dialog's title names the same value (pi wraps
 * long commands across lines, so whitespace is ignored). Anything else comes back as it was:
 * no extra rows are offered rather than guessing.
 */
export function withSuggestion(dialog: Record<string, unknown>, suggestion: Suggestion | undefined, now: number): Record<string, unknown> {
  if (!suggestion || suggestion.grants.length === 0 || !suggestion.value || dialog.method !== "select" || now - suggestion.at > SUGGESTION_TTL_MS) {
    return dialog;
  }
  const squash = (t: string) => t.replace(/\s+/g, "");
  if (typeof dialog.title !== "string" || !squash(dialog.title).includes(squash(suggestion.value))) {
    return dialog;
  }
  return { ...dialog, toriel: { grants: suggestion.grants } };
}

export class GrantStore {
  private readonly file: string;
  private readonly now: () => number;
  private readonly limits: GrantLimits;
  private readonly grants = new Map<number, Grant>();
  /** Ids read from the file and not yet restored. */
  private readonly dormant = new Set<number>();
  private nextId = 1;

  constructor(file: string, now: () => number = Date.now, limits: GrantLimits = DEFAULT_GRANT_LIMITS) {
    this.file = file;
    this.now = now;
    this.limits = limits;
  }

  /** Read the file; everything in it starts dormant, and what already expired is dropped. */
  load(): void {
    const data = readJsonOr<Partial<StoreFile>>(this.file, {});
    const now = this.now();
    this.nextId = typeof data.nextId === "number" && data.nextId >= 1 ? data.nextId : 1;
    for (const g of Array.isArray(data.grants) ? data.grants : []) {
      if (!isGrant(g) || (g.expiresAt !== null && g.expiresAt <= now)) {
        continue;
      }
      this.grants.set(g.id, g);
      this.dormant.add(g.id);
      this.nextId = Math.max(this.nextId, g.id + 1);
    }
    this.save();
  }

  /** Live grants (expired ones are not listed), oldest first. */
  list(session?: string): Grant[] {
    const now = this.now();
    return [...this.grants.values()].filter((g) => (session === undefined || g.session === session) && !expired(g, now)).sort((a, b) => a.id - b.id);
  }

  get(id: number): Grant | undefined {
    const g = this.grants.get(id);
    return g && !expired(g, this.now()) ? g : undefined;
  }

  isDormant(id: number): boolean {
    return this.dormant.has(id);
  }

  /** Active (not dormant) live grants of a session. */
  active(session: string): Grant[] {
    return this.list(session).filter((g) => !this.dormant.has(g.id));
  }

  /** How many live grants of a session were read from the file and wait for `restore`. */
  dormantCount(session: string): number {
    return this.list(session).filter((g) => this.dormant.has(g.id)).length;
  }

  /** Activate a session's saved grants; says how many. */
  restore(session: string): number {
    let n = 0;
    for (const g of this.list(session)) {
      if (this.dormant.delete(g.id)) {
        n++;
      }
    }
    return n;
  }

  /** Make a grant (active at once). The same surface and pattern in a session is updated, not duplicated. */
  add(spec: NewGrant): Grant {
    const surface = spec.surface.trim();
    const pattern = spec.pattern.trim();
    if (!surface || !pattern) {
      throw new Error("a grant needs a surface (bash, mcp, tool, skill) and a pattern");
    }
    const capped = cappedReason(surface);
    if (capped) {
      throw new Error(capped);
    }
    const now = this.now();
    const expiresAt = spec.expiresIn === undefined || spec.expiresIn === null ? null : now + spec.expiresIn;
    const same = this.list(spec.session).find((g) => g.surface === surface && g.pattern === pattern);
    if (same) {
      same.expiresAt = expiresAt;
      same.source = spec.source ?? same.source;
      if (spec.note !== undefined) {
        same.note = spec.note;
      }
      this.dormant.delete(same.id);
      this.save();
      return same;
    }
    if (this.list(spec.session).length >= this.limits.perSession) {
      throw new Error(`this session already has ${this.limits.perSession} permission grants; revoke some first (/permissions)`);
    }
    const grant: Grant = { id: this.nextId++, session: spec.session, surface, pattern, createdAt: now, expiresAt, source: spec.source ?? "command" };
    if (spec.note) {
      grant.note = spec.note;
    }
    this.grants.set(grant.id, grant);
    this.save();
    return grant;
  }

  revoke(id: number): Grant | undefined {
    const g = this.grants.get(id);
    if (!g) {
      return undefined;
    }
    this.grants.delete(id);
    this.dormant.delete(id);
    this.save();
    return g;
  }

  /** Remove every grant of a session (the session was deleted, or the user asked). */
  removeSession(session: string): Grant[] {
    const gone = [...this.grants.values()].filter((g) => g.session === session);
    for (const g of gone) {
      this.grants.delete(g.id);
      this.dormant.delete(g.id);
    }
    if (gone.length > 0) {
      this.save();
    }
    return gone;
  }

  /**
   * The active grants that together cover every pair in `asked`, or undefined when any
   * pair is uncovered. An empty ask is never covered, and neither is a capped surface.
   */
  covers(session: string, asked: readonly GrantSpec[]): Grant[] | undefined {
    if (asked.length === 0) {
      return undefined;
    }
    const live = this.active(session);
    const used: Grant[] = [];
    for (const a of asked) {
      if (isCappedSurface(a.surface)) {
        return undefined;
      }
      const hit = live.find((g) => g.surface === a.surface && g.pattern === a.pattern);
      if (!hit) {
        return undefined;
      }
      used.push(hit);
    }
    return used;
  }

  /** Drop grants whose time is up; returns them so the caller can say so. */
  sweep(): Grant[] {
    const now = this.now();
    const gone = [...this.grants.values()].filter((g) => expired(g, now));
    for (const g of gone) {
      this.grants.delete(g.id);
      this.dormant.delete(g.id);
    }
    if (gone.length > 0) {
      this.save();
    }
    return gone;
  }

  /** Soonest expiry among a session's active timed grants (the status marker). */
  soonestExpiry(session: string): number | undefined {
    const times = this.active(session).flatMap((g) => (g.expiresAt === null ? [] : [g.expiresAt]));
    return times.length > 0 ? Math.min(...times) : undefined;
  }

  private save(): void {
    const data: StoreFile = { version: 1, nextId: this.nextId, grants: [...this.grants.values()].sort((a, b) => a.id - b.id) };
    writeJsonAtomic(this.file, data, 0o600);
  }
}

function expired(g: Grant, now: number): boolean {
  return g.expiresAt !== null && g.expiresAt <= now;
}

function isGrant(v: unknown): v is Grant {
  const g = v as Partial<Grant> | null;
  return (
    typeof g === "object" &&
    g !== null &&
    typeof g.id === "number" &&
    typeof g.session === "string" &&
    typeof g.surface === "string" &&
    typeof g.pattern === "string" &&
    typeof g.createdAt === "number" &&
    (g.expiresAt === null || typeof g.expiresAt === "number") &&
    (g.source === "dialog" || g.source === "command") &&
    !isCappedSurface(g.surface)
  );
}
