// Doctor's look at the chat server (tickets 293, 295): what the bridge needs, as far as doctor can know it without guessing. The server
// answers and takes the token, the room group is visible, (when the server reports the bot's group permissions) the bot may create rooms
// there, and when the inbox name is not in the group's visible rooms the inbox is created - the one call the bridge would make at its
// next start, so doctor catches the case a name the bot cannot see holds (the server then refuses the create). Nothing is joined or
// posted, and no other room is touched.
import type { ChatAdapter } from "./adapter.ts";
import { CONNECT_HINTS, describeChatError, redactUrl, setupFailureText } from "./chat-error.ts";

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
    return [`the chat bridge ${setupFailureText(`connect to the chat server at ${redactUrl(s.url)}`, err, CONNECT_HINTS).replace(/^could not/, "cannot")}`];
  }
  const problems: string[] = [];
  try {
    // like the bridge, which only uses the list for extra detail: a server that refuses the directory is not thereby missing the group
    const groups: Awaited<ReturnType<ChatAdapter["listGroups"]>> = await adapter.listGroups().catch(() => []);
    const groupId = await adapter.findGroup(s.group);
    if (!groupId) {
      const seen = groups.length > 0 ? `the bot can see ${groups.map((g) => `"${g.name}"`).join(", ")}` : "no other room groups are visible to the bot, or the list could not be read";
      return [`the chat bridge's room group "${s.group}" does not exist, or the bot cannot see it (${seen}): create it on the chat server and give the bot access, or set chatto.group to a group it can see`];
    }
    const perms = groups.find((g) => g.id === groupId)?.permissions ?? {};
    const refused = Object.entries(perms).filter(([key, granted]) => CREATE_KEY.test(key) && !granted);
    if (refused.length > 0) {
      problems.push(`the bot may not create rooms in the chat group "${s.group}" (the server reports ${refused.map(([k]) => k).join(", ")} not granted): the bridge makes the inbox and a channel per published session there; give the bot that permission`);
    }
    const inGroup = [...(await adapter.listRooms(groupId)), ...(await adapter.listArchived(groupId))].some((r) => r.name.toLowerCase() === s.inboxChannel.toLowerCase());
    if (!inGroup) {
      const named = (await adapter.findRoomsNamed(s.inboxChannel).catch(() => []));
      const elsewhere = named.find((r) => r.groupId !== groupId);
      if (elsewhere) {
        const where = groups.find((g) => g.id === elsewhere.groupId)?.name;
        problems.push(`the chat bridge's inbox name "${s.inboxChannel}" is taken by a room in ${where ? `group "${where}"` : "another group"}${elsewhere.archived ? " (archived)" : ""}, and room names are unique on the server: set chatto.inboxChannel to another name`);
      } else {
        // the one call the bridge itself would make at start (tickets 295, 293): the server's reply is the truth a listing cannot
        // give, because a room the bot cannot see can hold the name (it did, live: an inbox of another group unreachable to the bot)
        try {
          await adapter.createRoom(groupId, s.inboxChannel, "Toriel: start a session by writing here; announcements");
        } catch (err) {
          const info = describeChatError(err);
          const what = setupFailureText(`create the inbox channel "${s.inboxChannel}" in group "${s.group}"`, err);
          const hint = info.code === "already_exists"
            ? `a room the bot cannot see holds the name (room names are unique server-wide; this is what a listing cannot tell): set chatto.inboxChannel to a name no other room has (e.g. "${s.inboxChannel}-2"), or free the name on the server`
            : info.code === "permission_denied"
            ? "the bot needs permission to create rooms in the group: check its roles on the chat server"
            : "the bridge will meet the same error at its next start";
          problems.push(`the chat bridge ${what}: ${hint}`);
        }
      }
    }
  } catch (err) {
    problems.push(`the chat bridge ${setupFailureText(`look at the room group "${s.group}"`, err).replace(/^could not/, "cannot")}`);
  }
  return problems;
}
