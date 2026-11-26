// Doctor's look at the chat server (ticket 293): what the bridge needs that can be checked without changing anything. The server
// answers and takes the token, the room group is visible, the inbox name is not held by a room elsewhere, and (when the server reports
// the bot's group permissions) the bot may create rooms there. Nothing is created, joined or posted.
import type { ChatAdapter } from "./adapter.ts";
import { CONNECT_HINTS, setupFailureText } from "./chat-error.ts";

export interface ChatProbeSettings {
  url: string;
  group: string;
  inboxChannel: string;
}

/** A group permission key that looks like creating rooms; the keys are the server's own, so this is a guess and only ever adds a finding. */
const CREATE_KEY = /(room|channel).*create|create.*(room|channel)/i;

/** The problems found, as sentences that say what to do; [] when everything checked is fine. Never throws. */
export async function probeChat(adapter: ChatAdapter, s: ChatProbeSettings): Promise<string[]> {
  try {
    await adapter.connect();
  } catch (err) {
    return [`the chat bridge ${setupFailureText(`connect to the chat server at ${s.url}`, err, CONNECT_HINTS).replace(/^could not/, "cannot")}`];
  }
  const problems: string[] = [];
  try {
    const groups = await adapter.listGroups();
    const groupId = await adapter.findGroup(s.group);
    if (!groupId) {
      const seen = groups.length > 0 ? `the bot can see ${groups.map((g) => `"${g.name}"`).join(", ")}` : "the bot can see no room groups";
      return [`the chat bridge's room group "${s.group}" does not exist, or the bot cannot see it (${seen}): create it on the chat server and give the bot access, or set chatto.group to a group it can see`];
    }
    const perms = groups.find((g) => g.id === groupId)?.permissions ?? {};
    const refused = Object.entries(perms).filter(([key, granted]) => CREATE_KEY.test(key) && !granted);
    if (refused.length > 0) {
      problems.push(`the bot may not create rooms in the chat group "${s.group}" (the server reports ${refused.map(([k]) => k).join(", ")} not granted): the bridge makes the inbox and a channel per published session there; give the bot that permission`);
    }
    const inGroup = [...(await adapter.listRooms(groupId)), ...(await adapter.listArchived(groupId))].some((r) => r.name.toLowerCase() === s.inboxChannel.toLowerCase());
    if (!inGroup) {
      const elsewhere = (await adapter.findRoomsNamed(s.inboxChannel)).find((r) => r.groupId !== groupId);
      if (elsewhere) {
        const where = groups.find((g) => g.id === elsewhere.groupId)?.name;
        problems.push(`the chat bridge's inbox name "${s.inboxChannel}" is taken by a room in ${where ? `group "${where}"` : "another group"}${elsewhere.archived ? " (archived)" : ""}, and room names are unique on the server: set chatto.inboxChannel to another name`);
      }
    }
  } catch (err) {
    problems.push(`the chat bridge ${setupFailureText(`look at the room group "${s.group}"`, err).replace(/^could not/, "cannot")}`);
  }
  return problems;
}
