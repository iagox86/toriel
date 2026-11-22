// What tab completion asks the daemon about the session on screen: its models,
// thinking levels and MCP servers. Completion asks on every keystroke, so each
// answer is kept briefly, per session.
import type { Host } from "./host.ts";
import { type McpServer, parseMcpStatus } from "./mcp.ts";
import type { SessionMeta } from "./shared.ts";

const SHORT_MS = 10_000;
const LONG_MS = 60_000;

export class CompletionSources {
  private readonly cache = new Map<string, { key: string; at: number; value: unknown }>();
  private readonly h: Host;

  constructor(host: Host) {
    this.h = host;
  }

  /** The live session being viewed, if there is one (nothing to ask while the switcher is up). */
  private viewed(): SessionMeta | undefined {
    const meta = this.h.switching.isOpen || !this.h.viewing ? undefined : this.h.metaForPath(this.h.viewing);
    return meta?.active ? meta : undefined;
  }

  /** `fetch` for the viewed session, reusing an answer younger than `ttlMs` for the same session and `variant`. */
  private async lookup<T>(name: string, ttlMs: number, variant: (meta: SessionMeta) => string, fetch: (meta: SessionMeta) => Promise<T>, empty: T): Promise<T> {
    const meta = this.viewed();
    if (!meta) {
      return empty;
    }
    const key = `${meta.id}:${variant(meta)}`;
    const hit = this.cache.get(name);
    if (hit && hit.key === key && Date.now() - hit.at < ttlMs) {
      return hit.value as T;
    }
    try {
      const value = await fetch(meta);
      this.cache.set(name, { key, at: Date.now(), value });
      return value;
    } catch {
      return empty;
    }
  }

  /** Models the viewed session can switch to; with the switcher up (/new -m), those of any running session, since pi's list is the same for all of them. */
  async models(): Promise<string[]> {
    if (this.viewed()) {
      return this.lookup("models", LONG_MS, () => "", async (m) => ((await this.h.request({ type: "model", session: m.id })) as { models: string[] }).models, []);
    }
    const any = [...this.h.sessions.values()].find((m) => m.active);
    if (!any) {
      return [];
    }
    const hit = this.cache.get("models-any");
    if (hit && hit.key === String(any.id) && Date.now() - hit.at < LONG_MS) {
      return hit.value as string[];
    }
    try {
      const value = ((await this.h.request({ type: "model", session: any.id })) as { models: string[] }).models;
      this.cache.set("models-any", { key: String(any.id), at: Date.now(), value });
      return value;
    } catch {
      return [];
    }
  }

  /** Thinking levels the viewed session's model supports; keyed by model too, since /model changes them. */
  thinkingLevels(): Promise<string[]> {
    return this.lookup("think", LONG_MS, (m) => m.model, async (m) => ((await this.h.request({ type: "think", session: m.id })) as { levels: string[] }).levels, []);
  }

  /** MCP servers of the viewed session. */
  mcpServers(): Promise<McpServer[]> {
    return this.lookup("mcp", SHORT_MS, () => "", async (m) => parseMcpStatus(((await this.h.request({ type: "mcp_status", session: m.id })) as { text: string }).text), []);
  }
}
