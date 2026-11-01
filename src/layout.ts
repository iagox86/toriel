// The two screen layouts over one shared input dock: the chat view and the
// switcher view (full-screen minus the dock, so the input box is never covered).
import { type Component, VStack } from "@earendil-works/pi-tui";

export interface LayoutParts {
  editor: Component;
  statusLine: Component;
  scroll: Component;
  activityLine: Component;
  rewindPicker: Component;
  dialogPanel: Component;
  infoPanel: Component;
  choicePanel: Component;
  banner: Component;
  /** The viewed session's schedules, a line each, above the input. */
  scheduleStrip: Component;
  switcher: Component;
  /** True while a permission/extension dialog is on screen in the chat view. */
  dialogOpen: () => boolean;
}

/** A row that takes only the height its content needs (panels that are empty take none). */
const fit = (component: Component) => ({ component, basis: "auto" as const, grow: 0, shrink: 0, minSize: 0 });

/** `component`, drawn only while `hidden()` is false; it keeps its state, so it is back when the condition clears. */
export function hiddenWhile(hidden: () => boolean, component: Component): Component {
  return {
    render: (width) => (hidden() ? [] : component.render(width)),
    invalidate: () => component.invalidate(),
  };
}

export function buildLayouts(p: LayoutParts): { chat: VStack; switcher: VStack } {
  // a dialog blocks the agent, so it owns the screen and the keys; a /btw answer or picker waits behind it
  const info = hiddenWhile(p.dialogOpen, p.infoPanel);
  const choice = hiddenWhile(p.dialogOpen, p.choicePanel);
  const dock = new VStack([
    { component: p.editor, shrink: 0, minSize: 3 },
    { component: p.statusLine, shrink: 0, minSize: 1 },
  ]);
  // never compress the dock: a shrunken editor was the "cut off" bug
  const dockRow = { component: dock, basis: "auto" as const, grow: 0, shrink: 0, minSize: 4 };
  return {
    chat: new VStack([
      { component: p.scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
      fit(p.activityLine),
      fit(p.rewindPicker),
      fit(p.dialogPanel),
      fit(info),
      fit(choice),
      fit(p.banner),
      fit(p.scheduleStrip),
      dockRow,
    ]),
    switcher: new VStack([{ component: p.switcher, basis: 0, grow: 1, shrink: 1, minSize: 1 }, fit(p.infoPanel), fit(p.choicePanel), dockRow]),
  };
}
