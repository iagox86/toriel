// The chat transcript as a pi-tui container that renders only what is on screen (ticket 225). pi-tui's ScrollView asks its child for
// every line of the transcript and slices out the visible rows afterwards, so a session of 8,000 items re-parsed and re-wrapped
// 140,000-350,000 lines (1.7-3.4 s) to show about 50, on every toggle and on the first frame after a switch. This container asks
// only the items in (or near) the window for their lines; the others are blank lines of the height last measured, or an estimate
// when never measured. Heights of unseen items are therefore approximate until they have been on screen once; the scrollbar is
// proportional to the estimate and corrects itself as they are seen.
import { Container, type Component } from "@earendil-works/pi-tui";

/** Where the viewer is looking, in lines of the whole transcript. */
export interface Viewport {
  /** First visible line. */
  top: number;
  /** Visible lines. */
  height: number;
  /** The view is pinned to the end of the transcript (new output scrolls into view). */
  following: boolean;
}

/** Lines rendered beyond each edge of the window, in screens, so a little scrolling does not reveal blanks. */
const MARGIN_SCREENS = 1;
/** What an item that has never been measured is assumed to be, until the average of those that have is known. */
const DEFAULT_HEIGHT = 6;

export class WindowedContainer extends Container {
  /** The viewer's window; without it (or with no height yet) everything is rendered, as a plain container does. */
  viewport?: () => Viewport | undefined;
  /**
   * Called when items above the window turned out taller or shorter than estimated while the viewer is not pinned to the end:
   * the viewer should scroll by this many lines to keep what it is looking at in place.
   */
  onShift?: (lines: number) => void;
  /** Items actually rendered by the last render (for tests and --timing). */
  lastRendered = 0;

  private readonly heights = new WeakMap<Component, number>();
  private readonly seen = new WeakSet<Component>();
  private measuredSum = 0;
  private measured = 0;

  override render(width: number): string[] {
    const vp = this.viewport?.();
    if (!vp || vp.height <= 0) {
      return this.renderAll(width);
    }
    const children = this.children;
    const n = children.length;
    // An item never seen is given a height once (the average of those measured so far) and keeps it until it is drawn, so the
    // total, and with it the scroll position, does not wobble as the average moves.
    const heights = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      const child = children[i] as Component;
      let h = this.heights.get(child);
      if (h === undefined) {
        h = this.measured > 0 ? Math.max(1, Math.round(this.measuredSum / this.measured)) : DEFAULT_HEIGHT;
        this.heights.set(child, h);
      }
      heights[i] = h;
    }

    const margin = vp.height * MARGIN_SCREENS;
    // The items that are asked for their lines (the others stay blank at their last known height).
    const outs = new Array<string[] | undefined>(n);
    this.lastRendered = 0;
    const draw = (i: number): string[] => {
      const child = children[i] as Component;
      const out = child.render(width);
      this.lastRendered++;
      this.measure(child, out.length);
      outs[i] = out;
      return out;
    };
    // the item the viewer is looking at first, and where the estimates put it: what to keep in place when heights change
    let anchor = -1;
    const estimated = heights.slice();
    if (vp.following) {
      // pinned to the end: draw backwards from the last item until a screen and a margin of real lines are covered
      let covered = 0;
      for (let i = n - 1; i >= 0 && covered < vp.height + margin; i--) {
        covered += draw(i).length;
      }
    } else {
      const from = Math.max(0, vp.top - margin);
      const to = vp.top + vp.height + margin;
      let offset = 0;
      for (let i = 0; i < n; i++) {
        const h = estimated[i] as number;
        if (anchor === -1 && offset + h > vp.top) {
          anchor = i;
        }
        if (offset + h > from && offset < to) {
          draw(i);
        }
        offset += h;
      }
    }

    const lines: string[] = [];
    const layout: Array<{ component: Component; height: number }> = [];
    let shifted = 0; // how much the items above the anchor changed height
    for (let i = 0; i < n; i++) {
      const out = outs[i];
      if (out) {
        for (const line of out) {
          lines.push(line);
        }
        layout.push({ component: children[i] as Component, height: out.length });
        if (anchor !== -1 && i < anchor) {
          shifted += out.length - (estimated[i] as number);
        }
      } else {
        const h = heights[i] as number;
        for (let k = 0; k < h; k++) {
          lines.push("");
        }
        layout.push({ component: children[i] as Component, height: h });
      }
    }
    this.mouse().mouseLayout = { width, children: layout };
    if (shifted !== 0 && !vp.following) {
      this.onShift?.(shifted);
    }
    return lines;
  }

  /** pi-tui's own record of child heights for mouse clicks (private in its types): kept in step so a click lands on the right item. */
  private mouse(): { mouseLayout?: { width: number; children: Array<{ component: Component; height: number }> } } {
    return this as never;
  }

  /** An item was drawn: its height is now real, and goes into the average that unseen items are guessed from. */
  private measure(child: Component, height: number): void {
    if (this.seen.has(child)) {
      this.measuredSum += height - (this.heights.get(child) ?? height);
    } else {
      this.seen.add(child);
      this.measuredSum += height;
      this.measured++;
    }
    this.heights.set(child, height);
  }

  private renderAll(width: number): string[] {
    this.lastRendered = this.children.length;
    const lines = super.render(width);
    const layout = this.mouse().mouseLayout?.children;
    if (layout) {
      for (const { component, height } of layout) {
        this.measure(component, height);
      }
    }
    return lines;
  }
}
