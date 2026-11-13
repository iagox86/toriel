// The daemon's side of permission grants (docs/permissions.md): the handlers for the
// permission_* commands. The store itself is pure (src/permissions.ts); the toriel-grants
// link in each child asks `permission_check` before pi's dialog opens.
import * as os from "node:os";
import { PERMISSIONS_FILE } from "./config.ts";
import type { Cmd, DaemonContext, Responder } from "./daemon-context.ts";
import { scopeOf } from "./daemon-schedule.ts";
import { log } from "./log.ts";
import { coversPattern, type Grant, type GrantStore, isCappedSurface } from "./permissions.ts";
import { piAgentDir } from "./pi-dir.ts";
import type { GrantView, PermissionGrantSpec } from "./shared.ts";
import { fmtClock, parseDurationText } from "./when.ts";

export function viewOfGrant(ctx: DaemonContext, g: Grant): GrantView {
  return {
    id: g.id,
    session: g.session,
    sessionName: ctx.registry.all().find((x) => x.sessionId === g.session)?.sessionName,
    surface: g.surface,
    pattern: g.pattern,
    createdAt: g.createdAt,
    expiresAt: g.expiresAt,
    source: g.source,
    note: g.note,
    dormant: ctx.grants.isDormant(g.id),
  };
}

function specsOf(v: unknown): PermissionGrantSpec[] {
  if (!Array.isArray(v)) {
    return [];
  }
  return v.flatMap((x) => {
    const g = x as Partial<PermissionGrantSpec> | null;
    return g && typeof g.surface === "string" && typeof g.pattern === "string" && g.surface && g.pattern ? [{ surface: g.surface, pattern: g.pattern }] : [];
  });
}

/** From a child's link, before pi's dialog: is this ask covered? If not, keep pi's suggestion for the dialog. */
export function handlePermissionCheck(ctx: DaemonContext, cmd: Cmd<"permission_check">, res: Responder): void {
  const asked = specsOf(cmd.grants);
  const covered = typeof cmd.uuid === "string" ? ctx.grants.covers(cmd.uuid, asked) : undefined;
  if (covered) {
    log(`permission granted by ${covered.map((g) => `#${g.id}`).join(", ")} for session ${cmd.uuid}: ${asked.map((a) => `${a.surface} ${JSON.stringify(a.pattern)}`).join(", ")}`);
    res(true, undefined, { allow: true, grants: covered.map((g) => g.id) });
    return;
  }
  const s = typeof cmd.uuid === "string" ? ctx.registry.all().find((x) => x.sessionId === cmd.uuid) : undefined;
  if (s) {
    // file-path asks too: their grant rows are made from the prompt itself (see handlePermissionAdd)
    s.suggestion = asked.length > 0 ? { grants: asked, value: typeof cmd.value === "string" ? cmd.value : undefined, at: Date.now() } : undefined;
  }
  res(true, undefined, { allow: false });
}

/** Files a grant must never answer for: the grants themselves and pi's own configuration. Such an ask always reaches the user. */
export function protectedPaths(): string[] {
  return [PERMISSIONS_FILE, piAgentDir()];
}

/**
 * Whether the daemon can answer a file-path prompt itself: every pair pi suggested for it is covered by a grant the user made from
 * an earlier prompt, and the ask is not about a protected file (`value` is what was asked about; the title is checked too, since
 * a command's value need not be the bare path). Only file-path surfaces: the grants link already settles every other kind.
 */
export function answerablePrompt(grants: GrantStore, uuid: string | undefined, request: Record<string, unknown>, value: string | undefined, protectedFiles: readonly string[] = protectedPaths()): Grant[] | undefined {
  const asked = (request.toriel as { grants?: PermissionGrantSpec[] } | undefined)?.grants ?? [];
  const options = Array.isArray(request.options) ? request.options : [];
  if (!uuid || request.method !== "select" || !options.includes("Yes") || asked.length === 0 || !asked.every((a) => isCappedSurface(a.surface))) {
    return undefined;
  }
  return touchesProtected([value ?? "", typeof request.title === "string" ? request.title : ""].join("\n"), protectedFiles) ? undefined : grants.covers(uuid, asked, true);
}

/**
 * Whether `text` (what an ask is about) names a protected file. Three spellings count: the absolute path, the `~` form, and the
 * path's last two segments (`.pi/agent`), which is what a relative spelling such as `../.pi/agent/mcp.json` or a repo-local `.pi/`
 * directory still contains. The text is also tried with `..` and `.` segments collapsed, so `/home/u/x/../.pi/agent` is seen as
 * what it is. Whitespace is ignored, since pi wraps long commands across lines. Matching too much only means one more prompt.
 */
export function touchesProtected(text: string, protectedFiles: readonly string[] = protectedPaths()): boolean {
  const home = os.homedir();
  const squash = (t: string) => t.replace(/\s+/g, "");
  const collapse = (t: string): string => {
    let cur = t.replace(/\/{2,}/g, "/").replace(/\/\.(?=\/)/g, "");
    for (let prev = ""; prev !== cur; ) {
      prev = cur;
      cur = cur.replace(/[^/]+\/\.\.(?=\/|$)\/?/, "");
    }
    return cur;
  };
  const flat = squash(text);
  const haystacks = [flat, collapse(flat)];
  const tail = (p: string) => p.split("/").filter(Boolean).slice(-2).join("/");
  const needles = protectedFiles.flatMap((p) => [squash(p), squash(p.startsWith(home) ? `~${p.slice(home.length)}` : p), squash(tail(p))]);
  return needles.some((n) => n.length > 0 && haystacks.some((h) => h.includes(n)));
}

/** A file-path grant comes only from answering the file-path prompt the daemon holds open for the session, with a pattern that covers what pi asked about. */
function checkPromptFor(ctx: DaemonContext, uuid: string, cmd: Cmd<"permission_add">): void {
  const s = ctx.registry.all().find((x) => x.sessionId === uuid);
  const open = s?.pendingDialog ? s.lastDialog : undefined;
  if (!open || cmd.dialog === undefined || open.id !== cmd.dialog) {
    throw new Error(`a "${cmd.surface}" (file-path) grant is made by answering the file-path prompt that is open for the session, and none matches`);
  }
  // such a prompt always reaches the user (see answerablePrompt), so a grant for it would sit in /permissions promising what never happens
  if (touchesProtected(typeof open.title === "string" ? open.title : "")) {
    throw new Error("this prompt is about the permission grants file or pi's own configuration; those are always asked about, so no grant is made for it");
  }
  const asked = ((open.toriel as { grants?: PermissionGrantSpec[] } | undefined)?.grants ?? []).filter((g) => g.surface === cmd.surface);
  if (asked.length === 0 || !asked.every((g) => coversPattern(cmd.pattern, g.pattern))) {
    throw new Error(`"${cmd.pattern}" does not cover what the prompt asked about (${asked.map((g) => JSON.stringify(g.pattern)).join(", ") || "nothing on this surface"})`);
  }
}

export function handlePermissionList(ctx: DaemonContext, cmd: Cmd<"permission_list">, res: Responder): void {
  res(true, undefined, { grants: ctx.grants.list(scopeOf(ctx, cmd)).map((g) => viewOfGrant(ctx, g)) });
}

/** No expiry for "session" / "never" (and when unset); otherwise a duration. */
function lifetimeOf(text: string | undefined): number | null {
  const t = text?.trim().toLowerCase();
  if (!t || t === "session" || t === "never") {
    return null;
  }
  const d = parseDurationText(t);
  if (!d.ok) {
    throw new Error(d.error);
  }
  return d.ms;
}

export function handlePermissionAdd(ctx: DaemonContext, cmd: Cmd<"permission_add">, res: Responder): void {
  const uuid = scopeOf(ctx, cmd);
  if (!uuid) {
    throw new Error("a grant needs a session");
  }
  const expiresIn = lifetimeOf(cmd.for);
  const fromPrompt = isCappedSurface(cmd.surface);
  if (fromPrompt) {
    checkPromptFor(ctx, uuid, cmd);
  }
  const g = ctx.grants.add({ session: uuid, surface: cmd.surface, pattern: cmd.pattern, expiresIn, source: fromPrompt ? "dialog" : cmd.source, note: cmd.note }, fromPrompt);
  const now = new Date();
  log(`permission grant #${g.id} (${g.source}) for session ${uuid}: ${g.surface} ${JSON.stringify(g.pattern)}${g.expiresAt === null ? "" : ` until ${fmtClock(g.expiresAt, now)}`}`);
  ctx.hub.broadcastSessions();
  res(true, undefined, { grant: viewOfGrant(ctx, g), echo: `granted ${g.surface} ${JSON.stringify(g.pattern)} ${g.expiresAt === null ? "until revoked" : `until ${fmtClock(g.expiresAt, now)}`}` });
}

/** The grants `ref` names within `scope`; throws on no match or an ambiguous pattern. */
function pickGrants(ctx: DaemonContext, scope: string | undefined, ref: string): Grant[] {
  const inScope = ctx.grants.list(scope);
  const key = ref.trim().replace(/^#/, "");
  if (/^\d+$/.test(key)) {
    const hit = inScope.find((g) => g.id === Number(key));
    if (!hit) {
      throw new Error(`no permission grant #${key}${scope ? " in this session" : ""} (/permissions lists them)`);
    }
    return [hit];
  }
  const named = inScope.filter((g) => g.pattern === ref.trim());
  if (named.length === 0) {
    throw new Error(`no permission grant for "${ref.trim()}"${scope ? " in this session" : ""} (/permissions lists them)`);
  }
  if (named.length > 1) {
    throw new Error(`${named.length} grants match "${ref.trim()}" (ids ${named.map((g) => `#${g.id}`).join(", ")}) - use the id`);
  }
  return named;
}

export function handlePermissionRevoke(ctx: DaemonContext, cmd: Cmd<"permission_revoke">, res: Responder): void {
  const scope = scopeOf(ctx, cmd);
  let targets: Grant[];
  if (cmd.all) {
    targets = ctx.grants.list(scope);
  } else if (cmd.ref) {
    targets = pickGrants(ctx, scope, cmd.ref);
  } else {
    throw new Error(`revoke which grant? Give an id or pattern (/permissions lists them)${scope ? ", or --all" : ""}`);
  }
  const views = targets.map((g) => viewOfGrant(ctx, g));
  for (const g of targets) {
    ctx.grants.revoke(g.id);
  }
  log(`permission revoke: ${targets.map((g) => `#${g.id}`).join(", ") || "(none)"}`);
  ctx.hub.broadcastSessions();
  res(true, undefined, { grants: views, count: targets.length });
}

export function handlePermissionRestore(ctx: DaemonContext, cmd: Cmd<"permission_restore">, res: Responder): void {
  const uuid = scopeOf(ctx, cmd);
  if (!uuid) {
    throw new Error("restore needs a session");
  }
  const n = ctx.grants.restore(uuid);
  log(`permission restore: ${n} grant(s) for session ${uuid}`);
  ctx.hub.broadcastSessions();
  res(true, undefined, { count: n });
}

/** Tell the sessions whose timed grants just ran out, and refresh the markers. */
export function announceExpired(ctx: DaemonContext, gone: Grant[]): void {
  if (gone.length === 0) {
    return;
  }
  for (const g of gone) {
    const s = ctx.registry.all().find((x) => x.sessionId === g.session);
    log(`permission grant #${g.id} expired (session ${g.session}): ${g.surface} ${JSON.stringify(g.pattern)}`);
    if (s) {
      ctx.hub.broadcast({ type: "notice", session: s.id, text: `permission grant #${g.id} expired: ${g.surface} ${JSON.stringify(g.pattern)}`, durable: true });
    }
  }
  ctx.hub.broadcastSessions();
}
