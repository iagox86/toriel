// A one-line prompt for a secret (an API key, a bearer token). The text typed or pasted is held here and nowhere else: the chat box
// shows only a dot per character, nothing goes to the command history, the transcript, the daemon or its log, and the secret leaves
// this object only through `onDone`. Pure: the controller feeds it keys and draws `masked()`.
import { Key, matchesKey } from "@earendil-works/pi-tui";

export const MASK_CHAR = "•";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** What a key did: `more` (keep prompting), `done` (the secret is in `value`) or `cancel`. */
export type SecretKeyResult = { kind: "more" } | { kind: "done"; value: string } | { kind: "cancel" };

export class SecretPrompt {
  private buffer = "";
  private active = false;
  /** What is being asked for, in words ("API key for litellm"). */
  label = "";

  get isOpen(): boolean {
    return this.active;
  }

  open(label: string): void {
    this.active = true;
    this.label = label;
    this.buffer = "";
  }

  /** Forget everything typed and close. */
  close(): void {
    this.buffer = "";
    this.active = false;
    this.label = "";
  }

  /** A dot per character typed, for the chat box. */
  masked(): string {
    return MASK_CHAR.repeat(this.buffer.length);
  }

  get length(): number {
    return this.buffer.length;
  }

  /** Feed one key (or one chunk of pasted text). Printable text is appended, backspace removes, enter finishes, esc cancels; any other key is ignored. */
  key(data: string): SecretKeyResult {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.close();
      return { kind: "cancel" };
    }
    if (matchesKey(data, Key.enter)) {
      const value = this.buffer.trim();
      this.close();
      return value === "" ? { kind: "cancel" } : { kind: "done", value };
    }
    if (matchesKey(data, Key.backspace)) {
      this.buffer = this.buffer.slice(0, -1);
      return { kind: "more" };
    }
    if (matchesKey(data, Key.ctrl("u"))) {
      this.buffer = "";
      return { kind: "more" };
    }
    const text = data.startsWith(PASTE_START) ? data.slice(PASTE_START.length).replace(PASTE_END, "") : data;
    // printable text only: control sequences (arrows, function keys) and newlines are not part of a secret
    if (text !== "" && !/[\x00-\x1f\x7f]/.test(text.replace(/[\r\n]+$/, ""))) {
      this.buffer += text.replace(/[\r\n]+$/, "");
    }
    return { kind: "more" };
  }
}
