// Desktop notifications for prompts that wait on the user in a session that is not on screen (ticket 234). Without them a background
// session can sit blocked for hours. The mechanism is `notify-send` (the freedesktop Notifications API), fired and forgotten: no click
// actions (focusing a window is not portable across Wayland compositors), and a failure (no D-Bus over SSH, no binary) is one log
// line, never an error the controller has to handle. The sender is injected so tests never shell out.
import { spawn } from "node:child_process";
import { isPermissionPrompt, type DialogRequest } from "./dialogs.ts";

export interface Notification {
  summary: string;
  body: string;
  critical: boolean;
}

/** Sends one notification; never throws. */
export type Notifier = (n: Notification) => void;

const BODY_MAX = 240;
const SEEN_MAX = 200;

/** The title of the plan-approval dialog (pi/extensions/lib/plan-mode.ts approvalTitle). */
const PLAN_PREFIX = "Plan mode: approve this plan?";

/** The kinds of dialog worth a ping: permission prompts and plan approvals, listed by name rather than every dialog method. */
export function notifiable(d: DialogRequest): "permission" | "plan" | undefined {
  if (isPermissionPrompt(d)) {
    return "permission";
  }
  return d.method === "select" && (d.title ?? "").startsWith(PLAN_PREFIX) ? "plan" : undefined;
}

/** What the notification says: the tool or action lines of the dialog, on one line, cut short. */
export function bodyOf(d: DialogRequest): string {
  const lines = (d.title ?? "").split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const text = (notifiable(d) === "plan" ? ["the agent has a plan for you to approve"] : lines.slice(1)).join(" | ");
  return text.length > BODY_MAX ? `${text.slice(0, BODY_MAX - 1)}…` : text || (lines[0] ?? "");
}

/** The real sender: `notify-send`, detached, its failure logged once per failure and otherwise ignored. */
export function notifySend(log: (line: string) => void = () => {}, run: typeof spawn = spawn): Notifier {
  // the log must never take the controller down: a failing append (KEY_LOG unwritable, disk full) is quieter than a crash in onUiRequest
  const say = (line: string): void => {
    try {
      log(line);
    } catch {
      // ignore the log failure itself
    }
  };
  return (n) => {
    try {
      const args = ["--app-name=toriel", `--urgency=${n.critical ? "critical" : "normal"}`, "--", n.summary, n.body];
      const child = run("notify-send", args, { stdio: "ignore", detached: true });
      child.on("error", (err) => say(`notify-send failed: ${err.message}`));
      child.unref();
    } catch (err) {
      say(`notify-send failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

export interface Ask {
  /** The session is on screen (or its dialog is the one on screen): nobody needs pinging. */
  focused: boolean;
  /** The session the dialog belongs to: ids are only unique within one. */
  session: number;
  /** "Subagent: name" or the session's name. */
  who: string;
  enabled: boolean;
  critical: boolean;
}

/** Decides which dialogs get a notification: permission-class ones in sessions that are not on screen, once per dialog id. */
export class PermissionNotifier {
  private readonly send: Notifier;
  private readonly seen = new Set<string>();

  constructor(send: Notifier) {
    this.send = send;
  }

  /** Notify for `d` if it should be; returns whether a notification went out. */
  consider(d: DialogRequest, ask: Ask): boolean {
    const kind = notifiable(d);
    if (!ask.enabled || ask.focused || kind === undefined || this.seen.has(`${ask.session}:${d.id}`)) {
      return false;
    }
    this.seen.add(`${ask.session}:${d.id}`);
    if (this.seen.size > SEEN_MAX) {
      this.seen.delete(this.seen.values().next().value as string);
    }
    this.send({ summary: `${kind === "plan" ? "Plan to approve" : "Permission request"}: ${ask.who}`, body: bodyOf(d), critical: ask.critical });
    return true;
  }
}
