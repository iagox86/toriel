// toriel veto (ticket 219, docs/permission-gate-decision.md): the scope boundary as a pi `tool_call` handler that can only block.
// The toriel-grants authorizer link decides only when a rule says `ask`, so a rule that allows a write or a command outright never
// reached the scope guard. This handler sees every call of a directory-scoped session (TORIEL_SCOPE_ROOT, deny mode), whatever the
// rules say, and blocks a write/edit target outside the root and a bash interpreter payload that names a path outside it. It never
// prompts, never allows anything the permission system would not, and never throws. The link keeps its own check as a second opinion.
// Runs only in children the toriel daemon starts (TORIEL_CHILD).
import { readScope, vetoVerdict } from "./lib/scope-root.ts";

interface Pi {
  on(event: "tool_call", handler: (event: { toolName?: unknown; input?: unknown }, ctx?: { cwd?: string }) => { block: true; reason: string } | undefined): void;
}

export default function (pi: Pi) {
  if (!process.env.TORIEL_CHILD) {
    return;
  }
  const scope = readScope(process.env);
  if (scope.kind === "off") {
    return;
  }
  pi.on("tool_call", (event, ctx) => {
    const reason = vetoVerdict(scope, typeof event?.toolName === "string" ? event.toolName : "", event?.input, ctx?.cwd ?? process.cwd());
    return reason === undefined ? undefined : { block: true, reason };
  });
}
