// What a failed call to the chat server says, made readable (ticket 293). @chatto/client rejects with a Connect error whose message is
// only `[code] text` ("[permission_denied] permission denied"); the step that failed, the room or group it was about and what to do
// next are the caller's to add. Pure: no chat client is loaded here, so the daemon and doctor can use it too.

/** Connect's numeric codes (@connectrpc/connect `Code`), by the names its messages print. */
const CODE_NAMES: Record<number, string> = {
  1: "canceled",
  2: "unknown",
  3: "invalid_argument",
  4: "deadline_exceeded",
  5: "not_found",
  6: "already_exists",
  7: "permission_denied",
  8: "resource_exhausted",
  9: "failed_precondition",
  10: "aborted",
  11: "out_of_range",
  12: "unimplemented",
  13: "internal",
  14: "unavailable",
  15: "data_loss",
  16: "unauthenticated",
};

export interface ChatErrorInfo {
  /** The Connect code name (`permission_denied`), when the error carried one. */
  code?: string;
  /** The server's own text, without the `[code]` prefix the client adds. */
  text: string;
  /** Anything more the error carried: detail messages, a cause. */
  detail?: string;
}

/** Read a rejection from the chat client (or anything else) into its parts. Never includes request headers (the token is one). */
export function describeChatError(err: unknown): ChatErrorInfo {
  if (!(err instanceof Error)) {
    return { text: String(err) };
  }
  const e = err as Error & { code?: unknown; rawMessage?: unknown; details?: unknown; cause?: unknown };
  const prefixed = /^\[([a-z_]+)\]\s*(.*)$/s.exec(e.message);
  const code = typeof e.code === "number" ? CODE_NAMES[e.code] : typeof e.code === "string" ? e.code : prefixed?.[1];
  const text = typeof e.rawMessage === "string" && e.rawMessage ? e.rawMessage : (prefixed?.[2] ?? e.message);
  const parts: string[] = [];
  if (Array.isArray(e.details)) {
    for (const d of e.details as Array<{ type?: unknown; debug?: unknown }>) {
      const debug = d?.debug === undefined ? undefined : typeof d.debug === "string" ? d.debug : JSON.stringify(d.debug);
      const type = typeof d?.type === "string" ? d.type : undefined;
      if (debug || type) {
        parts.push([type, debug].filter(Boolean).join(": "));
      }
    }
  }
  if (e.cause instanceof Error && e.cause.message && e.cause.message !== e.message) {
    parts.push(`cause: ${e.cause.message}`);
  }
  return { ...(code ? { code } : {}), text: text || "(no text)", ...(parts.length > 0 ? { detail: parts.join("; ") } : {}) };
}

/** The code and text as one phrase, `permission_denied: permission denied`, without repeating a text that only restates the code. */
export function chatErrorText(info: ChatErrorInfo): string {
  const same = info.code !== undefined && info.text.toLowerCase().replace(/\s+/g, "_") === info.code;
  const head = info.code === undefined ? info.text : same ? info.code.replace(/_/g, " ") : `${info.code.replace(/_/g, " ")}: ${info.text}`;
  return info.detail ? `${head} (${info.detail})` : head;
}

/** What to do about a code, when the step gave nothing more specific. */
export function genericHint(code: string | undefined): string | undefined {
  switch (code) {
    case "unauthenticated":
      return "the server refused the bot's token: check that the token file (or variable) holds the bot's current token";
    case "permission_denied":
      return "the bot's account lacks a permission this step needs: check its roles on the chat server";
    case "unavailable":
    case "deadline_exceeded":
      return "the server did not answer: check chatto.url and that the server is up (the bridge tries again)";
    case "not_found":
      return "the server does not know the thing asked for: it may have been deleted";
    default:
      return undefined;
  }
}

/** Advice for a failed connection that carried no code (the client says only that it could not load from the server). */
export const CONNECT_HINTS: Partial<Record<string, string>> = { "*": "check chatto.url, that the server is up and reachable from here, and that the token is the bot's" };

/** A code that will not go away by trying again (a setup problem), as opposed to a server that is down or slow. */
export function isSetupCode(code: string | undefined): boolean {
  return code === "unauthenticated" || code === "permission_denied" || code === "already_exists" || code === "not_found" || code === "invalid_argument" || code === "failed_precondition";
}

/**
 * The sentence for a failed setup step: `could not <step>: <code: text (detail)>: <what to do>`. `hints` give a step's own advice by
 * code (the inbox's `already_exists` means another room has the name); the generic advice is used otherwise, and `hints["*"]` when
 * neither has any (an error with no code, such as a refused connection).
 */
export function setupFailureText(step: string, err: unknown, hints: Partial<Record<string, string>> = {}): string {
  const info = describeChatError(err);
  const hint = (info.code !== undefined ? hints[info.code] : undefined) ?? genericHint(info.code) ?? hints["*"];
  return `could not ${step}: ${chatErrorText(info)}${hint ? `. ${hint}` : ""}`;
}
