import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CommandAutocomplete, commandsFor, type AutocompleteContext } from "../src/autocomplete.ts";
import { SESSION_COMMANDS, SWITCHER_COMMANDS } from "../src/commands.ts";

const base: AutocompleteContext = { switcher: false, piCommands: [], cwd: "/" };
const names = (ctx: AutocompleteContext) => commandsFor(ctx).map((c) => c.name);
const suggest = async (ctx: AutocompleteContext, text: string) => {
  const p = new CommandAutocomplete(() => ctx);
  const r = await p.getSuggestions([text], 0, text.length, { signal: new AbortController().signal });
  return r?.items.map((i) => i.value) ?? [];
};

describe("command autocomplete", () => {
  it("offers every registered switcher command in the switcher", () => {
    assert.deepEqual(names({ ...base, switcher: true }), SWITCHER_COMMANDS.map((c) => c.name));
  });

  it("offers toriel's session commands plus whatever pi reports", () => {
    const ctx = { ...base, piCommands: [{ name: "skill:demo", description: "d" }] };
    assert.deepEqual(names(ctx), [...SESSION_COMMANDS.map((c) => c.name), "skill:demo"]);
  });

  it("lets a toriel command win over a pi command of the same name", () => {
    const ctx = { ...base, piCommands: [{ name: "exit" }] };
    assert.equal(names(ctx).filter((n) => n === "exit").length, 1);
  });

  it("completes a typed prefix in the switcher", async () => {
    const out = await suggest({ ...base, switcher: true }, "/ki");
    assert.deepEqual(out, ["kill-daemon"]);
  });

  it("picks up commands pi reports after the provider was built", async () => {
    const ctx: AutocompleteContext = { ...base };
    assert.deepEqual(await suggest(ctx, "/skill"), []);
    ctx.piCommands = [{ name: "skill:demo" }];
    assert.deepEqual(await suggest(ctx, "/skill"), ["skill:demo"]);
  });

  it("leaves out the commands that need a session while a group heading is highlighted", async () => {
    const offered = async (headerSelected: boolean) => (await suggest({ ...base, switcher: true, headerSelected }, "/")).sort();
    const onSession = await offered(false);
    const onHeader = await offered(true);
    for (const gone of ["stop", "delete", "rename", "group", "park", "comment"]) {
      assert.ok(onSession.includes(gone), gone);
      assert.ok(!onHeader.includes(gone), gone);
    }
    for (const kept of ["new", "filter", "help"]) {
      assert.ok(onHeader.includes(kept), kept);
    }
  });

  it("stays out of the way for plain text in the switcher", async () => {
    assert.deepEqual(await suggest({ ...base, switcher: true }, "hello"), []);
  });
});

describe("tab on an empty box", () => {
  const force = async (ctx: AutocompleteContext, lines: string[]) => {
    const p = new CommandAutocomplete(() => ctx);
    return { p, r: await p.getSuggestions(lines, 0, 0, { signal: new AbortController().signal, force: true }) };
  };

  it("offers the slash commands, with descriptions, instead of files", async () => {
    const { r } = await force({ ...base, cwd: process.cwd() }, [""]);
    assert.deepEqual(r?.items.map((i) => i.value), SESSION_COMMANDS.map((c) => c.name));
    assert.ok(r?.items.every((i) => i.description));
  });

  it("inserts the chosen command with its slash", async () => {
    const { p, r } = await force(base, [""]);
    const item = r!.items.find((i) => i.value === "help")!;
    const done = p.applyCompletion([""], 0, 0, item, r!.prefix);
    assert.deepEqual(done.lines, ["/help "]);
    assert.equal(done.cursorCol, 6);
  });

  it("does the same in the switcher", async () => {
    const { r } = await force({ ...base, switcher: true }, [""]);
    assert.deepEqual(r?.items.map((i) => i.value), SWITCHER_COMMANDS.map((c) => c.name));
  });

  it("still completes files once there is text", async () => {
    const { r } = await force({ ...base, cwd: process.cwd() }, ["pack"]);
    assert.ok(!r || r.items.every((i) => !i.value.startsWith("/")));
  });
});

describe("argument completion", () => {
  const sources = {
    models: async () => ["zai/glm-5.3-flash", "zai/glm-5.3", "anthropic/claude-opus"],
    thinkingLevels: async () => ["off", "minimal", "low", "medium", "high"],
    groups: () => ["Work", "Home"],
    agents: () => [{ name: "explore", description: "look around" }],
    mcpServers: async () => [
      { name: "mealie", detail: "connected, 12 tools (direct)" },
      { name: "freecad", detail: "failed (direct)" },
    ],
  };

  it("offers the viewed session's models after /model, narrowed by the words typed", async () => {
    assert.deepEqual(await suggest({ ...base, sources }, "/model "), [
      "zai/glm-5.3-flash",
      "zai/glm-5.3",
      "anthropic/claude-opus",
    ]);
    assert.deepEqual(await suggest({ ...base, sources }, "/model zai flash"), ["zai/glm-5.3-flash"]);
  });

  it("offers group names after /group in the switcher", async () => {
    assert.deepEqual(await suggest({ ...base, switcher: true, sources }, "/group ho"), ["Home"]);
  });

  it("offers the model's thinking levels after /think, narrowed by the prefix typed", async () => {
    assert.deepEqual(await suggest({ ...base, sources }, "/think "), [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    assert.deepEqual(await suggest({ ...base, sources }, "/think mi"), ["minimal"]);
  });

  it("offers the MCP actions, then the servers with their states", async () => {
    assert.deepEqual(await suggest({ ...base, sources }, "/mcp "), ["list", "status ", "explore ", "add ", "remove ", "reconnect ", "login ", "logout "]);
    assert.deepEqual(await suggest({ ...base, sources }, "/mcp rec"), ["reconnect "]);
    assert.deepEqual(await suggest({ ...base, sources }, "/mcp reconnect "), ["reconnect mealie", "reconnect freecad"]);
    assert.deepEqual(await suggest({ ...base, sources }, "/mcp reconnect f"), ["reconnect freecad"]);
    assert.deepEqual(await suggest({ ...base, sources }, "/mcp explore f"), ["explore freecad"]);
  });

  it("does not try to complete flags", async () => {
    assert.deepEqual(await suggest({ ...base, sources }, "/model --li"), []);
  });

  it("offers nothing for commands without a fixed set of choices", async () => {
    assert.deepEqual(await suggest({ ...base, sources }, "/compact "), []);
  });
});

describe("a tab popup in the real editor", () => {
  const theme = { borderColor: (s: string) => s, selectList: { selectedPrefix: (s: string) => s, selectedText: (s: string) => s, description: (s: string) => s, scrollInfo: (s: string) => s, noMatch: (s: string) => s } };
  const make = async (switcher: boolean) => {
    const { InputEditor, configureEditorKeys } = await import("../src/editor.ts");
    configureEditorKeys();
    const ed = new InputEditor({ requestRender() {}, terminal: { rows: 40, columns: 80 } } as never, theme as never);
    ed.setAutocompleteProvider(new CommandAutocomplete(() => ({ ...base, switcher, cwd: process.cwd() })));
    const press = async (...keys: string[]) => {
      for (const k of keys) {
        ed.handleInput(k);
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    return { ed, press };
  };

  it("closes when the switcher box holds text that is not a command", async () => {
    const { ed, press } = await make(true);
    await press("\t");
    assert.equal(ed.isShowingAutocomplete(), true);
    await press("t", "e", "s", "t");
    assert.equal(ed.isShowingAutocomplete(), false);
    await press("\r");
    assert.ok(!ed.getText().includes("btw"), "no stale command was spliced into the text");
  });

  it("keeps completing commands when the text becomes a command name", async () => {
    const { ed, press } = await make(false);
    let submitted = "";
    ed.onSubmit = (text) => {
      submitted = text;
    };
    await press("\t", "/", "h");
    assert.equal(ed.isShowingAutocomplete(), true);
    await press("\r");
    assert.equal(submitted.trim(), "/help");
  });

  it("is dismissed by esc, which never reaches the controller's own esc handling", async () => {
    const { ed, press } = await make(false);
    let sawEsc = false;
    ed.onKey = (data) => {
      sawEsc = sawEsc || data === "\x1b";
      return false;
    };
    await press("\t");
    assert.equal(ed.isShowingAutocomplete(), true);
    await press("\x1b");
    assert.equal(ed.isShowingAutocomplete(), false);
    assert.equal(sawEsc, false);
    await press("\x1b");
    assert.equal(sawEsc, true, "with no popup, esc goes to the controller as before");
  });
});
