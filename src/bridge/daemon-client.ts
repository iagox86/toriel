// The bridge's connection to the daemon: a plain controller on the unix socket. No reconnect logic: the bridge is the daemon's child,
// so a lost socket means the daemon is going away and the process just ends.
import * as net from "node:net";
import { type ClientCommand, type DaemonMessage, type DistributiveOmit, encodeLine, LineSplitter } from "../shared.ts";

/** How long a daemon request may take before the bridge gives up on it (a prompt that wakes a sleeping session is the slow one). */
const REQUEST_TIMEOUT_MS = 60_000;

export interface DaemonPort {
  /** Send a command and resolve with its response data; rejects with the daemon's error text. */
  request(cmd: DistributiveOmit<ClientCommand, "id">, timeoutMs?: number): Promise<unknown>;
  /** Every message the daemon sends (events, session lists, dialogs, ...). */
  onMessage(listener: (msg: DaemonMessage) => void): void;
  /** The socket closed. */
  onClose(listener: () => void): void;
  close(): void;
}

export function connectDaemon(sock: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<DaemonPort> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(sock);
    const splitter = new LineSplitter();
    const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    const listeners: Array<(msg: DaemonMessage) => void> = [];
    const closers: Array<() => void> = [];
    let seq = 0;
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk: string) => {
      for (const line of splitter.push(chunk)) {
        let msg: DaemonMessage;
        try {
          msg = JSON.parse(line) as DaemonMessage;
        } catch {
          continue;
        }
        if (msg.type === "response") {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          if (p) {
            if (msg.ok) {
              p.resolve(msg.data);
            } else {
              p.reject(new Error(msg.error ?? "command failed"));
            }
          }
          continue;
        }
        for (const l of listeners) {
          l(msg);
        }
      }
    });
    socket.on("close", () => {
      for (const p of pending.values()) {
        p.reject(new Error("the daemon connection closed"));
      }
      pending.clear();
      for (const c of closers) {
        c();
      }
    });
    socket.once("connect", () => {
      socket.off("error", reject);
      socket.on("error", () => {});
      const port: DaemonPort = {
        request(cmd, ms = timeoutMs) {
          const id = `b${++seq}`;
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              rej(new Error(`the daemon did not answer ${cmd.type} in ${Math.round(ms / 1000)} s`));
            }, ms);
            timer.unref();
            pending.set(id, {
              resolve: (v) => {
                clearTimeout(timer);
                res(v);
              },
              reject: (e) => {
                clearTimeout(timer);
                rej(e);
              },
            });
            socket.write(encodeLine({ ...cmd, id }));
          });
        },
        onMessage: (l) => void listeners.push(l),
        onClose: (l) => void closers.push(l),
        close: () => socket.destroy(),
      };
      // the first line announces a controller (and gets the first session list)
      void port.request({ type: "list" }).then(() => resolve(port), reject);
    });
  });
}
