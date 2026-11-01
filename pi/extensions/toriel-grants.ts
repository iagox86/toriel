// toriel grants: lets the permission grants the toriel daemon keeps (docs/permissions.md)
// answer pi-permission-system's asks. It registers an authorizer chain link, "toriel-grants":
// when a request lands on `ask`, pi runs the links named in `authorizerChain` (its
// config.json) before opening the dialog, and this one allows the ask when the daemon holds a
// matching grant, else defers to the dialog. Every failure defers: more prompting, never less.
// A link that throws would block the tool call, so nothing here may throw. Runs only in
// children the toriel daemon starts (TORIEL_CHILD).
import { ask } from "./toriel-agents.ts";

export const LINK_NAME = "toriel-grants";
/** How long the daemon gets to answer; a slow answer is a deferred one. */
export const CHECK_TIMEOUT_MS = 1000;

/** pi-permission-system publishes each session's service in this process-global map (a package cannot import it from outside). */
const SERVICES = Symbol.for("@gotgenes/pi-permission-system:session-services");

type Verdict = { kind: "allow" } | { kind: "defer" };
type Asker = (sock: string, cmd: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>;

interface AskDetails {
  command?: string;
  path?: string;
  target?: string;
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

/** Allow when the daemon holds a grant that covers the ask; defer on anything else, including every error. */
export async function authorize(sock: string, uuid: string | undefined, details: AskDetails, send: Asker = ask): Promise<Verdict> {
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
  let dispose: (() => void) | undefined;
  // `permissions:ready` fires more than once per session and registering the same name twice throws
  pi.events.on("permissions:ready", (data) => {
    const sessionId = (data as { sessionId?: string | null } | undefined)?.sessionId;
    if (dispose || !sessionId) {
      return;
    }
    try {
      const services = (globalThis as Record<symbol, unknown>)[SERVICES] as Map<string, Service> | undefined;
      dispose = services?.get(sessionId)?.registerAuthorizer?.(LINK_NAME, (details) => authorize(sock, process.env.TORIEL_SESSION_ID ?? sessionId, details));
    } catch {
      // the package is older than the authorizer seam, or the link already exists: asks keep their dialogs
    }
  });
  pi.on("session_shutdown", () => {
    dispose?.();
    dispose = undefined;
  });
}
