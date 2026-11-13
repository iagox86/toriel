import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { listing, parseCommandLine } from "../src/cli.ts";
import { SESSION_COMMANDS, SWITCHER_COMMANDS } from "../src/commands.ts";
import { styleHelp, styleListing } from "../src/help-format.ts";

// visible markers instead of colour codes, so expectations read plainly
const style = { name: (s: string) => `<${s}>`, quiet: (s: string) => `{${s}}` };

describe("styleListing", () => {
  it("accents the name, dims the usage hint and the footer, leaves the description alone", () => {
    const out = styleListing("/btw [options] <q...>  ask a thing\n/exit                  leave\n\n/<command> --help for details", style);
    assert.equal(out, "</btw>{ [options] <q...>}  ask a thing\n</exit>                  leave\n\n{/<command> --help for details}");
  });

  it("changes nothing but escapes, for the real command lists", () => {
    for (const specs of [SESSION_COMMANDS, SWITCHER_COMMANDS]) {
      const plain = listing(specs);
      const styled = styleListing(plain);
      assert.notEqual(styled, plain);
      assert.equal(stripTerminalSequences(styled), plain);
    }
  });
});

describe("styleHelp", () => {
  it("accents the section headers, argument names and flags of a command page", () => {
    const text = "Usage: /model [options] [query...]\n\nthe summary\n\nArguments:\n  query       words\n\nOptions:\n  -l, --list  just show\n  -h, --help  display help\n\nBody prose.\n\nExamples:\n  /model -l";
    assert.equal(
      styleHelp(text, style),
      "<Usage:> /model [options] [query...]\n\nthe summary\n\n<Arguments:>\n  <query>       words\n\n<Options:>\n  <-l, --list>  just show\n  <-h, --help>  display help\n\nBody prose.\n\n<Examples:>\n  /model -l",
    );
  });

  it("changes nothing but escapes, for every real command's page", () => {
    for (const spec of [...SESSION_COMMANDS, ...SWITCHER_COMMANDS]) {
      const parsed = parseCommandLine([spec], `/${spec.name} --help`);
      assert.equal(parsed.kind, "help", spec.name);
      if (parsed.kind === "help") {
        assert.equal(stripTerminalSequences(styleHelp(parsed.text)), parsed.text, spec.name);
      }
    }
  });
});
