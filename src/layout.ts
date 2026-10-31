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
  switcher: Component;
}

/** A row that takes only the height its content needs (panels that are empty take none). */
const fit = (component: Component) => ({ component, basis: "auto" as const, grow: 0, shrink: 0, minSize: 0 });

export function buildLayouts(p: LayoutParts): { chat: VStack; switcher: VStack } {
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
      fit(p.infoPanel),
      fit(p.choicePanel),
      fit(p.banner),
      dockRow,
    ]),
    switcher: new VStack([{ component: p.switcher, basis: 0, grow: 1, shrink: 1, minSize: 1 }, fit(p.infoPanel), fit(p.choicePanel), dockRow]),
  };
}
