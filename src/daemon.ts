// toriel daemon: owns pi sessions and their child processes, bridges them to
// controllers over a unix socket. Killing a controller never touches a child.
//
// Session model:
//   active/streaming - live child, run in flight
//   active/idle      - live child, settled
//   inactive         - no child; session file only, lazily respawned
//   dead             - child exited unexpectedly; respawnable
//
// Input on a live session is exclusively attached to one controller socket;
// event streams fan out to every connected controller (viewing is never
// exclusive). Deletes never unlink: files move to the toriel trash dir with a
// restore manifest, because the session file is the only copy of a session.
//
// Run: node daemon.ts   (from a shell where `node` is v26; children inherit
// this env, including pi settings/auth/extensions.)
import "./migrate-on-start.ts";
import * as fs from "node:fs";
import { LOG, PERMISSIONS_FILE, PID_FILE, SCHEDULES_FILE, SOCK } from "./config.ts";
import { BridgeTracker } from "./daemon-bridge.ts";
import { ChildManager } from "./daemon-children.ts";
import type { DaemonContext } from "./daemon-context.ts";
import { acquireDaemonLock, releaseDaemonLock } from "./daemon-lock.ts";
import { ClientHub } from "./daemon-hub.ts";
import { announceExpired } from "./daemon-permissions.ts";
import { sessionMetas } from "./daemon-meta.ts";
import { schedulerHost } from "./daemon-schedule.ts";
import { createServer } from "./daemon-server.ts";
import { SessionRegistry } from "./daemon-session.ts";
import { log } from "./log.ts";
import { DEFAULT_GRANT_LIMITS, GrantStore } from "./permissions.ts";
import { Presence } from "./presence.ts";
import { DEFAULT_LIMITS, Scheduler } from "./scheduler.ts";
import { needsAwake, SleepInhibitor } from "./sleep-inhibit.ts";
import { collectFindings } from "./doctor.ts";
import { loadSettings } from "./settings.ts";
import type { UsageReport } from "./shared.ts";
import { errText, rotateLog } from "./util.ts";

/** Wire the daemon's collaborators together; `shutdown` is late-bound because they need each other first. */
function createContext(shutdown: () => void): DaemonContext {
  const registry = new SessionRegistry();
  const presence = new Presence();
  const usage = new Map<string, UsageReport>();
  const hub = new ClientHub((socket) => sessionMetas(registry, presence, usage, socket, ctx.scheduler, ctx.grants));
  const bridges = new BridgeTracker();
  const children = new ChildManager(hub, usage, bridges);
  // the scheduler's host reads the context lazily, so it can be built inside it
  const grants = new GrantStore(PERMISSIONS_FILE, Date.now, { perSession: loadSettings().settings.permissionGrantLimit ?? DEFAULT_GRANT_LIMITS.perSession });
  const ctx: DaemonContext = { registry, hub, children, presence, bridges, scheduler: new Scheduler(schedulerHost(() => ctx, usage), SCHEDULES_FILE, { ...DEFAULT_LIMITS, dailyFires: loadSettings().settings.scheduleDailyLimit ?? DEFAULT_LIMITS.dailyFires }), grants, shutdown };
  // a session going idle is what a waiting schedule is looking for, and what starts a gap loop's countdown
  children.onSettled = (s) => {
    if (s.sessionId) {
      ctx.scheduler.runFinished(s.sessionId);
    }
    ctx.scheduler.poke();
  };
  return ctx;
}

async function main(): Promise<void> {
  let shuttingDown = false;
  const ctx = createContext(() => shutdown());
  const server = createServer(ctx);

  function shutdown(): void {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log("daemon shutting down");
    server.close();
    ctx.scheduler.stop();
    inhibitor.stop();
    for (const s of ctx.registry.all()) {
      if (s.child) {
        void s.child.stop().catch(() => {});
      }
    }
    fs.rmSync(SOCK, { force: true });
    releaseDaemonLock(PID_FILE);
    process.exit(0);
  }

  const inhibitor = new SleepInhibitor({ log });
  const keepAwake = (): void => inhibitor.update(process.env.TORIEL_NO_INHIBIT !== "1" && loadSettings().settings.preventSleep !== false && needsAwake(ctx.registry.all(), ctx.scheduler.list(), Date.now()));

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const lock = acquireDaemonLock(PID_FILE);
  if (!lock.acquired) {
    // the socket (and with it the running daemon's clients) must not be taken over
    const msg = `a toriel daemon is already running (pid ${lock.pid}, lock ${PID_FILE}); not starting another`;
    log(msg);
    process.stderr.write(`${msg}\n`);
    process.exit(1);
  }
  log("daemon starting");
  fs.rmSync(SOCK, { force: true });
  // The socket is an unauthenticated command channel (spawn, prompt, ...), so it
  // must be owner-only from the moment it exists: the umask covers the bind,
  // the chmod covers a umask that was looser than we asked for.
  const prevMask = process.umask(0o177);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(SOCK, resolve);
    });
  } catch (err) {
    // the daemon runs detached with no stdio, so the log is the only place this shows
    log(`cannot listen on ${SOCK}: ${errText(err)}`);
    releaseDaemonLock(PID_FILE);
    process.exit(1);
  } finally {
    process.umask(prevMask);
  }
  fs.chmodSync(SOCK, 0o600);
  log(`listening on ${SOCK} (pid ${process.pid})`);
  ctx.scheduler.start();
  ctx.grants.load();
  // timed grants lapse by themselves (the store never matches an expired one); this only says so
  const grantKeeper = setInterval(() => announceExpired(ctx, ctx.grants.sweep()), 30_000);
  grantKeeper.unref();
  const awakeKeeper = setInterval(keepAwake, 5_000);
  awakeKeeper.unref();
  // the start-up self-check: every finding is logged, the controller's notice line shows the ones that matter most
  for (const f of collectFindings({ permissionSystem: loadSettings().settings.warnNoPermissionSystem !== false, startup: [] })) {
    log(`WARNING [${f.level}]: ${f.message}`);
  }

  // Prune external presence registrations whose pi exited, whose session
  // file was deleted (e.g. via pi's resume picker), or that stopped
  // heartbeating.
  const pruner = setInterval(() => {
    const dropped = ctx.presence.prune();
    for (const { file, reason } of dropped) {
      log(`external presence dropped (${reason}): ${file}`);
    }
    if (dropped.length > 0) {
      ctx.hub.broadcastSessions();
    }
  }, 3_000);
  pruner.unref();

  // the log lives for as long as the daemon does; keep it bounded
  rotateLog(LOG);
  const logKeeper = setInterval(() => rotateLog(LOG), 10 * 60_000);
  logKeeper.unref();

  // Liveness poll: refresh metadata, notice crashed children. Also detect
  // orphaning: if our socket file is deleted (rm -rf of the runtime dir),
  // no controller can ever reach us again, so exit instead of haunting.
  const poller = setInterval(() => {
    if (!fs.existsSync(SOCK)) {
      log("socket file removed - orphaned daemon exiting");
      shutdown();
      return;
    }
    for (const s of ctx.registry.all()) {
      if (s.child) {
        void ctx.children.refreshMeta(s).then(() => ctx.hub.broadcastSessions());
      }
    }
  }, 15_000);
  poller.unref();
}

await main();
