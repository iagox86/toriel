// The unix-socket server: turns connections into controllers, lines into
// commands, and closed sockets into released attaches.
import * as net from "node:net";
import type { DaemonContext } from "./daemon-context.ts";
import { makeResponder } from "./daemon-context.ts";
import { dispatch } from "./daemon-dispatch.ts";
import { historyOf } from "./daemon-history.ts";
import { log } from "./log.ts";
import { type ClientCommand, LineSplitter } from "./shared.ts";
import { errText } from "./util.ts";

/** Commands that change permission grants: only a connection that has already announced itself as a controller may send them. */
const GRANT_CHANGES: ReadonlySet<string> = new Set(["permission_add", "permission_revoke", "permission_restore"]);

/** A new controller's initial sync: its own session view, then the transcript of every live child. */
function syncController(ctx: DaemonContext, socket: net.Socket): void {
  ctx.hub.addController(socket);
  ctx.hub.sendSessions(socket);
  for (const s of ctx.registry.all()) {
    if (!s.child) {
      continue;
    }
    if (s.pendingDialog && s.lastDialog) {
      ctx.hub.send(socket, { type: "ui_request", session: s.id, request: s.lastDialog });
    }
    void historyOf(s)
      .then((messages) => ctx.hub.send(socket, { type: "history", session: s.id, messages }))
      .catch((err: unknown) => log(`history session ${s.id} failed: ${err}`));
  }
  log(`controller attached (${ctx.hub.controllerCount} connected)`);
}

/** Release every attach a gone controller held. */
function releaseAttaches(ctx: DaemonContext, socket: net.Socket): void {
  let changed = false;
  for (const s of ctx.registry.all()) {
    if (s.attachedTo === socket) {
      s.attachedTo = undefined;
      changed = true;
    }
  }
  if (changed) {
    ctx.hub.broadcastSessions();
  }
}

export function createServer(ctx: DaemonContext): net.Server {
  return net.createServer((socket) => {
    const splitter = new LineSplitter();
    socket.on("data", (chunk: Buffer) => {
      for (const line of splitter.push(chunk.toString("utf8"))) {
        let cmd: ClientCommand;
        try {
          cmd = JSON.parse(line) as ClientCommand;
        } catch (err) {
          log(`bad client line: ${err}`);
          continue;
        }
        const res = makeResponder(ctx.hub, socket, cmd.id);
        // Grant changes come from a controller that has announced itself (the real one sends `list` first), so a connection whose
        // first line is a grant change is refused, unsynced. That stops an accidental self-grant; it is a seatbelt, not a wall:
        // a caller that sends `list` first gets through, as anything holding the socket can.
        if (GRANT_CHANGES.has(cmd.type) && !ctx.hub.isController(socket)) {
          res(false, "grant changes come from a toriel controller, and this connection has not announced itself (send list first)");
          continue;
        }
        // one-shot callers (presence heartbeats, the agents and grants extensions) are not controllers: no sync, no attaches
        if ((cmd.type === "external_register" || cmd.type === "message" || cmd.type === "permission_check") && !ctx.hub.isController(socket)) {
          ctx.hub.addPresenceOnly(socket);
        } else if (!ctx.hub.isKnown(socket)) {
          syncController(ctx, socket);
        }
        void dispatch(ctx, cmd, socket, res).catch((err: unknown) => {
          const msg = errText(err);
          log(`command ${cmd.type} failed: ${msg}`);
          res(false, msg);
        });
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      if (ctx.hub.remove(socket) === "controller") {
        releaseAttaches(ctx, socket);
        log(`controller detached (${ctx.hub.controllerCount} connected)`);
      }
    });
  });
}
