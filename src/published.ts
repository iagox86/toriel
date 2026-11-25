// Which sessions are published to chat (ticket 269): a set of session UUIDs the daemon keeps across restarts.
// Opt-in per session with /publish; /park and /delete clear it; nothing else sets it (chat cannot publish).
import * as fs from "node:fs";
import * as path from "node:path";
import { readJsonOr, writeJsonAtomic } from "./util.ts";

interface PublishedFile {
  /** Session UUID -> when it was published (ms since epoch). */
  published: Record<string, number>;
  /** Sessions that were published when they were parked: published again when they are used again. */
  resume?: string[];
}

export class PublishedStore {
  private marks = new Map<string, number>();
  private resume = new Set<string>();
  /**
   * The chat bridge is connected. Nothing sets it until the bridge exists (ticket 271); the status bar draws a
   * published session differently while it is false.
   */
  bridgeUp = false;
  /** What is wrong with the bridge, in its own words (or why it exited); cleared when it says all is well. Memory only. */
  problem?: string;
  /** The chat server's host (for `/publish` to say where the channel is), set when the bridge starts. */
  server?: string;
  /** Session UUID -> the name of its open channel, as the bridge last said. Memory only. */
  channels: Record<string, string> = {};

  private readonly file: string;
  private readonly now: () => number;

  constructor(file: string, now: () => number = Date.now) {
    this.file = file;
    this.now = now;
  }

  load(): void {
    const data = readJsonOr<Partial<PublishedFile>>(this.file, {});
    this.marks = new Map(Object.entries(data.published ?? {}).filter(([, at]) => typeof at === "number"));
    this.resume = new Set((data.resume ?? []).filter((id) => typeof id === "string"));
  }

  has(sessionId: string | undefined): boolean {
    return sessionId !== undefined && this.marks.has(sessionId);
  }

  ids(): string[] {
    return [...this.marks.keys()];
  }

  /** Whether the session is parked and was published when it was (so using it again publishes it again). */
  hasResume(sessionId: string | undefined): boolean {
    return sessionId !== undefined && this.resume.has(sessionId);
  }

  /** Park: unpublish, remembering that it was published; returns whether it was. */
  park(sessionId: string): boolean {
    const was = this.marks.delete(sessionId);
    if (was) {
      this.resume.add(sessionId);
      this.save();
    }
    return was;
  }

  /** The session is used again: publish it if it was parked while published; returns whether it did. */
  takeResume(sessionId: string): boolean {
    if (!this.resume.delete(sessionId)) {
      return false;
    }
    this.marks.set(sessionId, this.now());
    this.save();
    return true;
  }

  /** Publish or unpublish (either way an explicit choice: it forgets a resume); returns whether anything changed. */
  set(sessionId: string, on: boolean): boolean {
    const resumed = this.resume.delete(sessionId);
    if (on === this.marks.has(sessionId)) {
      if (resumed) {
        this.save();
      }
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
    writeJsonAtomic(this.file, { published: Object.fromEntries(this.marks), resume: [...this.resume] } satisfies PublishedFile);
  }
}
