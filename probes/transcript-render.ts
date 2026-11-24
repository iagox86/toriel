// How long the transcript takes to draw, for a big session (ticket 225): `node probes/transcript-render.ts [session.jsonl] [--items N]`
// (add `node --cpu-prof` in front for a profile). Builds the items the controller would (from a session file, or a synthetic
// transcript of N items with thinking, markdown, code and tool calls), then times the chat container's render the way the
// controller drives it: first frame, tools expanded/collapsed, thinking hidden/shown, and a view scrolled up, once with pi-tui's
// plain Container (everything is rendered; what toriel did before) and once with the WindowedContainer (what it does now).
// The numbers are the test of any change to how the transcript is drawn: `toriel --timing` shows the same slow frames live.
import { Container } from "@earendil-works/pi-tui";
import * as theme from "../src/pi-theme.ts";
import { type Item, itemsFromFile, itemsFromMessages } from "../src/transcript.ts";
import { type Viewport, WindowedContainer } from "../src/windowed-container.ts";

const args = process.argv.slice(2);
const countAt = args.indexOf("--items");
const count = countAt === -1 ? 8000 : Number(args[countAt + 1]);
const file = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--items");
const WIDTH = 120;
const ROWS = 50;

for (const [name, init] of Object.entries(theme)) {
  if (typeof init === "function" && /^(init|setup|load)/i.test(name)) {
    try {
      (init as () => void)();
    } catch {
      // not an initialiser
    }
  }
}
const tui = { requestRender() {}, terminal: { rows: ROWS, columns: WIDTH } } as never;

function synthetic(n: number): unknown[] {
  const messages: unknown[] = [];
  for (let i = 0; messages.length < n; i++) {
    messages.push({ role: "user", content: [{ type: "text", text: `Please look at module ${i} and tell me what it does, then fix the failing test.` }] });
    messages.push({
      role: "assistant",
      content: [
        { type: "thinking", thinking: `Let me think about module ${i}. ${"The file has several functions and I need to read them carefully. ".repeat(6)}` },
        { type: "text", text: `Module ${i} does three things:\n\n- parses input\n- validates it\n- writes the result\n\n\`\`\`ts\nexport function run${i}(input: string): number {\n  const parts = input.split(",");\n  return parts.length + ${i};\n}\n\`\`\`\n\n${"It is called from the controller on every frame. ".repeat(5)}` },
        { type: "toolCall", id: `c${i}`, name: "bash", arguments: { command: `grep -rn run${i} src | head -20` } },
      ],
    });
    messages.push({ role: "toolResult", toolCallId: `c${i}`, toolName: "bash", isError: false, content: [{ type: "text", text: Array.from({ length: 20 }, (_, k) => `src/file${k}.ts:${k * 7}: run${i}(x)`).join("\n") }] });
  }
  return messages.slice(0, n);
}

function show(items: Item[], tools: boolean, hide: boolean): void {
  for (const item of items) {
    const c = item.component as never as Record<string, (...a: unknown[]) => void> & { expanded: boolean };
    if (item.kind === "tools") {
      c.expanded = tools;
    } else if (item.kind === "assistant") {
      c.setHiddenThinkingLabel?.("");
      c.setHideThinkingBlock?.(hide);
      c.setShowRawError?.(tools);
    } else if (item.kind === "bash" || item.kind === "compaction") {
      c.setExpanded?.(tools);
    }
  }
}

function run(label: string, items: Item[], root: Container, view: { vp: Viewport | undefined }): void {
  const frame = (what: string, vp: Viewport | undefined): void => {
    view.vp = vp;
    const t0 = performance.now();
    const lines = root.render(WIDTH);
    const ms = Math.round(performance.now() - t0);
    const drawn = root instanceof WindowedContainer ? `, ${root.lastRendered} items drawn` : "";
    console.log(`${label.padEnd(9)} ${what.padEnd(16)} ${String(ms).padStart(5)} ms  ${String(lines.length).padStart(7)} lines${drawn}`);
  };
  const end: Viewport = { top: 0, height: ROWS, following: true };
  show(items, false, false);
  frame("first frame", end);
  frame("next frame", end);
  show(items, true, false);
  root.invalidate();
  frame("tools expanded", end);
  show(items, false, false);
  root.invalidate();
  frame("tools collapsed", end);
  show(items, false, true);
  root.invalidate();
  frame("thinking hidden", end);
  show(items, false, false);
  root.invalidate();
  frame("thinking shown", end);
  frame("scrolled up", { top: 20000, height: ROWS, following: false });
}

const items = file ? itemsFromFile(file, tui, process.cwd()) : itemsFromMessages(synthetic(count), tui, process.cwd());
console.log(`${items.length} items (${file ?? "synthetic"}), ${WIDTH} columns, ${ROWS} rows\n`);
const plain = new Container();
for (const item of items) {
  plain.addChild(item.component);
}
run("plain", items, plain, { vp: undefined });

const rebuilt = file ? itemsFromFile(file, tui, process.cwd()) : itemsFromMessages(synthetic(count), tui, process.cwd());
const windowed = new WindowedContainer();
const view: { vp: Viewport | undefined } = { vp: undefined };
windowed.viewport = () => view.vp;
for (const item of rebuilt) {
  windowed.addChild(item.component);
}
run("windowed", rebuilt, windowed, view);
