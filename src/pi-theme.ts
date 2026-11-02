// pi's theme must be initialised before any pi component renders. Importing
// this module does that once; the theme instance itself is not exported by pi,
// so only the markdown/select-list getters are available.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { getMarkdownTheme, getSelectListTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { FENCE_MARK } from "./components.ts";
import { AGENT_DIR, THEME_NAME } from "./theme.ts";

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

// codeBlockBorder draws the ``` fence lines; components.ts drops lines carrying the mark
export const mdTheme = { ...getMarkdownTheme(), codeBlockBorder: () => FENCE_MARK };
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
