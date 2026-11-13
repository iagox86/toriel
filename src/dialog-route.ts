// Which session's dialog is on screen. A dialog belongs to the session whose agent
// raised it, but a subagent usually runs where nobody is looking, so its dialog is
// shown in its parent's view (labelled with the subagent's name) and the answer goes
// back to the subagent. Pure: views and session metas in, a view key out.
import type { DialogRequest } from "./dialogs.ts";
import type { SessionMeta } from "./shared.ts";

/**
 * The view key holding the dialog to show while `viewing` is on screen: that session's
 * own dialog first, else the dialog of a subagent it started that is waiting on one
 * (lowest session number first), provided this controller is attached to that session. undefined when nothing is waiting.
 */
export function dialogOwner(
  viewing: string | null,
  views: ReadonlyMap<string, { dialog?: DialogRequest }>,
  metas: Iterable<SessionMeta>,
  keyFor: (meta: SessionMeta) => string,
): string | undefined {
  if (!viewing) {
    return undefined;
  }
  if (views.get(viewing)?.dialog) {
    return viewing;
  }
  const all = [...metas];
  const parent = all.find((m) => keyFor(m) === viewing);
  const uuid = parent?.sessionId;
  // only the controller driving the parent speaks for its subagents: with two controllers on one parent the other shows nothing to answer
  if (!uuid || !parent?.attachedToYou) {
    return undefined;
  }
  return all
    .filter((m) => m.subagent?.parent === uuid && m.pendingDialog && views.get(keyFor(m))?.dialog)
    .sort((a, b) => a.id - b.id)
    .map(keyFor)[0];
}
