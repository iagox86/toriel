import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Command } from "commander";
import { type CommandSpec, parseCommandLine } from "../src/cli.ts";
import { SESSION_COMMANDS, SWITCHER_COMMANDS } from "../src/commands.ts";

describe("command registries", () => {
  for (const [label, specs] of [
    ["switcher", SWITCHER_COMMANDS],
    ["session", SESSION_COMMANDS],
  ] as const) {
    it(`gives every ${label} command working -h and --help`, () => {
      for (const spec of specs) {
        for (const flag of ["-h", "--help"]) {
          const r = parseCommandLine(specs, `/${spec.name} ${flag}`);
          assert.equal(r.kind, "help", `/${spec.name} ${flag}`);
          if (r.kind === "help") {
            assert.match(r.text, new RegExp(`^Usage: /${spec.name}\\b`));
            assert.ok(r.text.includes(spec.description.slice(0, 20)), `/${spec.name} help shows its description`);
          }
        }
      }
    });

    it(`has unique ${label} command names`, () => {
      const names = specs.map((c) => c.name);
      assert.equal(new Set(names).size, names.length);
    });
  }
});

describe("/fork flags", () => {
  const opts = (line: string) => {
    const r = parseCommandLine(SESSION_COMMANDS, line);
    return r.kind === "run" ? r.call.opts : undefined;
  };

  it("enters the copy unless --no-switch is given", () => {
    assert.equal(opts("/fork go")?.switch, true);
    assert.equal(opts("/fork --no-switch go")?.switch, false);
  });
});

describe("command flags", () => {
  const opts = (specs: Parameters<typeof parseCommandLine>[0], line: string) => {
    const r = parseCommandLine(specs, line);
    return r.kind === "run" ? r.call.opts : undefined;
  };

  it("lets /new take a name and a working directory", () => {
    assert.deepEqual(opts(SWITCHER_COMMANDS, "/new -n work -C /tmp"), { name: "work", cwd: "/tmp" });
  });

  it("lets /delete skip its confirmation with -y", () => {
    assert.equal(opts(SWITCHER_COMMANDS, "/delete -y")?.yes, true);
    assert.equal(opts(SWITCHER_COMMANDS, "/delete")?.yes, undefined);
  });

  it("lets /model list everything with --list", () => {
    assert.equal(opts(SESSION_COMMANDS, "/model --list")?.list, true);
    assert.equal(opts(SESSION_COMMANDS, "/model -l")?.list, true);
  });

  it("has /ungroup in the switcher", () => {
    assert.equal(parseCommandLine(SWITCHER_COMMANDS, "/ungroup").kind, "run");
  });
});

describe("command help", () => {
  const all = [
    ...SWITCHER_COMMANDS.map((c) => ["switcher", c] as const),
    ...SESSION_COMMANDS.map((c) => ["session", c] as const),
  ];
  const lists = { switcher: SWITCHER_COMMANDS, session: SESSION_COMMANDS } as const;

  it("answers --help and -h for every command with its description and the longer help", () => {
    for (const [scope, spec] of all) {
      for (const flag of ["--help", "-h"]) {
        const r = parseCommandLine(lists[scope], `/${spec.name} ${flag}`);
        assert.equal(r.kind, "help", `${scope} /${spec.name} ${flag}`);
        if (r.kind === "help") {
          assert.ok(r.text.includes(spec.description.slice(0, 20)), `${scope} /${spec.name} shows its description`);
          assert.ok(r.text.includes(("help" in spec ? spec.help : "") as string), `${scope} /${spec.name} shows its help text`);
        }
      }
    }
  });

  it("explains every command beyond its one-line description", () => {
    const missing = all.filter(([, spec]) => !("help" in spec && typeof spec.help === "string" && spec.help.length > 20)).map(([scope, spec]) => `${scope} /${spec.name}`);
    assert.deepEqual(missing, [], "add a `help:` text (what it does, examples) to these commands");
  });

  it("describes every option and argument", () => {
    for (const [scope, spec] of all) {
      const cmd = new Command(`/${spec.name}`);
      (spec as CommandSpec).build?.(cmd);
      for (const o of cmd.options) {
        assert.ok(o.description, `${scope} /${spec.name} option ${o.flags} has no description`);
      }
      for (const a of cmd.registeredArguments) {
        assert.ok(a.description, `${scope} /${spec.name} argument ${a.name()} has no description`);
      }
    }
  });

  it("lists the session commands from /help", () => {
    assert.ok(SESSION_COMMANDS.some((c) => c.name === "help"));
  });
});

describe("bare /mcp", () => {
  it("passes no action, which the handler reads as list", () => {
    const r = parseCommandLine(SESSION_COMMANDS, "/mcp");
    assert.equal(r.kind, "run");
    assert.deepEqual(r.kind === "run" ? r.call.args : null, []);
  });
});

describe("schedule commands", () => {
  const call = (line: string) => {
    const r = parseCommandLine(SESSION_COMMANDS, line);
    return r.kind === "run" ? r.call : undefined;
  };

  it("passes the whole time spec and prompt through in order, with flags taken out", () => {
    const c = call("/every 30m check the build --max 5 --name poll");
    assert.deepEqual(c?.args, ["30m", "check", "the", "build"]);
    assert.equal(c?.opts.max, "5");
    assert.equal(c?.opts.name, "poll");
  });

  it("keeps a multi-word clock time together with the prompt for the daemon to split", () => {
    assert.deepEqual(call("/at tomorrow 9am look at CI")?.args, ["tomorrow", "9am", "look", "at", "CI"]);
  });

  it("reads a quoted cron expression as one word and /loop with no gap as just the prompt", () => {
    assert.deepEqual(call('/cron "*/15 * * * *" ping')?.args, ["*/15 * * * *", "ping"]);
    assert.deepEqual(call("/loop keep going")?.args, ["keep", "going"]);
  });

  it("protects prompt text that starts with a dash behind --", () => {
    assert.deepEqual(call("/in 5m -- -v is a flag")?.args, ["5m", "-v", "is", "a", "flag"]);
  });

  it("asks for a prompt, and for what to cancel, in plain words", () => {
    assert.equal(parseCommandLine(SESSION_COMMANDS, "/in 5m").kind, "error");
    assert.equal(call("/cancel 3")?.args[0], "3");
    assert.equal(call("/cancel --all")?.opts.all, true);
  });

  it("is offered in both the session and the switcher where it makes sense", () => {
    const names = (specs: readonly { name: string }[]) => specs.map((s) => s.name);
    for (const n of ["in", "at", "every", "loop", "cron", "schedules", "cancel", "pause", "resume", "fire"]) {
      assert.ok(names(SESSION_COMMANDS).includes(n), `session /${n}`);
    }
    for (const n of ["schedules", "cancel", "pause", "resume"]) {
      assert.ok(names(SWITCHER_COMMANDS).includes(n), `switcher /${n}`);
    }
    assert.ok(!names(SWITCHER_COMMANDS).includes("every"), "schedules are created inside a session only");
  });
});
