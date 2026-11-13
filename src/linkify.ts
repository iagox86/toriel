// Turn bare http(s) URLs in already-rendered lines into OSC 8 hyperlinks, so a
// click opens them (src/open-url.ts). pi's markdown already links URLs in
// assistant and user text; this covers rows built from plain text, such as tool
// output. It runs on finished lines, so a URL that wrapped across lines is
// NOT linked: half a URL opened as a link would go to the wrong place, and a
// URL that runs to the last column is treated as possibly wrapped.
import { visibleWidth } from "@earendil-works/pi-tui";

const OSC8_OPEN = /\x1b\]8;[^;\x07\x1b]*;[^\x07\x1b]+(?:\x07|\x1b\\)/;
const ANSI = /\x1b\[[0-9;]*m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const URL_AT = /https?:\/\/[^\s\x1b\x07<>"'`]+/g;

/** Trailing characters a sentence puts after a URL that are not part of it. */
function trimUrl(url: string): string {
  let end = url.length;
  for (;;) {
    const last = url[end - 1];
    if (last !== undefined && ".,;:!?*_".includes(last)) {
      end -= 1;
      continue;
    }
    // a closer is part of the URL only when the URL opened one too (wikipedia/Foo_(bar))
    const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
    const open = last === undefined ? undefined : pairs[last];
    if (open !== undefined) {
      const body = url.slice(0, end);
      if (body.split(last as string).length > body.split(open).length) {
        end -= 1;
        continue;
      }
    }
    return url.slice(0, end);
  }
}

/**
 * `line` with each complete http(s) URL wrapped in an OSC 8 link. Lines that
 * already carry a hyperlink are returned unchanged; `width` is the render width
 * (a URL that reaches the last column may continue on the next line, so is left
 * alone).
 */
export function linkifyLine(line: string, width: number): string {
  if (!line.includes("http") || OSC8_OPEN.test(line)) {
    return line;
  }
  // work on the plain text positions but keep the escapes: split the line into
  // escape and text parts, then link URLs that sit inside one text part
  const parts: string[] = [];
  let last = 0;
  for (const m of line.matchAll(ANSI)) {
    parts.push(line.slice(last, m.index), m[0]);
    last = (m.index as number) + m[0].length;
  }
  parts.push(line.slice(last));
  let column = 0;
  const out = parts.map((part, i) => {
    if (i % 2 === 1) {
      return part; // an escape sequence
    }
    const start = column;
    column += visibleWidth(part);
    return part.replace(URL_AT, (raw, offset: number) => {
      const url = trimUrl(raw);
      if (!/^https?:\/\/[^/?#]/.test(url)) {
        return raw;
      }
      // a style change in the middle of a URL splits it into two text parts: leave it unlinked
      const next = parts[i + 2];
      if (offset + raw.length === part.length && next !== undefined && next !== "" && !/^\s/.test(next)) {
        return raw;
      }
      const endColumn = start + visibleWidth(part.slice(0, offset)) + visibleWidth(url);
      const atEdge = endColumn >= width && url.length === raw.length && offset + raw.length === part.length;
      if (atEdge) {
        return raw;
      }
      return `\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\${raw.slice(url.length)}`;
    });
  });
  return out.join("");
}

/** linkifyLine over every line. */
export function linkifyLines(lines: string[], width: number): string[] {
  return lines.map((l) => linkifyLine(l, width));
}
