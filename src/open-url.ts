// Opening a clicked link (pi-tui calls `openUrl` for a plain click on an OSC 8
// hyperlink). The link text comes from model output and tool results, so only
// web links open; anything else (file:, custom schemes, a command-looking
// string) is refused with a reason the caller shows.
import { spawn } from "node:child_process";
import { errText } from "./util.ts";

export interface OpenCommand {
  cmd: string;
  args: string[];
}

/** Longest link we will hand to the system opener. */
const MAX_URL = 2048;

/** The command that opens `url`, or a reason it must not be opened. */
export function openCommand(url: string, platform: string = process.platform): OpenCommand | { refused: string } {
  if (url.length > MAX_URL) {
    return { refused: "link is too long to open" };
  }
  // no control characters: a link is one line of printable text
  if (/[\x00-\x20\x7f]/.test(url)) {
    return { refused: "link contains spaces or control characters" };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { refused: "not a valid link" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { refused: `only http and https links open (this is ${parsed.protocol})` };
  }
  if (platform === "darwin") {
    return { cmd: "open", args: [parsed.href] };
  }
  if (platform === "win32") {
    // `start` is a cmd builtin; the empty title keeps it from eating the url
    return { cmd: "cmd", args: ["/c", "start", "", parsed.href] };
  }
  return { cmd: "xdg-open", args: [parsed.href] };
}

/**
 * Open `url` in the user's browser, detached. Never throws: `report` gets a
 * short message when the link is refused or the opener cannot start (no xdg-open,
 * no default browser).
 */
export function openUrl(url: string, report: (text: string) => void): void {
  const command = openCommand(url);
  if ("refused" in command) {
    report(`not opened: ${command.refused}`);
    return;
  }
  try {
    const child = spawn(command.cmd, command.args, { detached: true, stdio: "ignore" });
    child.on("error", (err) => report(`could not open the link (${command.cmd}): ${errText(err)}`));
    child.unref();
  } catch (err) {
    report(`could not open the link (${command.cmd}): ${errText(err)}`);
  }
}
