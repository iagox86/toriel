import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

  it("offers models after /new -m or --model in the switcher, keeping the flags before it (ticket 247)", async () => {
    const ctx = { ...base, switcher: true, sources };
    assert.deepEqual(await suggest(ctx, "/new -n work -m glm"), ["-n work -m zai/glm-5.3-flash", "-n work -m zai/glm-5.3"]);
    assert.deepEqual(await suggest(ctx, "/new --model opus"), ["--model anthropic/claude-opus"]);
    assert.deepEqual(await suggest(ctx, "/new -a ex"), ["-a explore"]);
  });

  describe("with Tab (an explicit request) after the command name, ticket 247", () => {
    // pi-tui sends Tab on a line with a space to FILE completion unless the provider downgrades the request
    const tab = async (ctx: AutocompleteContext, text: string) => {
      const p = new CommandAutocomplete(() => ctx);
      const r = await p.getSuggestions([text], 0, text.length, { signal: new AbortController().signal, force: true });
      return r?.items.map((i) => i.value) ?? [];
    };

    it("completes /new's model after -m or --model, in the switcher", async () => {
      const ctx = { ...base, switcher: true, sources };
      assert.deepEqual(await tab(ctx, "/new -m glm"), ["-m zai/glm-5.3-flash", "-m zai/glm-5.3"]);
      assert.deepEqual(await tab(ctx, "/new --model opus"), ["--model anthropic/claude-opus"]);
      assert.deepEqual(await tab(ctx, "/new -m "), ["-m zai/glm-5.3-flash", "-m zai/glm-5.3", "-m anthropic/claude-opus"]);
      assert.deepEqual(await tab(ctx, "/new -a ex"), ["-a explore"]);
    });

    it("completes from a bare trailing flag, before the space is typed", async () => {
      const ctx = { ...base, switcher: true, sources };
      assert.deepEqual(await tab(ctx, "/new -m"), ["-m zai/glm-5.3-flash", "-m zai/glm-5.3", "-m anthropic/claude-opus"]);
      assert.deepEqual(await tab(ctx, "/new -n x --model"), ["-n x --model zai/glm-5.3-flash", "-n x --model zai/glm-5.3", "-n x --model anthropic/claude-opus"]);
      assert.deepEqual(await tab(ctx, "/new -a"), ["-a explore"]);
      assert.deepEqual(await suggest(ctx, "/new -m"), ["-m zai/glm-5.3-flash", "-m zai/glm-5.3", "-m anthropic/claude-opus"], "and without Tab");
    });

    it("does not treat a longer flag or a flag inside a word as -m", async () => {
      const ctx = { ...base, switcher: true, sources };
      assert.deepEqual(await tab(ctx, "/new -mx"), []);
      assert.deepEqual(await tab(ctx, "/new -n foo-m"), []);
    });

    it("makes /model's Tab use its own completer in a session", async () => {
      assert.deepEqual(await tab({ ...base, sources }, "/model zai flash"), ["zai/glm-5.3-flash"]);
    });

    it("keeps /cd completing directories through its own completer", async () => {
      const out = await tab({ ...base, switcher: true, sources }, "/cd /tm");
      assert.ok(out.includes("/tmp/"), `got ${JSON.stringify(out)}`);
    });

    it("leaves Tab to file completion for a command with no completer of its own, and for text that is not a command", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-ac-"));
      try {
        fs.writeFileSync(path.join(dir, "zzfile.txt"), "x");
        const ctx = { ...base, cwd: dir, sources };
        assert.ok((await tab(ctx, "/doctor zz")).some((v) => v.includes("zzfile.txt")), "/doctor has no completer: files");
        assert.ok((await tab(ctx, "look at zz")).some((v) => v.includes("zzfile.txt")), "plain text: files");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("does not downgrade without live sources, or for a command the highlighted header cannot use", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-ac-"));
      try {
        fs.writeFileSync(path.join(dir, "zzfile.txt"), "x");
        assert.ok((await tab({ ...base, cwd: dir }, "/model zz")).some((v) => v.includes("zzfile.txt")), "no sources: files, as before");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
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
    assert.deepEqual(await suggest({ ...base, sources }, "/mcp "), ["list", "status ", "explore ", "add ", "remove ", "token ", "reconnect ", "login ", "logout "]);
    assert.deepEqual(await suggest({ ...base, sources }, "/mcp rec"), ["reconnect "]);
    assert.deepEqual(await suggest({ ...base, sources }, "/mcp reconnect "), ["reconnect mealie", "reconnect freecad"]);
    assert.deepEqual(await suggest({ ...base, sources }, "/mcp reconnect f"), ["reconnect freecad"]);
    assert.deepEqual(await suggest({ ...base, sources }, "/mcp explore f"), ["explore freecad"]);
  });

  it("closes the popup once the typed argument is a whole completion, so Enter submits (ticket 200)", async () => {
    assert.deepEqual(await suggest({ ...base, sources }, "/think low"), []);
    assert.deepEqual(await suggest({ ...base, sources }, "/mcp list"), []);
    assert.deepEqual(await suggest({ ...base, sources }, "/mcp status"), []);
    assert.deepEqual(await suggest({ ...base, sources }, "/mcp reconnect freecad"), []);
    // still open while the word is only a prefix, and for the command name itself (Enter submits there)
    assert.deepEqual(await suggest({ ...base, sources }, "/think lo"), ["low"]);
    assert.ok((await suggest({ ...base, sources }, "/think")).includes("think"));
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
  const make = async (switcher: boolean, sources?: AutocompleteContext["sources"]) => {
    const { InputEditor, configureEditorKeys } = await import("../src/editor.ts");
    configureEditorKeys();
    const ed = new InputEditor({ requestRender() {}, terminal: { rows: 40, columns: 80 } } as never, theme as never);
    ed.setAutocompleteProvider(new CommandAutocomplete(() => ({ ...base, switcher, cwd: process.cwd(), sources })));
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

  it("submits on the first Enter when the typed argument is already a whole completion (ticket 200)", async () => {
    const { ed, press } = await make(false, { models: async () => [], thinkingLevels: async () => ["off", "low"], groups: () => [], agents: () => [], mcpServers: async () => [] });
    let submitted = "";
    ed.onSubmit = (text) => {
      submitted = text;
    };
    await press(..."/think low".split(""));
    assert.equal(ed.isShowingAutocomplete(), false);
    await press("\r");
    assert.equal(submitted, "/think low");
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
