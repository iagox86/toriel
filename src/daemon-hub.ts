// The connected controller sockets: fan-out of messages to them, and which
// sockets count as controllers at all.
import type * as net from "node:net";
import { encodeLine, type DaemonMessage, type SessionMeta } from "./shared.ts";

export class ClientHub {
  private readonly controllers = new Set<net.Socket>();
  /**
   * Presence-only connections (the extension's fire-and-forget heartbeats)
   * never become controllers: no initial sync, no attach accounting.
   */
  private readonly presenceOnly = new Set<net.Socket>();
  private sessionsDirty = false;
  private readonly metasFor: (socket: net.Socket) => SessionMeta[];

  private readonly hello?: DaemonMessage;

  /** `metasFor` builds the session list as one particular socket should see it (its own attaches differ); `hello` says which code this daemon runs. */
  constructor(metasFor: (socket: net.Socket) => SessionMeta[], hello?: DaemonMessage) {
    this.metasFor = metasFor;
    this.hello = hello;
  }

  /** Sent before anything else to a new controller, so it can compare versions before it relies on the daemon. */
  sendHello(socket: net.Socket): void {
    if (this.hello) {
      this.write(socket, this.hello); // not send(): a pending session list must not go ahead of the version check
    }
  }

  get controllerCount(): number {
    return this.controllers.size;
  }

  isController(socket: net.Socket): boolean {
    return this.controllers.has(socket);
  }

  isKnown(socket: net.Socket): boolean {
    return this.controllers.has(socket) || this.presenceOnly.has(socket);
  }

  addController(socket: net.Socket): void {
    this.controllers.add(socket);
  }

  addPresenceOnly(socket: net.Socket): void {
    this.presenceOnly.add(socket);
  }

  /** Forget a closed socket; says which kind it was, so the caller knows whether to clean up after it. */
  remove(socket: net.Socket): "controller" | "presence" | "unknown" {
    if (this.presenceOnly.delete(socket)) {
      return "presence";
    }
    return this.controllers.delete(socket) ? "controller" : "unknown";
  }

  send(socket: net.Socket, msg: DaemonMessage): void {
    this.flushSessions(); // a list that was asked for first reaches the controller first
    this.write(socket, msg);
  }

  private write(socket: net.Socket, msg: DaemonMessage): void {
    if (!socket.destroyed) {
      socket.write(encodeLine(msg));
    }
  }

  /** The same message to every controller. */
  broadcast(msg: DaemonMessage): void {
    this.flushSessions();
    for (const socket of this.controllers) {
      this.write(socket, msg);
    }
  }

  sendSessions(socket: net.Socket): void {
    this.flushSessions();
    this.write(socket, { type: "sessions", sessions: this.metasFor(socket) });
  }

  /**
   * Ask every controller to be sent the session list. Many call sites fire for one change
   * (a start broadcasts on entry, on exit and in its caller), and each send rebuilds the whole list per
   * controller, so the requests of one turn of the event loop are served by one send. Any other message
   * flushes a pending list first, so the order controllers see is the order things were asked for.
   */
  broadcastSessions(): void {
    if (this.sessionsDirty) {
      return;
    }
    this.sessionsDirty = true;
    queueMicrotask(() => this.flushSessions());
  }

  private flushSessions(): void {
    if (!this.sessionsDirty) {
      return;
    }
    this.sessionsDirty = false;
    for (const socket of this.controllers) {
      this.write(socket, { type: "sessions", sessions: this.metasFor(socket) });
    }
  }

  /** Tell controllers which messages are waiting, in the shape of pi's own queue_update. */
  announceQueue(sessionId: number, texts: string[]): void {
    this.broadcast({ type: "event", session: sessionId, event: { type: "queue_update", steering: texts, followUp: [] } });
  }
}
