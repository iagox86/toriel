// Waking a sleeping session because the user is typing a command into it (ticket 68).
// pi's command list, `/mcp explore <TAB>` and the like need a running child, and typing
// `/` or `!` into a session almost always means the user wants it awake. Plain prose
// does not trigger it: every sleeping session you type a letter into would pay a pi start.
import type { SessionMeta } from "./shared.ts";

/** How long the text must keep starting with `/` or `!` before the session is started, so typing `/` and deleting it spawns nothing. */
export const WAKE_DELAY_MS = 400;

/** Whether the editor text is the start of a /command or a !command. */
export function wantsWake(text: string): boolean {
  return /^\s*[/!]\S*/.test(text);
}

/** What a session must be, for typing into it to start it. */
export type Wakeable = Pick<SessionMeta, "active" | "attachedElsewhere" | "externallyLive" | "subagent">;

/**
 * Whether the viewed session may be started by typing. Never one that is already up, that another controller
 * has attached (view-only), that another pi has open, or that a parent agent owns (a subagent's lifecycle is the
 * parent's). `meta` is undefined for a session file toriel has not registered yet; the daemon checks the file's
 * own age before it starts one of those. Parked sessions do wake: typing into one is the "used again" it waits for.
 */
export function mayWake(key: string | undefined, meta: Partial<Wakeable> | undefined, switcherOpen: boolean): boolean {
  if (switcherOpen || !key?.startsWith("/")) {
    return false;
  }
  return meta?.active !== true && meta?.attachedElsewhere !== true && meta?.externallyLive !== true && meta?.subagent === undefined;
}

export interface WakeTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const REAL_TIMERS: WakeTimers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as NodeJS.Timeout) };

/** Debounces editor changes into at most one wake per pause in typing. */
export class WakeOnType {
  private timer: unknown;
  private readonly text: () => string;
  private readonly allowed: () => boolean;
  private readonly wake: () => void;
  private readonly delayMs: number;
  private readonly timers: WakeTimers;

  constructor(opts: { text: () => string; allowed: () => boolean; wake: () => void; delayMs?: number; timers?: WakeTimers }) {
    this.text = opts.text;
    this.allowed = opts.allowed;
    this.wake = opts.wake;
    this.delayMs = opts.delayMs ?? WAKE_DELAY_MS;
    this.timers = opts.timers ?? REAL_TIMERS;
  }

  /** The editor's text changed (call from its change hook). */
  onText(text: string): void {
    this.cancel();
    if (!wantsWake(text)) {
      return;
    }
    this.timer = this.timers.set(() => {
      this.timer = undefined;
      // look again at the moment it fires: the text, the session on screen and its state may all have moved on
      if (wantsWake(this.text()) && this.allowed()) {
        this.wake();
      }
    }, this.delayMs);
  }

  /** Forget a pending wake (the view changed, or the text was sent). */
  cancel(): void {
    if (this.timer !== undefined) {
      this.timers.clear(this.timer);
      this.timer = undefined;
    }
  }
}
