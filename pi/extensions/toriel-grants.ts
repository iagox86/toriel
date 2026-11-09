// toriel grants: lets the permission grants the toriel daemon keeps (docs/permissions.md)
// answer pi-permission-system's asks. It registers an authorizer chain link, "toriel-grants":
// when a request lands on `ask`, pi runs the links named in `authorizerChain` (its
// config.json) before opening the dialog, and this one allows the ask when the daemon holds a
// matching grant, else defers to the dialog. Every failure defers: more prompting, never less.
// The one exception is the TORIEL_SCOPE_ROOT scope check (scopeVerdict): it fails closed,
// denying a covered write outside the session's write scope, and it still never throws. A
// link that throws would block the tool call, so nothing here may throw. Runs only in children
// the toriel daemon starts (TORIEL_CHILD).
import { ask } from "./toriel-agents.ts";
import { isInside, readScope, type Scope } from "./lib/scope-root.ts";

export const LINK_NAME = "toriel-grants";
/** How long the daemon gets to answer; a slow answer is a deferred one. */
export const CHECK_TIMEOUT_MS = 1000;

/** pi-permission-system publishes each session's service in this process-global map (a package cannot import it from outside). */
const SERVICES = Symbol.for("@gotgenes/pi-permission-system:session-services");

type Verdict = { kind: "allow" } | { kind: "defer" } | { kind: "deny"; reason: string };
type Asker = (sock: string, cmd: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>;

interface AskDetails {
  command?: string;
  path?: string;
  target?: string;
  surface?: unknown;
  accessIntent?: { surface?: unknown; boundaryValue?: unknown };
  sessionApproval?: { grants?: Array<{ surface?: unknown; pattern?: unknown }> };
  payload?: { request?: { value?: unknown } };
}

interface Service {
  registerAuthorizer?(name: string, authorize: (details: AskDetails) => Promise<Verdict>): () => void;
}

interface Pi {
  events: { on(channel: string, handler: (data: unknown) => void): void };
  on(event: string, handler: () => void): void;
}

/** The ask as the daemon wants it: pi's suggested grants, and the value they are about. */
export function describeAsk(details: AskDetails): { grants: Array<{ surface: string; pattern: string }>; value?: string } {
  const grants = (details.sessionApproval?.grants ?? []).flatMap((g) => (typeof g.surface === "string" && typeof g.pattern === "string" ? [{ surface: g.surface, pattern: g.pattern }] : []));
  const requested = details.payload?.request?.value;
  const value = typeof requested === "string" ? requested : (details.command ?? details.path ?? details.target);
  return { grants, value };
}

/** The write-shaped surfaces this guard decides on (settled by the step 0 probe; bare `write`/`bash`/`read` are in-W by construction and defer). */
export const COVERED = new Set(["external_directory_write", "external_directory", "path_write"]);

const deny = (reason: string): Verdict => ({ kind: "deny", reason });

/**
 * The TORIEL_SCOPE_ROOT scope check. Decides on `accessIntent.boundaryValue` only - never on
 * matchValues, grant patterns, or the display path; a covered write with no canonical target is
 * denied, because it cannot be proven inside the root. Total: never throws, even when details
 * is null, a string, or carries throwing getters.
 */
export function scopeVerdict(scope: Scope, details: AskDetails): Verdict {
  try {
    if (scope.kind === "off") {
      return { kind: "defer" };
    }
    const accessIntent = details?.accessIntent;
    const surface = typeof accessIntent?.surface === "string" ? accessIntent.surface : (typeof details?.surface === "string" ? details.surface : undefined);
    if (surface === undefined || !COVERED.has(surface)) {
      return { kind: "defer" };
    }
    if (scope.kind === "invalid") {
      return deny(`scope guard: TORIEL_SCOPE_ROOT is set but unusable (${scope.why}); denying all writes. Fix the environment the daemon starts this session with.`);
    }
    const boundary = accessIntent?.boundaryValue;
    if (typeof boundary !== "string" || boundary === "") {
      return deny(`scope guard: cannot resolve a canonical target for this write; denying (scope root ${scope.root})`);
    }
    if (isInside(scope.root, boundary)) {
      return { kind: "defer" };
    }
    return deny(`scope guard: ${boundary} is outside this session's write scope ${scope.root} (TORIEL_SCOPE_ROOT). Write only under ${scope.root}.`);
  } catch {
    return scope.kind === "off" ? { kind: "defer" } : deny("scope guard: internal error evaluating this write; denying");
  }
}

/** Deny covered out-of-scope writes first (never reaching the daemon), then allow when the daemon holds a grant that covers the ask; defer on anything else, including every error. */
export async function authorize(sock: string, uuid: string | undefined, details: AskDetails, send: Asker = ask, scope: Scope = { kind: "off" }): Promise<Verdict> {
  const sv = scopeVerdict(scope, details);
  if (sv.kind === "deny") {
    return sv;
  }
  try {
    if (!uuid) {
      return { kind: "defer" };
    }
    const { grants, value } = describeAsk(details);
    if (grants.length === 0) {
      return { kind: "defer" };
    }
    const reply = await send(sock, { type: "permission_check", uuid, grants, value }, CHECK_TIMEOUT_MS);
    return reply.allow === true ? { kind: "allow" } : { kind: "defer" };
  } catch {
    return { kind: "defer" };
  }
}

export default function (pi: Pi) {
  const sock = process.env.TORIEL_SOCK;
  if (!process.env.TORIEL_CHILD || !sock) {
    return;
  }
  // The scope is read once here (the daemon sets TORIEL_SCOPE_ROOT only for the children it wants fenced) and closed over; it is never re-read per ask.
  const scope = readScope(process.env);
  let dispose: (() => void) | undefined;
  // `permissions:ready` fires more than once per session and registering the same name twice throws
  pi.events.on("permissions:ready", (data) => {
    const sessionId = (data as { sessionId?: string | null } | undefined)?.sessionId;
    if (dispose || !sessionId) {
      return;
    }
    try {
      const services = (globalThis as Record<symbol, unknown>)[SERVICES] as Map<string, Service> | undefined;
      dispose = services?.get(sessionId)?.registerAuthorizer?.(LINK_NAME, (details) => authorize(sock, process.env.TORIEL_SESSION_ID ?? sessionId, details, ask, scope));
    } catch {
      // the package is older than the authorizer seam, or the link already exists: asks keep their dialogs
    }
  });
  pi.on("session_shutdown", () => {
    dispose?.();
    dispose = undefined;
  });
}
