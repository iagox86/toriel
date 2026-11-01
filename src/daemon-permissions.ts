// The daemon's side of permission grants (docs/permissions.md): the handlers for the
// permission_* commands. The store itself is pure (src/permissions.ts); the toriel-grants
// link in each child asks `permission_check` before pi's dialog opens.
import type { Cmd, DaemonContext, Responder } from "./daemon-context.ts";
import { scopeOf } from "./daemon-schedule.ts";
import { log } from "./log.ts";
import { type Grant, isCappedSurface } from "./permissions.ts";
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
    const grantable = asked.filter((a) => !isCappedSurface(a.surface));
    s.suggestion = grantable.length > 0 && grantable.length === asked.length ? { grants: grantable, value: typeof cmd.value === "string" ? cmd.value : undefined, at: Date.now() } : undefined;
  }
  res(true, undefined, { allow: false });
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
  const g = ctx.grants.add({ session: uuid, surface: cmd.surface, pattern: cmd.pattern, expiresIn, source: cmd.source, note: cmd.note });
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
      ctx.hub.broadcast({ type: "notice", session: s.id, text: `permission grant #${g.id} expired: ${g.surface} ${JSON.stringify(g.pattern)}` });
    }
  }
  ctx.hub.broadcastSessions();
}
