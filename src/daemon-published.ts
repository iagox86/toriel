// A published session is mirrored in chat whether or not anybody has opened it since the daemon started (ticket 280).
import type { DaemonContext } from "./daemon-context.ts";
import { findSession } from "./daemon-resolve.ts";
import { log } from "./log.ts";
import { errText } from "./util.ts";

/**
 * Register the published sessions the daemon does not know yet as sleeping sessions, so the session list (and with it the chat
 * bridge) carries them: a daemon that was restarted knows only the sessions a controller opened, and a published session nobody
 * opened would have no channel until someone did. Nothing is started: a registered session has no child until it is used. A session
 * whose file is gone is left out (and logged), not removed from the published list: the file may come back.
 */
export async function registerPublished(ctx: DaemonContext): Promise<number> {
  let added = 0;
  for (const uuid of ctx.published.ids()) {
    if (ctx.registry.all().some((s) => s.sessionId === uuid)) {
      continue;
    }
    try {
      const found = await findSession(ctx, uuid);
      if (found.id >= 0 || !found.file) {
        continue;
      }
      const s = ctx.registry.byFile(found.file) ?? ctx.registry.create(found.cwd ?? process.cwd(), found.file);
      s.sessionId = uuid;
      s.sessionName = s.sessionName ?? found.name;
      added++;
    } catch (err) {
      log(`published session ${uuid} is not on disk: ${errText(err)}`);
    }
  }
  if (added > 0) {
    log(`${added} published session(s) registered from their files`);
    ctx.hub.broadcastSessions();
  }
  return added;
}
