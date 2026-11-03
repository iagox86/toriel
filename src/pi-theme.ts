// pi's theme must be initialised before any pi component renders. Importing
// this module does that once; the theme instance itself is not exported by pi,
// so only the markdown/select-list getters are available.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { getMarkdownTheme, getSelectListTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { FENCE_MARK } from "./components.ts";
import { visibleFenceInfo } from "./fence-info.ts";
import { AGENT_DIR, dim, THEME_NAME } from "./theme.ts";

// initTheme(name) only searches $PI_CODING_AGENT_DIR/themes. Point it at our
// own dir for the duration of the call; the daemon and its pi children must
// never see the override (it would redirect their auth and settings).
const prev = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
try {
  initTheme(THEME_NAME);
} finally {
  if (prev === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = prev;
  }
}

// highlight.js, the instance pi's renderer reads (see highlightLanguagesLoaded below); undefined when it cannot be found
const nextToPi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const hljs: { getLanguage(name: string): unknown } | undefined = (() => {
  try {
    return nextToPi("highlight.js/lib/index.js");
  } catch {
    return undefined;
  }
})();
// without the highlighter every single word counts as a language, so nothing is shown that might be one
const isLanguage = (name: string): boolean => (hljs ? hljs.getLanguage(name.toLowerCase()) !== undefined : true);

/**
 * codeBlockBorder draws the ``` fence lines. Components drop lines carrying the mark, which is what a fence line
 * normally becomes; one whose text is not a language ("```this is the first line") keeps that text as a dim line,
 * indented like the code under it, so what the person wrote is not lost.
 */
export function fenceBorder(text: string): string {
  const shown = text.startsWith("```") ? visibleFenceInfo(text.slice(3), isLanguage) : undefined;
  return shown === undefined ? FENCE_MARK : `  ${dim(shown)}`;
}
export const mdTheme = { ...getMarkdownTheme(), codeBlockBorder: fenceBorder };
export const selectListTheme = getSelectListTheme();

/**
 * pi registers 21 languages up front and loads the rest (html, css, yaml, sql, ...)
 * only from its interactive mode, which toriel never runs. Importing the full
 * highlight.js from the copy next to pi registers them in the instance pi's
 * renderer reads. Resolves when done; a failure leaves the 21 in place.
 */
export const highlightLanguagesLoaded: Promise<void> = (async () => {
  try {
    const nextToPi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
    await import(pathToFileURL(nextToPi.resolve("highlight.js/lib/index.js")).href);
  } catch {
    // eager languages and plain text still work
  }
})();
