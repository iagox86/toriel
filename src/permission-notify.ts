// Desktop notifications for prompts that wait on the user in a session that is not on screen (ticket 234). Without them a background
// session can sit blocked for hours. The mechanism is `notify-send` (the freedesktop Notifications API), fired and forgotten: no click
// actions (focusing a window is not portable across Wayland compositors), and a failure (no D-Bus over SSH, no binary) is one log
// line, never an error the controller has to handle. The sender is injected so tests never shell out.
import { spawn } from "node:child_process";
import { isPermissionPrompt, type DialogRequest } from "./dialogs.ts";

export interface Notification {
  summary: string;
  /** Body markup (the freedesktop subset: `<b>`, escaped text); bodyOf escapes everything it takes from the dialog. */
  body: string;
  critical: boolean;
  /** A freedesktop icon name from the installed theme, so toriel ships no icon file. */
  icon?: string;
}

/** Sends one notification; never throws. */
export type Notifier = (n: Notification) => void;

/** The longest detail line (the command or path); a longer one keeps its head and tail with an ellipsis between. */
const DETAIL_MAX = 160;
const SEEN_MAX = 200;
/** Standard icon-naming-spec names, present in every freedesktop theme (Adwaita, Breeze). */
const ICONS = { permission: "dialog-password", plan: "dialog-question" } as const;

/** The title of the plan-approval dialog (pi/extensions/lib/plan-mode.ts approvalTitle). */
const PLAN_PREFIX = "Plan mode: approve this plan?";

/** The kinds of dialog worth a ping: permission prompts and plan approvals, listed by name rather than every dialog method. */
export function notifiable(d: DialogRequest): "permission" | "plan" | undefined {
  if (isPermissionPrompt(d)) {
    return "permission";
  }
  return d.method === "select" && (d.title ?? "").startsWith(PLAN_PREFIX) ? "plan" : undefined;
}

/** Text for notification markup: notification servers that parse the body (GNOME, KDE) would take a command's `<` or `&` as markup and show nothing. */
export function escapeMarkup(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Whitespace runs (a multi-line command's newlines included) as single spaces, and a long text cut in the middle, where a command's least telling part usually is. */
export function oneLine(text: string, max = DETAIL_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) {
    return flat;
  }
  const tail = Math.floor((max - 1) / 3);
  return `${flat.slice(0, max - 1 - tail).trimEnd()}…${flat.slice(-tail).trimStart()}`;
}

/** The `key : value` fields of a permission prompt's title, in order; a line that is not a field continues the previous value (a multi-line command). */
export function promptFields(title: string): Array<{ key: string; value: string }> {
  const fields: Array<{ key: string; value: string }> = [];
  for (const line of title.split("\n").slice(1)) {
    const m = /^\s*([A-Za-z][\w -]*?)\s*:\s(.*)$/.exec(line);
    const last = fields.at(-1);
    if (m) {
      fields.push({ key: (m[1] ?? "").trim(), value: (m[2] ?? "").trim() });
    } else if (last) {
      last.value = `${last.value}\n${line}`;
    } else if (line.trim() !== "") {
      fields.push({ key: "", value: line.trim() });
    }
  }
  return fields;
}

/**
 * What the notification says (ticket 335): the tool in bold on its own line, then the one thing it wants to touch (the command,
 * path or whatever field comes first) on one line, cut in the middle when long. A plan approval says so. The command text is
 * shown as is, also on a lock screen whose settings show notification bodies: a deliberate choice for a personal machine, where
 * knowing what waits is the point (the desktop's own lock-screen setting can hide bodies).
 */
export function bodyOf(d: DialogRequest): string {
  if (notifiable(d) === "plan") {
    return "the agent has a plan for you to approve";
  }
  const fields = promptFields(d.title ?? "");
  const tool = fields.find((f) => f.key === "tool")?.value;
  const detail = fields.find((f) => f.key !== "tool" && f.value.trim() !== "");
  const lines = [...(tool ? [`<b>${escapeMarkup(oneLine(tool, 60))}</b>`] : []), ...(detail ? [escapeMarkup(oneLine(detail.value))] : [])];
  return lines.length > 0 ? lines.join("\n") : escapeMarkup(oneLine((d.title ?? "").split("\n")[0] ?? ""));
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
      const args = ["--app-name=toriel", `--urgency=${n.critical ? "critical" : "normal"}`, ...(n.icon ? [`--icon=${n.icon}`] : []), "--", n.summary, n.body];
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
    // the summary is plain text everywhere (no markup), so the session name needs no escaping
    this.send({ summary: kind === "plan" ? `${ask.who} has a plan to approve` : `${ask.who} needs permission`, body: bodyOf(d), critical: ask.critical, icon: ICONS[kind] });
    return true;
  }
}
