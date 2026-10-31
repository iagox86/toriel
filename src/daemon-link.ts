// The controller's connection to the daemon: the socket, request/response
// matching, and reconnecting with backoff when the daemon goes away. What the
// messages mean, and what to keep on screen during an outage, is the controller's:
// it hears about them through `LinkHooks`.
import * as net from "node:net";
import { SOCK } from "./config.ts";
import { ensureDaemon } from "./lifecycle.ts";
import { type ClientCommand, type DaemonMessage, type DistributiveOmit, encodeLine, LineSplitter } from "./shared.ts";

const RECONNECT_ATTEMPTS = 20;
const FIRST_LIST_TIMEOUT_MS = 3000;

export interface LinkHooks {
  /** A message from the daemon (responses to `request` never get here). */
  message(msg: DaemonMessage): void;
  /** Whether the first session list of this connection has arrived. */
  loaded(): boolean;
  /** The connection dropped (once per outage); the link reconnects on its own. */
  lost(): void;
  /** About to reconnect: the next session list is the first of a new connection. */
  retrying(): void;
  /** Connected again after an outage. */
  reconnected(): void;
  /** Every retry failed. */
  gaveUp(): void;
  notify(text: string): void;
}

export class DaemonLink {
  /** The socket closed and a reconnect is under way. */
  down = false;

  private socket?: net.Socket;
  private disposed = false;
  private reqSeq = 0;
  private readonly responses = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly hooks: LinkHooks;

  constructor(hooks: LinkHooks) {
    this.hooks = hooks;
  }

  /** Connect, starting the daemon first if nothing answers; resolves once the first session list is in. */
  async open(): Promise<void> {
    try {
      await this.connect();
    } catch {
      await ensureDaemon();
      await this.connect();
    }
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(SOCK);
      socket.once("connect", () => {
        this.socket = socket;
        // Announce ourselves: the daemon classifies connections by their
        // first command (presence heartbeats vs controllers), and its
        // initial sync + broadcast membership are keyed on that. Without
        // this the controller never enters the broadcast set and misses
        // every session update until its first user-driven command.
        this.send({ type: "list" });
        const splitter = new LineSplitter();
        // Resolve only once the first session list has arrived, so the
        // initial switcher render already knows which sessions are live
        // in pi (no [pi] tag popping in a tick later). Timeout = fallback.
        let resolved = false;
        const done = () => {
          if (!resolved) {
            resolved = true;
            resolve();
          }
        };
        setTimeout(done, FIRST_LIST_TIMEOUT_MS).unref?.();
        socket.on("data", (chunk: Buffer) => {
          for (const line of splitter.push(chunk.toString("utf8"))) {
            try {
              this.receive(JSON.parse(line) as DaemonMessage);
            } catch (err) {
              console.error(`bad daemon line: ${err}`);
            }
          }
          if (this.hooks.loaded()) {
            done();
          }
        });
        socket.on("close", () => {
          if (this.socket === socket) {
            this.lose();
          }
        });
        socket.on("error", () => {});
      });
      socket.once("error", (err) => {
        reject(new Error(`cannot reach daemon at ${SOCK} even after auto-start attempt (${err.message})`));
      });
    });
  }

  private receive(msg: DaemonMessage): void {
    if (msg.type !== "response") {
      this.hooks.message(msg);
      return;
    }
    const pending = this.responses.get(msg.id);
    if (pending) {
      this.responses.delete(msg.id);
      if (msg.ok) {
        pending.resolve(msg.data);
      } else {
        pending.reject(new Error(msg.error ?? "daemon command failed"));
      }
    }
  }

  /** The socket closed: fail what was waiting, tell the controller, and reconnect with backoff. */
  private lose(): void {
    if (this.disposed || this.down) {
      return;
    }
    this.down = true;
    this.socket = undefined;
    for (const [id, pending] of this.responses) {
      this.responses.delete(id);
      pending.reject(new Error("daemon connection lost"));
    }
    this.hooks.lost();
    void this.reconnect();
  }

  private async reconnect(): Promise<void> {
    let delay = 500;
    for (let attempt = 1; attempt <= RECONNECT_ATTEMPTS && !this.disposed; attempt++) {
      try {
        await ensureDaemon();
        this.hooks.retrying();
        await this.connect();
        this.down = false;
        this.hooks.reconnected();
        return;
      } catch {
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 5000);
      }
    }
    this.hooks.gaveUp();
  }

  send(msg: Record<string, unknown>): void {
    if (!this.socket) {
      if (this.down) {
        this.hooks.notify("daemon is not connected - reconnecting");
      }
      return;
    }
    this.socket.write(encodeLine(msg));
  }

  /** Send a command with response correlation. */
  request(cmd: DistributiveOmit<ClientCommand, "id">, timeoutMs = 30_000): Promise<unknown> {
    const id = `req-${++this.reqSeq}`;
    return new Promise((resolve, reject) => {
      this.responses.set(id, { resolve, reject });
      this.send({ ...cmd, id });
      setTimeout(() => {
        if (this.responses.has(id)) {
          this.responses.delete(id);
          reject(new Error("daemon request timed out"));
        }
      }, timeoutMs).unref?.();
    });
  }

  /** Close for good: no reconnect follows. */
  close(): void {
    this.disposed = true;
    this.socket?.destroy();
  }
}
