// What `/publish` says about a session that is already published (ticket 269 follow-up): where it shows and how it is doing.
import type { SessionMeta } from "./shared.ts";

/** The text of the info panel: the chat server, the channel and the state of the link, from what the daemon last said in the session list. */
export function publishInfo(meta: Pick<SessionMeta, "chatUp" | "chatProblem" | "chatChannel" | "chatServer">): string {
  let status: string;
  if (!meta.chatUp) {
    status = `the chat bridge is down${meta.chatProblem ? `: ${meta.chatProblem}` : " (the daemon restarts it; the daemon log says why if it stays down)"}`;
  } else if (meta.chatProblem) {
    status = `connected, but: ${meta.chatProblem}`;
  } else if (!meta.chatChannel) {
    status = "connected; the channel is not open yet";
  } else {
    status = "connected";
  }
  return [
    "Published to chat",
    "",
    `  server   ${meta.chatServer ?? "(unknown)"}`,
    `  channel  ${meta.chatChannel ? `#${meta.chatChannel}` : "(not open)"}`,
    `  status   ${status}`,
    "",
    "/unpublish stops it; /park closes the channel until the session is used again",
  ].join("\n");
}
