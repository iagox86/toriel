import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { parseCommandLine } from "../src/cli.ts";
import { SESSION_COMMANDS } from "../src/commands.ts";
import { infoDir, saveInfo, sessionInfo } from "../src/session-info.ts";
import type { SessionMeta } from "../src/shared.ts";

function meta(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 7,
    cwd: "/w",
    model: "litellm/glm-5.3",
    messageCount: 3,
    streaming: false,
    compacting: false,
    dead: false,
    active: false,
    pendingDialog: false,
    attachedToYou: true,
    attachedElsewhere: false,
    ...over,
  };
}

describe("/info command", () => {
  it("is a session command that takes no argument", () => {
    assert.equal(parseCommandLine(SESSION_COMMANDS, "/info").kind, "run");
    assert.equal(parseCommandLine(SESSION_COMMANDS, "/info --help").kind, "help");
  });
});

describe("sessionInfo", () => {
  it("lists the session file, both ids, model and context", () => {
    const text = sessionInfo({
      meta: meta({
        sessionFile: "/s/fix.jsonl",
        sessionId: "a1b2c3d4-e5f6",
        sessionName: "fix-the-build",
        provider: "litellm",
        thinkingLevel: "high",
        ctxTokens: 123_456,
        ctxMax: 200_000,
      }),
      firstMessage: "fix the login bug",
    });
    assert.match(text, /^# Session: fix-the-build \(toriel id 7\)$/m);
    assert.match(text, /session file.*`\/s\/fix\.jsonl`/);
    assert.match(text, /toriel id 7/);
    assert.match(text, /pi session id.*`a1b2c3d4-e5f6`/);
    assert.match(text, /first message.*fix the login bug/);
    assert.match(text, /model.*`litellm\/glm-5\.3`/);
    assert.match(text, /provider.*litellm/);
    assert.match(text, /thinking level.*high/);
    assert.match(text, /context.*123\.5k of 200\.0k tokens/);
    assert.match(text, /directory.*`\/w`/);
  });

  it("says the values are the last known state and may be stale", () => {
    const text = sessionInfo({ meta: meta() });
    assert.match(text, /last known state/);
    assert.match(text, /stale/);
  });

  it("lists plan and auto mode, grants, the agent profile, and the configured MCP server names", () => {
    const text = sessionInfo({
      meta: meta({ agent: "reviewer", plan: true, auto: true, grants: 2, grantsSaved: 1 }),
      mcpServers: [{ name: "bridge", enabled: true }, { name: "search", enabled: true }],
    });
    assert.match(text, /plan mode.*on/);
    assert.match(text, /auto mode.*on/);
    assert.match(text, /permission grants.*2 active, 1 saved/);
    assert.match(text, /agent profile.*reviewer/);
    assert.match(text, /MCP servers \(configured\).*`bridge`, `search`/);
  });

  it("renders the first message on one line, clipped to about 200 characters with an ellipsis", () => {
    const text = sessionInfo({ meta: meta(), firstMessage: "line one\nline two ".repeat(20) });
    const m = text.match(/^- \*\*first message\*\* (.*)$/m);
    assert.ok(m, "the first message field is there");
    assert.doesNotMatch(m[1], /\n/);
    assert.equal(m[1].length, 202, "oneLineFlat clips to the width and appends the ellipsis");
    assert.match(m[1], /\.\.\.$/);
  });

  it("marks a disabled MCP server", () => {
    const text = sessionInfo({ meta: meta(), mcpServers: [{ name: "bridge", enabled: true }, { name: "search", enabled: false }] });
    assert.match(text, /MCP servers \(configured\).*`bridge`.*`search` \(disabled\)/);
  });

  it("notes mcp.yaml problems with the right plural, pointing at /mcp status", () => {
    assert.match(sessionInfo({ meta: meta(), mcpServers: [{ name: "bridge", enabled: true }], mcpProblems: 1 }), /mcp\.yaml has 1 problem; see \/mcp status/);
    assert.match(sessionInfo({ meta: meta(), mcpServers: [{ name: "bridge", enabled: true }], mcpProblems: 2 }), /mcp\.yaml has 2 problems; see \/mcp status/);
  });

  it("shows the MCP line for problems even when there are no servers, and omits it when there are neither", () => {
    assert.match(sessionInfo({ meta: meta(), mcpServers: [], mcpProblems: 3 }), /^- \*\*MCP servers \(configured\)\*\*.*3 problems/m);
    assert.doesNotMatch(sessionInfo({ meta: meta(), mcpServers: [], mcpProblems: 0 }), /MCP servers/);
  });

  it("says the context is unknown until the next reply after a compaction, with or without a max", () => {
    const note = /^- \*\*context\*\* unknown until the next reply \(just compacted\)$/m;
    assert.match(sessionInfo({ meta: meta({ ctxTokens: null }) }), note);
    const withMax = sessionInfo({ meta: meta({ ctxTokens: null, ctxMax: 200_000 }) });
    assert.match(withMax, note);
    assert.doesNotMatch(withMax, /200\.0k/);
  });

  it("shows the default modes and grants plainly when they are off or absent", () => {
    const text = sessionInfo({ meta: meta() });
    assert.match(text, /plan mode.*off/);
    assert.match(text, /auto mode.*off/);
    assert.match(text, /permission grants.*none/);
  });

  it("omits the fields it does not have, and does not show an empty MCP list", () => {
    const text = sessionInfo({ meta: meta(), mcpServers: [] });
    assert.doesNotMatch(text, /pi session id/);
    assert.doesNotMatch(text, /name \*\*/);
    assert.doesNotMatch(text, /first message/);
    assert.doesNotMatch(text, /^- \*\*context/);
    assert.doesNotMatch(text, /MCP servers/);
    assert.doesNotMatch(text, /provider/);
    assert.doesNotMatch(text, /thinking level/);
  });

  it("shows the context it has when only one half is known, and nothing when neither is", () => {
    assert.match(sessionInfo({ meta: meta({ ctxTokens: 5_000 }) }), /^- \*\*context\*\* 5\.0k tokens/m);
    assert.match(sessionInfo({ meta: meta({ ctxMax: 200_000 }) }), /^- \*\*context\*\* 200\.0k tokens max/m);
  });

  it("never renders strings outside the card's fields, so nothing secret-looking reaches the text", () => {
    const full: Record<string, unknown> = {
      ...meta({ sessionFile: "/s/x.jsonl" }),
      settingsProblem: "bearer sk-fake-1234567890 was in the header",
      headers: { Authorization: "Bearer tok_fake-987654321" },
    };
    const text = sessionInfo({ meta: full as unknown as SessionMeta });
    assert.doesNotMatch(text, /sk-fake-1234567890/);
    assert.doesNotMatch(text, /tok_fake-987654321/);
    assert.doesNotMatch(text, /bearer/i);
  });
});

describe("saving the card", () => {
  it("writes the card to a markdown file under the info dir and returns its path", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-info-"));
    try {
      const file = saveInfo("# Session: x\n", dir, new Date("2025-01-01T00:00:00.000Z"));
      assert.equal(file, path.join(dir, "info-2025-01-01T00-00-00-000Z.md"));
      assert.equal(fs.readFileSync(file, "utf8"), "# Session: x\n");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("saves under $XDG_DATA_HOME/toriel/info by default", () => {
    assert.equal(infoDir({ XDG_DATA_HOME: "/d" }), path.join("/d", "toriel", "info"));
  });
});
