// The controller side of /permissions (docs/permissions.md): list, add, revoke and restore the
// permission grants the daemon keeps. The daemon does the work and owns the grants; these
// functions turn a parsed command into a request and its answer into a notice or panel.
// Shared by the session and switcher command tables.
import type { Choice, Invocation } from "./cli.ts";
import type { Host } from "./host.ts";
import { grantChoice, grantLabel, grantListing } from "./permission-format.ts";
import type { GrantView } from "./shared.ts";
import { errText } from "./util.ts";

const ACTIONS = [
  { value: "list", description: "show the grants (the default)" },
  { value: "add", description: "allow something without asking: add <surface> <pattern> [--for 1h]" },
  { value: "revoke", description: "take a grant away (no argument: pick from a list)" },
  { value: "restore", description: "turn on the grants saved before the daemon restarted" },
];
const SURFACES = [
  { value: "bash", description: "a shell command, as pi's prompt suggests it" },
  { value: "mcp", description: "an MCP tool, e.g. exa:*" },
  { value: "tool", description: "another tool" },
  { value: "skill", description: "a skill" },
];
const LIFETIMES = ["30m", "1h", "8h", "session"];

const USAGE = "/permissions [list | add <surface> <pattern> [--for 1h] | revoke [id|pattern] | restore]";

/** Tab completion: the action word, then the surface after `add`, then a `--for` lifetime. The value replaces the whole line after the command. */
export function permissionCompletions(typed: string): Choice[] {
  const life = /^(.*--for[ =])(\S*)$/.exec(typed);
  if (life) {
    return LIFETIMES.filter((l) => l.startsWith((life[2] as string).toLowerCase())).map((l) => ({ value: `${life[1]}${l}` }));
  }
  const words = typed.split(/\s+/);
  if (words.length === 1) {
    return ACTIONS.filter((a) => a.value.startsWith((words[0] as string).toLowerCase())).map((a) => ({ value: a.value, description: a.description }));
  }
  if (words.length === 2 && words[0] === "add") {
    return SURFACES.filter((s) => s.value.startsWith((words[1] as string).toLowerCase())).map((s) => ({ value: `add ${s.value}`, description: s.description }));
  }
  return [];
}

/** `/permissions [action] ...` in the session with daemon number `session` (undefined in the switcher: all sessions). */
export async function runPermissions(h: Host, call: Invocation, session: number | undefined): Promise<void> {
  const action = (call.args[0] ?? "list").toLowerCase();
  const rest = call.args.slice(1);
  if (action === "list") {
    await showGrants(h, call.opts.all === true ? undefined : session);
  } else if (action === "add") {
    await addGrant(h, call, rest, session);
  } else if (action === "revoke" || action === "remove") {
    await revokeGrant(h, rest.join(" "), call.opts.all === true, session);
  } else if (action === "restore") {
    await restoreGrants(h, session);
  } else {
    h.notify(`/permissions: "${action}" is not an action. ${USAGE}`);
  }
}

async function showGrants(h: Host, session: number | undefined): Promise<void> {
  try {
    const r = (await h.request({ type: "permission_list", session })) as { grants: GrantView[] };
    if (r.grants.length === 0) {
      h.notify(session === undefined ? "no permission grants (in a session: /permissions add bash \"git status\" --for 1h; /permissions --help)" : "no permission grants in this session - /permissions add <surface> <pattern> [--for 1h] makes one, or pick \"allow for 1 hour\" in a permission prompt (/permissions --all lists every session's)");
      return;
    }
    h.infoPanel.show(grantListing(r.grants, new Date(), session === undefined));
    h.tui.requestRender();
  } catch (err) {
    h.notify(`/permissions: ${errText(err)}`);
  }
}

async function addGrant(h: Host, call: Invocation, rest: string[], session: number | undefined): Promise<void> {
  if (session === undefined) {
    h.notify("/permissions add: open the session first - a grant belongs to one session");
    return;
  }
  const [surface, ...words] = rest;
  const pattern = words.join(" ");
  if (!surface || !pattern) {
    h.notify(`/permissions add needs a surface and a pattern, e.g. /permissions add bash "git status" --for 1h (surfaces: bash, mcp, tool, skill)`);
    return;
  }
  const forText = call.opts.for as string | undefined;
  if (forText !== undefined && call.opts.session === true) {
    h.notify("/permissions add: use --for <time> or --session, not both");
    return;
  }
  try {
    const r = (await h.request({ type: "permission_add", session, surface, pattern, for: call.opts.session === true ? "session" : forText, note: call.opts.note as string | undefined, source: "command" })) as { echo: string };
    h.notify(r.echo);
  } catch (err) {
    h.notify(`/permissions add: ${errText(err)}`);
  }
}

async function revokeGrant(h: Host, ref: string, all: boolean, session: number | undefined): Promise<void> {
  if (!ref && !all) {
    await pickGrant(h, session);
    return;
  }
  try {
    const r = (await h.request({ type: "permission_revoke", ref: ref || undefined, all, session })) as { grants: GrantView[]; count: number };
    h.notify(r.count === 0 ? "no grants to revoke" : r.count === 1 ? `revoked ${grantLabel(r.grants[0] as GrantView)}` : `revoked ${r.count} grants`);
  } catch (err) {
    h.notify(`/permissions revoke: ${errText(err)}`);
  }
}

/** With no grant named: a dropdown of the grants in scope; picking one revokes it. */
async function pickGrant(h: Host, session: number | undefined): Promise<void> {
  try {
    const r = (await h.request({ type: "permission_list", session })) as { grants: GrantView[] };
    if (r.grants.length === 0) {
      h.notify("no permission grants to revoke");
      return;
    }
    const now = new Date();
    const byLabel = new Map(r.grants.map((g) => [grantChoice(g, now, session === undefined), g.id]));
    h.choicePanel.open("Revoke which permission grant?", [...byLabel.keys()], undefined, (choice) => {
      const id = byLabel.get(choice);
      if (id !== undefined) {
        void revokeGrant(h, String(id), false, session);
      }
    });
    h.tui.requestRender();
  } catch (err) {
    h.notify(`/permissions revoke: ${errText(err)}`);
  }
}

async function restoreGrants(h: Host, session: number | undefined): Promise<void> {
  if (session === undefined) {
    h.notify("/permissions restore: open the session first - saved grants are turned on per session");
    return;
  }
  try {
    const r = (await h.request({ type: "permission_restore", session })) as { count: number };
    h.notify(r.count === 0 ? "no saved grants to turn on in this session" : `turned on ${r.count} saved grant${r.count === 1 ? "" : "s"}`);
  } catch (err) {
    h.notify(`/permissions restore: ${errText(err)}`);
  }
}
