import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import qaExtension, { stripInputNumbering, stripLabelNumbering } from "../pi/extensions/toriel-qa.ts";

const GUIDELINE = 'When using ask_user_question, never include numbering ("1. ", "1)", bullets) in option labels - the dialog numbers the rows itself; numbering in labels shows doubled.';

describe("toriel-qa extension (ticket 245)", () => {
  const saved = process.env.TORIEL_CHILD;
  afterEach(() => {
    if (saved === undefined) {
      delete process.env.TORIEL_CHILD;
    } else {
      process.env.TORIEL_CHILD = saved;
    }
  });

  const load = () => {
    // biome-ignore lint/suspicious/noExplicitAny: stand-ins for pi's registration calls
    const handlers: Record<string, (...a: any[]) => any> = {};
    qaExtension({ on: (event: string, h: never) => { handlers[event] = h; } } as never);
    return handlers;
  };

  it("registers nothing outside a toriel child", () => {
    delete process.env.TORIEL_CHILD;
    let n = 0;
    qaExtension({ on: () => void n++ } as never);
    assert.equal(n, 0);
  });

  it("appends one guideline to promptGuidelines without disturbing the existing entries", () => {
    process.env.TORIEL_CHILD = "1";
    const handlers = load();
    const guidelines = ["first", "second"];
    handlers.before_agent_start({ systemPromptOptions: { promptGuidelines: guidelines } });
    assert.deepEqual(guidelines, ["first", "second", GUIDELINE]);
    handlers.before_agent_start({ systemPromptOptions: { promptGuidelines: guidelines } });
    assert.deepEqual(guidelines, ["first", "second", GUIDELINE], "added once, not per run");
  });

  it("strips leading numbering and bullet markers from option labels, in place", () => {
    const input = { questions: [{ options: [{ label: "1. Solarized" }, { label: "1) Dark" }, { label: "- Light" }, { label: "10) High contrast" }, { label: "1.5 release" }, { label: "No marker" }] }, { options: [{ label: "* starred" }] }] };
    stripInputNumbering(input);
    assert.deepEqual(input.questions[0]?.options.map((o) => o.label), ["Solarized", "Dark", "Light", "High contrast", "1.5 release", "No marker"]);
    assert.deepEqual(input.questions[1]?.options.map((o) => o.label), ["starred"]);
  });

  it("strips through the tool_call handler and never throws on malformed input", () => {
    process.env.TORIEL_CHILD = "1";
    const handlers = load();
    const input = { questions: [{ options: [{ label: "2. first" }] }] };
    handlers.tool_call({ toolName: "ask_user_question", input });
    assert.equal(input.questions[0]?.options[0]?.label, "first");
    for (const bad of [undefined, null, "no", {}, { questions: "no" }, { questions: [null, {}] }, { questions: [{ options: [{ label: 3 }, null] }] }]) {
      handlers.tool_call({ toolName: "ask_user_question", input: bad });
    }
    handlers.tool_call({ toolName: "read", input });
    assert.equal(stripLabelNumbering("1.5 release"), "1.5 release", "no whitespace after the marker: not numbering");
    assert.equal(stripLabelNumbering("10) x"), "x");
    const onlyMarker = { questions: [{ options: [{ label: "1. " }, { label: "- " }] }] };
    handlers.tool_call({ toolName: "ask_user_question", input: onlyMarker });
    assert.deepEqual(onlyMarker.questions[0]?.options.map((o: { label: string }) => o.label), ["1. ", "- "], "a label that is only a marker keeps its text: pi rejects an empty label");
  });
});
