// The switcher's temporary list filter: /filter, and ctrl-f, which filters as
// you type in the chat box.
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { parseCommandLine } from "./cli.ts";
import { SWITCHER_COMMANDS } from "./commands.ts";
import type { Host } from "./host.ts";
import { compileFilter, type Filter } from "./session-filter.ts";
import { errText } from "./util.ts";

export class SwitcherFilter {
  /** The filter in force (null = none). */
  current: Filter | null = null;
  /** ctrl-f: the box text is the filter and applies as it is typed. */
  live = false;

  private readonly h: Host;
  private readonly refresh: () => void;

  constructor(host: Host, refresh: () => void) {
    this.h = host;
    this.refresh = refresh;
  }

  /** Forget the filter without redrawing (the switcher is opening or closing). */
  reset(): void {
    this.current = null;
    this.live = false;
    this.h.editor.onChange = undefined;
  }

  /** Set the filter from /filter-style text; returns an error message for a bad pattern. */
  set(text: string, regex: boolean): string | undefined {
    try {
      this.current = compileFilter(text, regex);
    } catch (err) {
      return errText(err);
    }
    this.refresh();
    this.h.renderChrome(); // the status line names the highlighted row
    return undefined;
  }

  clear(): void {
    this.reset();
    this.refresh();
    this.h.renderChrome();
  }

  /** ctrl-f: start filtering as you type (the box takes the same text as /filter). */
  startLive(): void {
    this.live = true;
    this.h.editor.setText("");
    this.h.editor.onChange = (text) => this.applyLiveText(text);
    this.h.switcher.hint = "filter as you type - up/down move - enter keeps it - esc clears it (-r for a regex)";
    this.h.tui.requestRender();
  }

  private applyLiveText(text: string): void {
    const parsed = parseCommandLine(SWITCHER_COMMANDS, `/filter ${text}`);
    if (parsed.kind !== "run") {
      return; // a half-typed flag or quote: keep what is shown
    }
    const error = this.set(parsed.call.args.join(" "), parsed.call.opts.regex === true);
    if (error) {
      this.h.switcher.hint = `filter: ${error}`;
      this.h.tui.requestRender();
    }
  }

  /** Keys while ctrl-f filtering; true when consumed. */
  liveKeys(data: string): boolean {
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      this.h.switcher.move(matchesKey(data, Key.up) ? -1 : 1);
      this.h.tui.requestRender();
      return true;
    }
    if (matchesKey(data, Key.enter)) {
      // keep the filter, give the box back
      this.live = false;
      this.h.editor.onChange = undefined;
      this.h.editor.setText("");
      this.h.switcher.hint = "filter kept - esc or /filter clears it";
      this.h.tui.requestRender();
      return true;
    }
    if (matchesKey(data, Key.escape)) {
      this.h.editor.onChange = undefined;
      this.h.editor.setText("");
      this.clear();
      this.h.switcher.hint = "";
      return true;
    }
    return false;
  }
}
