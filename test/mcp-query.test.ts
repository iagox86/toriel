// The /mcp question's state (src/mcp-query.ts, ticket 346 and its review round): the
// shared promise, the swallow tap's ownership and shape recognition, and what a
// stopped or replaced child leaves behind. Tap presence is observed through accept():
// a tap takes an answer-shaped notice (true), and no tap at all lets it past (false).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RpcClient } from "@earendil-works/pi-coding-agent";
import { mcpAnswerOf, McpQueries, type McpQueriesEnv } from "../src/mcp-query.ts";
import { MCP_PENDING_MARK } from "../pi/extensions/lib/mcp-config.ts";

const PENDING = `${MCP_PENDING_MARK}mealie: connecting (direct)`;
const ANSWER = "mealie: connected, 12 tools (direct)";
const PROBLEM = "MCP servers need attention:\n  freecad: failed";
const UNRELATED = "Moved to the background: j1 (fake)";

const env = (over: Partial<McpQueriesEnv> = {}): McpQueriesEnv & { prompts: string[] } => {
  const prompts: string[] = [];
  return {
    prompts,
    prompt: async (_child: RpcClient, text: string) => {
      prompts.push(text);
    },
    hasPendingCommand: async () => true,
    capError: "no answer from /mcp yet (cap)",
    dropError: "the child went away",
    ...over,
  } as McpQueriesEnv & { prompts: string[] };
};

const child = (): RpcClient =>
  ({
    prompt: async () => undefined,
    getCommands: async () => [],
  }) as unknown as RpcClient;

describe("mcpAnswerOf", () => {
  it("recognizes the pending list behind its mark, a parseable status and pi's none-configured text", () => {
    assert.equal(mcpAnswerOf(PENDING), "mealie: connecting (direct)");
    assert.equal(mcpAnswerOf(ANSWER), ANSWER);
    assert.equal(mcpAnswerOf("No MCP servers configured."), "No MCP servers configured.");
    assert.equal(mcpAnswerOf(UNRELATED), undefined);
    assert.equal(mcpAnswerOf(PROBLEM), undefined);
    assert.equal(mcpAnswerOf(""), undefined);
  });

  it("indented lines are never an answer, and an unrelated X: Y notice is not eaten", () => {
    assert.equal(mcpAnswerOf("  freecad: failed (indented tail)"), undefined);
    assert.equal(mcpAnswerOf(UNRELATED), undefined);
    assert.equal(mcpAnswerOf("X: Y"), undefined);
    assert.equal(mcpAnswerOf(`X: Y\n${ANSWER}`), undefined, "one non-status line fails the whole text");
    assert.equal(mcpAnswerOf(""), undefined);
  });

  it("config-only text is an answer whole, and config lines ride along with server lines (review round 2)", () => {
    assert.equal(mcpAnswerOf("config error: bad.json"), "config error: bad.json");
    assert.equal(mcpAnswerOf("overridden: x"), "overridden: x");
    assert.equal(mcpAnswerOf("config error: bad.json\noverridden: y"), "config error: bad.json\noverridden: y");
    assert.equal(mcpAnswerOf(`config error: bad.json\n${ANSWER}`), `config error: bad.json\n${ANSWER}`);
  });

  it("a closed server line is pi's answer too (review round 2: pi's runtime can leave a server closed)", () => {
    assert.equal(mcpAnswerOf("mealie: closed"), "mealie: closed");
    assert.equal(mcpAnswerOf("mealie: closed\nfreecad: failed (direct)"), "mealie: closed\nfreecad: failed (direct)");
  });

  it("a state word must end at its edge: pi's tails answer, a follow-on sentence does not (review round 2)", () => {
    assert.equal(mcpAnswerOf("Sync: connected to remote"), undefined);
    assert.equal(mcpAnswerOf("Theme: failed to load"), undefined);
    assert.equal(mcpAnswerOf("mealie: connected (direct)"), "mealie: connected (direct)");
    assert.equal(mcpAnswerOf("mealie: connecting\u2026 (codemode)"), "mealie: connecting\u2026 (codemode)");
    assert.equal(mcpAnswerOf("mealie: failed: connect ECONNREFUSED 127.0.0.1:39280"), "mealie: failed: connect ECONNREFUSED 127.0.0.1:39280");
  });
});

describe("McpQueries", () => {
  it("answers the ask with the child's shape-recognized notice, and the tap is gone after", async () => {
    const e = env();
    const mcp = new McpQueries(e);
    const c = child();
    const ask = mcp.ask(1, c, 60_000, 120_000);
    assert.equal(mcp.shared(1), ask, "the in-flight question is shared");
    assert.deepEqual(e.prompts, ["/mcp"]);
    assert.equal(mcp.accept(1, c, ANSWER), true);
    assert.equal(await ask, ANSWER);
    assert.equal(mcp.accept(1, c, ANSWER), false, "the tap was taken with the answer");
    assert.equal(mcp.shared(1), undefined, "the question left the share");
  });

  it("a second asker shares the in-flight question's promise, and the child is asked once", async () => {
    const e = env();
    const mcp = new McpQueries(e);
    const first = mcp.ask(1, child(), 60_000, 120_000);
    const second = mcp.ask(1, child(), 60_000, 120_000);
    assert.equal(second, first);
    assert.deepEqual(e.prompts, ["/mcp"]);
    mcp.drop(1);
    await assert.rejects(second, /the child went away/); // the drop settles the shared promise; the asker reads why
  });

  it("lets a problem report and an unrelated notice through, and answers with the pending list", async () => {
    const e = env();
    const mcp = new McpQueries(e);
    const c = child();
    const ask = mcp.ask(1, c, 60_000, 120_000);
    assert.equal(mcp.accept(1, c, PROBLEM), false, "pi's own problem report is not the answer");
    assert.equal(mcp.accept(1, c, UNRELATED), false, "another extension's notice is not eaten");
    assert.equal(mcp.accept(1, c, PENDING), true);
    assert.equal(await ask, "mealie: connecting (direct)");
    assert.equal(mcp.shared(1), undefined, "the question left the share, so a new ask starts fresh");
    assert.equal(mcp.accept(1, c, UNRELATED), false);
  });

  it("the tap stays past the pending answer for pi's late answer, whose shape retires it", async () => {
    const e = env();
    const mcp = new McpQueries(e);
    const c = child();
    const ask = mcp.ask(1, c, 60_000, 120_000);
    mcp.accept(1, c, PENDING);
    assert.equal(await ask, "mealie: connecting (direct)");
    assert.equal(mcp.accept(1, c, ANSWER), true, "the tap is still armed: pi's own late answer ends the wait");
    assert.equal(mcp.accept(1, c, ANSWER), false, "and takes the tap with it");
  });

  it("a new ask of the same child joins the armed tap: its count covers pi's answers, and retirement leaves it fresh (review round 2)", async () => {
    const e = env();
    const mcp = new McpQueries(e);
    const c = child();
    const first = mcp.ask(1, c, 60_000, 120_000);
    assert.equal(mcp.accept(1, c, PENDING), true);
    assert.equal(await first, "mealie: connecting (direct)");
    assert.equal(mcp.shared(1), undefined);
    const second = mcp.ask(1, c, 60_000, 120_000);
    assert.equal(mcp.shared(1), second, "an ask of the child pi is still answering starts its own promise");
    assert.equal(mcp.accept(1, c, ANSWER), true, "the armed tap served the new ask: it was not replaced");
    assert.equal(await second, ANSWER);
    assert.equal(mcp.accept(1, c, ANSWER), true, "the second of pi's answers is still the tap's to swallow: one per outstanding /mcp");
    assert.equal(mcp.accept(1, c, ANSWER), false, "and the count spent, the tap retired: a third answer would leak");
    const third = mcp.ask(1, c, 60_000, 120_000);
    assert.deepEqual(e.prompts, ["/mcp", "/mcp", "/mcp"], "a fresh ask after the retirement asked the child again");
    assert.equal(mcp.accept(1, c, ANSWER), true, "the fresh tap took the next answer and resolved its asker");
    assert.equal(await third, ANSWER);
  });

  it("the cap of a question the pending answer already settled still spends its shot, so the tap retires after pi's one answer (review round 2)", async () => {
    const e = env();
    const mcp = new McpQueries(e);
    const c = child();
    const first = mcp.ask(1, c, 60_000, 30);
    assert.equal(mcp.accept(1, c, PENDING), true);
    assert.equal(await first, "mealie: connecting (direct)");
    const second = mcp.ask(1, c, 60_000, 120_000);
    await new Promise((r) => setTimeout(r, 60)); // the first's cap fires on the already-settled question and spends its shot
    assert.equal(mcp.accept(1, c, ANSWER), true, "one outstanding answer serves the joined asker");
    assert.equal(await second, ANSWER);
    assert.equal(mcp.accept(1, c, ANSWER), false, "both shots spent, the tap retired");
  });

  it("a spent shot is not spent again by its settled question's cap: pi's own answers stay swallowed (review round 4)", async () => {
    const e = env();
    const mcp = new McpQueries(e);
    const c = child();
    const first = mcp.ask(1, c, 60_000, 50);
    assert.equal(mcp.accept(1, c, PENDING), true, "the queued-list answer settles the first asker early");
    assert.equal(await first, "mealie: connecting (direct)");
    const second = mcp.ask(1, c, 60_000, 120_000);
    assert.equal(mcp.accept(1, c, ANSWER), true, "pi's first real answer spends only the first shot and serves the joined asker");
    assert.equal(await second, ANSWER);
    await new Promise((r) => setTimeout(r, 80)); // the first ask's cap fires on its settled question
    assert.equal(mcp.accept(1, c, ANSWER), true, "pi's second answer is still the tap's: no shot was spent twice");
    assert.equal(mcp.accept(1, c, ANSWER), false, "its own shot spent, the tap retired");
  });

  it("a prompt error spends the shot once, even though its cap fires later on the settled question (review round 4)", async () => {
    const mcp = new McpQueries(
      env({
        prompt: async () => {
          throw new Error("prompt refused");
        },
      }),
    );
    const c = child();
    const first = mcp.ask(1, c, 60_000, 40);
    await assert.rejects(first, /prompt refused/);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(mcp.accept(1, c, ANSWER), false, "the tap retired with the shot spent once; no second spend from the cap");
  });

  it("a dropped question's grace is cleared: the stopped child is never asked the pending command (review round 2)", async () => {
    const asked: string[] = [];
    const gated: RpcClient[] = [];
    const mcp = new McpQueries(
      env({
        prompt: async (_child, text) => {
          asked.push(text);
        },
        hasPendingCommand: async (gatedChild) => {
          gated.push(gatedChild);
          return true;
        },
      }),
    );
    const doomed = mcp.ask(1, child(), 5, 120_000);
    mcp.drop(1);
    await assert.rejects(doomed, /the child went away/);
    const late = mcp.ask(1, child(), 120_000, 120_000);
    await new Promise((r) => setTimeout(r, 40)); // past the stopped question's grace
    assert.deepEqual(gated, [], "the dropped question's grace never ran its gate against the stopped child");
    assert.deepEqual(asked.filter((t) => t !== "/mcp"), [], "and it never sent the pending command either");
    mcp.drop(1);
    await assert.rejects(late, /the child went away/);
  });

  it("a tap made for one child never takes a replaced child's notice", async () => {
    const e = env();
    const mcp = new McpQueries(e);
    const first = mcp.ask(1, child(), 60_000, 120_000);
    assert.equal(mcp.accept(1, child(), ANSWER), false, "the replacement's notices (another child object) pass");
    mcp.drop(1);
    await assert.rejects(first, /the child went away/);
  });

  it("drop settles an in-flight ask and clears the tap, so a question after is fresh", async () => {
    const e = env();
    const mcp = new McpQueries(e);
    const first = mcp.ask(1, child(), 60_000, 120_000);
    mcp.drop(1);
    const settled = assert.rejects(first, /the child went away/); // the handler goes on before anything awaits
    const late = mcp.ask(1, child(), 60_000, 120_000);
    assert.equal(mcp.shared(1), late);
    assert.deepEqual(e.prompts, ["/mcp", "/mcp"], "the new child was asked anew, not the dropped question resumed");
    mcp.drop(1);
    await settled;
    await assert.rejects(late, /the child went away/);
    mcp.drop(1); // idempotent
  });

  it("the cap ends the wait with its honest error and closes the tap", async () => {
    const mcp = new McpQueries(env());
    const c = child();
    const ask = mcp.ask(1, c, 60_000, 10);
    await assert.rejects(ask, /no answer from \/mcp yet \(cap\)/);
    assert.equal(mcp.shared(1), undefined);
    assert.equal(mcp.accept(1, c, ANSWER), false);
  });

  it("a failed /mcp prompt takes the whole question down, with its tap", async () => {
    const mcp = new McpQueries(
      env({
        prompt: async () => {
          throw new Error("prompt refused");
        },
      }),
    );
    const ask = mcp.ask(1, child(), 60_000, 120_000);
    await assert.rejects(ask, /prompt refused/);
    assert.equal(mcp.shared(1), undefined);
    mcp.drop(1); // nothing armed is left behind
  });

  it("the grace asks the pending command only through the extension gate, and never after the pending answer", async () => {
    const asked: string[] = [];
    const mcp = new McpQueries(
      env({
        hasPendingCommand: async () => false,
        prompt: async (_child, text) => {
          asked.push(text);
        },
      }),
    );
    const c = child();
    const ask = mcp.ask(1, c, 5, 120_000);
    mcp.accept(1, c, PENDING);
    assert.equal(await ask, "mealie: connecting (direct)");
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(asked.filter((t) => t !== "/mcp"), [], "no pending command for a child whose command list lacks it, and never after the pending answer");
  });

  it("the gate's yes sends the pending command once at the grace", async () => {
    const asked: string[] = [];
    const mcp = new McpQueries(
      env({
        prompt: async (_child, text) => {
          asked.push(text);
        },
      }),
    );
    const ask = mcp.ask(1, child(), 5, 120_000);
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(asked.filter((t) => t !== "/mcp"), ["/toriel-mcp-pending"]);
    mcp.drop(1);
    await assert.rejects(ask, /the child went away/);
  });
});
