// Which agent profile a session was started with. A respawn (`--session file`)
// loses launch flags, so the resolved profile is saved here, keyed by session
// UUID, and re-applied every time that session's pi process starts. It is a
// snapshot: editing the agent file later does not change running history.
import type { AgentProfile } from "./agents.ts";
import { SESSION_AGENTS_FILE } from "./config.ts";
import { readJsonOr, writeJsonAtomic } from "./util.ts";

export type SessionAgents = Record<string, AgentProfile>;

export function loadSessionAgents(file = SESSION_AGENTS_FILE): SessionAgents {
  return readJsonOr<SessionAgents>(file, {});
}

export function profileOfSession(sessionId: string | undefined, file = SESSION_AGENTS_FILE): AgentProfile | undefined {
  return sessionId ? loadSessionAgents(file)[sessionId] : undefined;
}

export function saveSessionAgent(sessionId: string, profile: AgentProfile, file = SESSION_AGENTS_FILE): void {
  const data = loadSessionAgents(file);
  data[sessionId] = profile;
  writeJsonAtomic(file, data);
}
