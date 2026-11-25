// Which sessions are published to chat (ticket 269): a set of session UUIDs the daemon keeps across restarts.
// Opt-in per session with /publish; /park and /delete clear it; nothing else sets it (chat cannot publish).
import * as fs from "node:fs";
import * as path from "node:path";
import { readJsonOr, writeJsonAtomic } from "./util.ts";

interface PublishedFile {
  /** Session UUID -> when it was published (ms since epoch). */
  published: Record<string, number>;
}

export class PublishedStore {
  private marks = new Map<string, number>();
  /**
   * The chat bridge is connected. Nothing sets it until the bridge exists (ticket 271); the status bar draws a
   * published session differently while it is false.
   */
  bridgeUp = false;

  private readonly file: string;
  private readonly now: () => number;

  constructor(file: string, now: () => number = Date.now) {
    this.file = file;
    this.now = now;
  }

  load(): void {
    const data = readJsonOr<Partial<PublishedFile>>(this.file, {});
    this.marks = new Map(Object.entries(data.published ?? {}).filter(([, at]) => typeof at === "number"));
  }

  has(sessionId: string | undefined): boolean {
    return sessionId !== undefined && this.marks.has(sessionId);
  }

  ids(): string[] {
    return [...this.marks.keys()];
  }

  /** Publish or unpublish; returns whether anything changed. */
  set(sessionId: string, on: boolean): boolean {
    if (on === this.marks.has(sessionId)) {
      return false;
    }
    if (on) {
      this.marks.set(sessionId, this.now());
    } else {
      this.marks.delete(sessionId);
    }
    this.save();
    return true;
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeJsonAtomic(this.file, { published: Object.fromEntries(this.marks) } satisfies PublishedFile);
  }
}
