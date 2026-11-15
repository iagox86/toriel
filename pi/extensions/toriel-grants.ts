// toriel grants: lets the permission grants the toriel daemon keeps (docs/permissions.md)
// answer pi-permission-system's asks. It registers an authorizer chain link, "toriel-grants":
// when a request lands on `ask`, pi runs the links named in `authorizerChain` (its
// config.json) before opening the dialog, and this one allows the ask when the daemon holds a
// matching grant, else defers to the dialog. Every failure defers: more prompting, never less.
// The one exception is the TORIEL_SCOPE_ROOT scope check (scopeVerdict) in deny mode: it fails
// closed, denying a covered write outside the session's write scope. In ask mode the scope half
// defers instead (the dialog, the grants and the parent-forwarding decide - never a silent
// allow, never a deny from the guard itself), and it still never throws: a link that throws
// would block the tool call, so nothing here may throw. Runs only in children
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

/** The slice of the package's `PermissionQuery` (handed to a link at authorize time) this file uses. */
interface Query {
  checkPermission?(surface: string, value?: string, agentName?: string): { state?: string; matchedPattern?: string; origin?: unknown; floor?: string };
}

/** Why pi asks, as the daemon wants it (see AskRule in src/shared.ts). */
export interface AskRuleReport {
  explicit: boolean;
  pattern?: string;
  origin?: string;
}

interface Service {
  checkPermission?(surface: string, value?: string): { state?: string; reason?: string; matchedPattern?: string; origin?: unknown };
  registerAuthorizer?(name: string, authorize: (details: AskDetails, query?: Query) => Promise<Verdict>): () => void;
}

interface Pi {
  registerTool?(tool: Record<string, unknown>): void;
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

/** Config scopes whose rules are the owner's own; "fail-closed" is the package flooring allows to asks because a scope's config is invalid. */
const OWNER_ORIGINS = new Set(["global", "project", "agent", "project-agent", "fail-closed"]);

/**
 * Whether this ask comes from a rule the owner wrote (or a package safety floor) or only from the catch-all default (ticket 213:
 * auto mode answers the second kind and leaves the first to the user). Read from the package's own policy at gate parity, through the
 * query it hands a link; undefined when it cannot tell (no query, a surface it does not know, a throw), which the daemon treats as
 * "ask the user". A rule with the bare pattern "*" is the surface's catch-all, not something written about this action.
 */
export function askRule(query: Query | undefined, details: AskDetails, agentName?: string | null): AskRuleReport | undefined {
  try {
    const surface = typeof details.accessIntent?.surface === "string" ? details.accessIntent.surface : typeof details.surface === "string" ? details.surface : undefined;
    if (!query?.checkPermission || surface === undefined) {
      return undefined;
    }
    const { value } = describeAsk(details);
    const r = query.checkPermission(surface, value, agentName ?? undefined);
    if (r.state !== "ask") {
      // the gate asked but this query does not: the two disagree (a surface name it reads differently, say), so the reason is unknown, and unknown is never a yes
      return undefined;
    }
    const origin = typeof r.origin === "string" ? r.origin : undefined;
    const pattern = typeof r.matchedPattern === "string" ? r.matchedPattern : undefined;
    const explicit = r.floor !== undefined || origin === "fail-closed" || (origin !== undefined && OWNER_ORIGINS.has(origin) && pattern !== undefined && pattern !== "*");
    return { explicit, pattern, origin };
  } catch {
    return undefined;
  }
}

/** The write-shaped surfaces this guard decides on (settled by the step 0 probe; bare `write`/`bash`/`read` are in-W by construction and defer). */
export const COVERED = new Set(["external_directory_write", "external_directory", "path_write"]);

const deny = (reason: string): Verdict => ({ kind: "deny", reason });

/**
 * The TORIEL_SCOPE_ROOT scope check, mode-aware (SPEC-172-T8). Decides on
 * `accessIntent.boundaryValue` only - never on matchValues, grant patterns, or
 * the display path; a covered write with no canonical target is denied in deny
 * mode (it cannot be proven inside the root) and deferred in ask mode
 * (unknowable, so prompt). Deny mode is T1 byte-for-byte; ask mode defers every
 * covered write the guard cannot prove inside - the dialog/grants/parent decide,
 * never a silent allow. Total: never throws, even when details is null, a
 * string, or carries throwing getters.
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
      if (scope.mode === "ask") {
        return { kind: "defer" };
      }
      return deny(`scope guard: TORIEL_SCOPE_ROOT is set but unusable (${scope.why}); denying all writes. Fix the environment the daemon starts this session with.`);
    }
    const boundary = accessIntent?.boundaryValue;
    if (typeof boundary !== "string" || boundary === "") {
      if (scope.mode === "ask") {
        return { kind: "defer" };
      }
      return deny(`scope guard: cannot resolve a canonical target for this write; denying (scope root ${scope.root})`);
    }
    if (isInside(scope.root, boundary)) {
      return { kind: "defer" };
    }
    if (scope.mode === "ask") {
      return { kind: "defer" };
    }
    return deny(`scope guard: ${boundary} is outside this session's write scope ${scope.root} (TORIEL_SCOPE_ROOT). Write only under ${scope.root}.`);
  } catch {
    return scope.kind === "off" || scope.mode === "ask" ? { kind: "defer" } : deny("scope guard: internal error evaluating this write; denying");
  }
}

/** The scope half denies (deny mode) or defers (ask mode) first (never reaching the daemon on a deny), then allow when the daemon holds a grant that covers the ask; defer on anything else, including every error. */
export async function authorize(sock: string, uuid: string | undefined, details: AskDetails, send: Asker = ask, scope: Scope = { kind: "off" }, query?: Query, agentName?: string | null): Promise<Verdict> {
  const sv = scopeVerdict(scope, details);
  if (sv.kind === "deny") {
    return sv;
  }
  try {
    if (!uuid) {
      return { kind: "defer" };
    }
    const { grants, value } = describeAsk(details);
    // the reason for the ask rides along (ticket 213), so the daemon can tell a rule the owner wrote from the default
    const rule = askRule(query, details, agentName);
    if (grants.length === 0 && rule === undefined) {
      return { kind: "defer" };
    }
    const reply = await send(sock, { type: "permission_check", uuid, grants, value, ...(rule !== undefined ? { rule } : {}) }, CHECK_TIMEOUT_MS);
    return reply.allow === true ? { kind: "allow" } : { kind: "defer" };
  } catch {
    return { kind: "defer" };
  }
}

const WARN = "This is a snapshot: grants expire and rules change. It does not say whether anyone is there to answer a prompt, or would approve one.";

/** HH:MM in local time. */
function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * toriel_permission_check (ticket 94): would this one action run without a prompt? The package's own policy
 * answer, and when that is `ask`, whether a toriel grant of this session covers it. Never throws; every failure
 * says it could not tell, which an agent must read as "assume a prompt".
 */
export async function checkAction(service: Service | undefined, sock: string, uuid: string | undefined, surface: string, value: string | undefined, send: Asker = ask): Promise<string> {
  if (surface.trim() === "") {
    return "Give a surface, such as bash, read, edit, write, mcp, skill or external_directory_write, and the value to check (the command, tool name or path).";
  }
  if (!service?.checkPermission) {
    return `Cannot check: the permission system is not available in this session, so assume any action may prompt. ${WARN}`;
  }
  let result: ReturnType<NonNullable<Service["checkPermission"]>>;
  try {
    result = service.checkPermission(surface, value);
  } catch (err) {
    return `Cannot check ${surface}${value === undefined ? "" : ` ${JSON.stringify(value)}`}: ${err instanceof Error ? err.message : String(err)}. Assume it may prompt.`;
  }
  const what = `${surface}${value === undefined ? "" : ` ${JSON.stringify(value)}`}`;
  const rule = result.matchedPattern !== undefined ? ` (rule ${JSON.stringify(result.matchedPattern)})` : "";
  if (result.state === "allow") {
    return `allow: ${what} runs without a prompt${rule}. ${WARN}`;
  }
  if (result.state === "deny") {
    return `deny: ${what} is refused${rule}${result.reason ? `: ${result.reason}` : ""}. Pick another route; asking the user may change the policy. ${WARN}`;
  }
  if (result.state !== "ask") {
    return `Cannot tell: the permission system answered ${JSON.stringify(result.state)} for ${what}. Assume it may prompt.`;
  }
  // a real ask for a compound command is one grant per part; a grant that covers the whole string says nothing about the parts, so it is never reported as "granted"
  const compound = surface === "bash" && value !== undefined && /[;&|`\n]|\$\(|[<>]\(/.test(value);
  if (uuid && !compound) {
    try {
      const reply = await send(sock, { type: "permission_check", uuid, grants: [{ surface, pattern: value ?? "*" }], value, probe: true }, CHECK_TIMEOUT_MS);
      if (reply.allow === true) {
        const until = typeof reply.expiresAt === "number" ? `until ${clock(reply.expiresAt)}` : "until the user revokes it";
        return `granted: ${what} would ask, but a permission grant for this session covers it ${until}, so it runs without a prompt. ${WARN}`;
      }
    } catch {
      // the daemon did not answer: report the policy's own answer, which is still true
    }
  }
  const parts = compound ? " This is a compound command (&&, ||, ;, |, a pipe, backticks or $( )): it may still prompt for its individual parts even if grants exist, so check the parts separately." : "";
  return `ask: ${what} opens a permission prompt${rule}.${parts} ${WARN} In an unattended or scheduled run nobody may answer, so prefer an allowed route, or finish by saying exactly what you need approved.`;
}

export default function (pi: Pi) {
  const sock = process.env.TORIEL_SOCK;
  if (!process.env.TORIEL_CHILD || !sock) {
    return;
  }
  // The scope is read once here (the daemon sets TORIEL_SCOPE_ROOT only for the children it wants fenced) and closed over; it is never re-read per ask.
  const scope = readScope(process.env);
  let dispose: (() => void) | undefined;
  let service: Service | undefined;
  // opt-in: it is not in TORIEL_TOOLS, so only a profile that names toriel_permission_check in its tools gets it (weaker models over-call tools)
  pi.registerTool?.({
    name: "toriel_permission_check",
    label: "Permission check",
    defaultActive: false, // opt-in: a profile that wants it names it in tools
    description:
      "Ask whether ONE specific action would run without a permission prompt: allow, deny, ask, or granted (a user's grant covers it, with its expiry). Use it before batch or unattended work to pick a route that will not block, or to end with exactly what needs approval - not before every command: a refused action already tells you which rule stopped it. 'ask' does not say anyone is present or will approve.",
    promptSnippet: "toriel_permission_check: would this action prompt, be allowed or be denied",
    parameters: {
      type: "object",
      properties: {
        surface: { type: "string", description: "The permission surface: bash, read, edit, write, mcp, skill, external_directory_write, ..." },
        value: { type: "string", description: "What to check: the command, tool name, skill name or path. Omit for the surface as a whole." },
      },
      required: ["surface"],
      additionalProperties: false,
    },
    async execute(_id: string, params: { surface?: string; value?: string }) {
      const text = await checkAction(service, sock, process.env.TORIEL_SESSION_ID, params.surface ?? "", params.value);
      return { content: [{ type: "text", text }], details: {} };
    },
  });
  // `permissions:ready` fires more than once per session and registering the same name twice throws
  pi.events.on("permissions:ready", (data) => {
    const sessionId = (data as { sessionId?: string | null } | undefined)?.sessionId;
    if (dispose || !sessionId) {
      return;
    }
    try {
      const services = (globalThis as Record<symbol, unknown>)[SERVICES] as Map<string, Service> | undefined;
      service = services?.get(sessionId);
      dispose = services?.get(sessionId)?.registerAuthorizer?.(LINK_NAME, (details, query) => authorize(sock, process.env.TORIEL_SESSION_ID ?? sessionId, details, ask, scope, query, (details as { agentName?: string | null }).agentName));
    } catch {
      // the package is older than the authorizer seam, or the link already exists: asks keep their dialogs
    }
  });
  pi.on("session_shutdown", () => {
    dispose?.();
    dispose = undefined;
  });
}
