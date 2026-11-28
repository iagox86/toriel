// Regression test for #58: the fork-confirm flow must send exactly one daemon
// request per enter. It once sent a third, duplicate prompt (the leftover
// unconditional request after the confirmed one), delivering the message twice.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Host } from "../src/host.ts";
import { SessionActions } from "../src/session-actions.ts";

const KEY = "/tmp/fake/session.jsonl";

function fakeHost(responses: unknown[]) {
  const requests: Array<Record<string, unknown>> = [];
  const notices: string[] = [];
  const history: string[] = [];
  const sequence: string[] = [];
  let editorText = "";
  const host = {
    viewing: KEY,
    editor: {
      getText: () => editorText,
      setText: (t: string) => {
        editorText = t;
      },
      addToHistory: (t: string) => {
        history.push(t);
      },
    },
    local: new Map([[KEY, { cwd: "/tmp/fake" }]]),
    attachments: {
      take: (text: string) => ({ text, images: [] as string[] }),
      put: (image: string) => image,
    },
    notify: (message: string) => {
      notices.push(message);
    },
    echoPrompt: () => {
      sequence.push("echo");
    },
    dropEcho: () => {
      sequence.push("drop");
    },
    metaForPath: () => undefined,
    request: (cmd: Record<string, unknown>) => {
      sequence.push("request");
      requests.push(cmd);
      return Promise.resolve(responses.shift());
    },
  };
  return { host: host as unknown as Host, requests, notices, history, sequence, editorText: () => editorText };
}

describe("prompt fork-confirm flow", () => {
  it("sends exactly one daemon request per enter", async () => {
    const fh = fakeHost([{ confirmFork: true, ageMs: 5000 }, {}]);
    const sa = new SessionActions(fh.host);

    // first enter: refused by the daemon (fork risk), request armed, text kept
    await sa.prompt("hello there");
    assert.equal(fh.requests.length, 1);
    assert.equal(fh.requests[0].confirmFork, false);
    assert.equal(sa.armedFork, KEY);
    assert.equal(fh.editorText(), "hello there");
    assert.match(fh.notices[0], /enter again to continue here/);
    // the echo precedes the request and is retracted on the refusal -
    // a late echo races pi's own user message and renders the text twice
    assert.deepEqual(fh.sequence.slice(0, 3), ["echo", "request", "drop"]);

    // second enter: confirmed - and it must not fire a follow-up duplicate
    await sa.prompt("hello there");
    assert.equal(fh.requests.length, 2, "second enter must not produce a third request");
    assert.equal(fh.requests[1].confirmFork, true);
    assert.equal(sa.armedFork, null);
    assert.deepEqual(fh.history, ["hello there"]);
    // echo again before the request; no retraction (the delivery happened)
    assert.deepEqual(fh.sequence.slice(3), ["echo", "request"]);
  });

  it("re-sends the armed command when the fork-confirming enter repeats the generated prompt (ticket 302)", async () => {
    const fh = fakeHost([{ confirmFork: true, ageMs: 5000 }, {}]);
    const sa = new SessionActions(fh.host);
    assert.equal(await sa.prompt("Write the project's AGENTS.md", "/init"), false);
    assert.equal(fh.requests[0].command, "/init", "the first send is already a command prompt");
    assert.equal(fh.editorText(), "Write the project's AGENTS.md", "the confirmation keeps the text in the box");
    // the second enter re-sends what the editor holds; the command must come back from the armed record, so the
    // confirmed send is still a command prompt and not a plain prompt of the generated text
    assert.equal(await sa.prompt("Write the project's AGENTS.md"), true);
    assert.equal(fh.requests[1].confirmFork, true);
    assert.equal(fh.requests[1].command, "/init", "re-sent with the armed command, not as raw text");
    assert.equal(fh.requests[1].message, "Write the project's AGENTS.md");
    assert.deepEqual(fh.history, [], "a command prompt never enters the up-arrow history");
    assert.equal(sa.armedFork, null);
  });

  it("sends once and keeps the echo when enter is pressed again while the session is still starting", async () => {
    const fh = fakeHost([{}]);
    let release: (v: unknown) => void = () => {};
    const slow = new Promise((resolve) => {
      release = resolve;
    });
    const baseRequest = (fh.host as unknown as { request: (c: Record<string, unknown>) => Promise<unknown> }).request;
    (fh.host as unknown as { request: unknown }).request = (cmd: Record<string, unknown>) => {
      void baseRequest(cmd);
      return slow;
    };
    const sa = new SessionActions(fh.host);

    const first = sa.prompt("hello there");
    // same text again, then different text typed meanwhile, while the first request is unanswered
    assert.equal(await sa.prompt("hello there"), false);
    assert.equal(await sa.prompt("something else"), false);
    assert.equal(fh.requests.length, 1, "only the first enter reaches the daemon");
    assert.ok(!fh.sequence.includes("drop"), "the first send's echo is not retracted");
    assert.equal(fh.editorText(), "something else", "text typed meanwhile is kept, not sent");

    release({});
    assert.equal(await first, true);
    // once answered, the next prompt goes through
    assert.equal(await sa.prompt("next"), true);
    assert.equal(fh.requests.length, 2);
  });
});

describe("prompt to a session that was deleted while on screen", () => {
  const gone = (key: string) => {
    const fh = fakeHost([]);
    (fh.host as unknown as { viewing: string; local: Map<string, unknown> }).viewing = key;
    (fh.host as unknown as { local: Map<string, unknown> }).local = new Map();
    return fh;
  };

  it("says it was deleted and sends nothing when its file is gone and no listing knows it", async () => {
    const fh = gone("/tmp/toriel-swept-nonexistent/session.jsonl");
    assert.equal(await new SessionActions(fh.host).prompt("hello"), false);
    assert.deepEqual(fh.requests, []);
    assert.match(fh.notices.join(" "), /that session was deleted - \/restore brings it back from the trash/);
  });

  it("says the same for a session that only ever lived in the daemon", async () => {
    const fh = gone("daemon:7");
    await new SessionActions(fh.host).prompt("hello");
    assert.match(fh.notices.join(" "), /that session was deleted/);
    assert.deepEqual(fh.requests, []);
  });

  it("keeps the old message for a file that exists but is not listed", async () => {
    const fh = gone(import.meta.filename);
    await new SessionActions(fh.host).prompt("hello");
    assert.match(fh.notices.join(" "), /cannot start this session \(no session file\)/);
  });
});

describe("a prompt a command generated (ticket 302)", () => {
  it("is sent with its command, not echoed as typed text, and leaves the up-arrow history alone", async () => {
    const fh = fakeHost([{}]);
    const sa = new SessionActions(fh.host);
    assert.equal(await sa.prompt("Write a skill for the MCP server gdb ...", "/mcp explore gdb"), true);
    assert.equal(fh.requests.length, 1);
    assert.equal(fh.requests[0].command, "/mcp explore gdb");
    assert.equal(fh.requests[0].message, "Write a skill for the MCP server gdb ...");
    assert.deepEqual(fh.history, [], "the editor already recorded the command; the prompt never enters history");
    assert.ok(!fh.sequence.includes("echo"), "no user-message echo: the command prompt row comes from pi");
  });

  it("a failed command prompt leaves the editor alone and says to run the command again (ticket 302)", async () => {
    const fh = fakeHost([Promise.reject(new Error("session is compacting"))]);
    const sa = new SessionActions(fh.host);
    (fh.host as unknown as { editor: { setText: (t: string) => void } }).editor.setText("Write the project's AGENTS.md");
    assert.equal(await sa.prompt("Write the project's AGENTS.md", "/init"), false);
    assert.equal(fh.editorText(), "Write the project's AGENTS.md", "the generated prompt never goes back in the box as typed text");
    assert.deepEqual(fh.history, [], "and never into the up-arrow history either");
    assert.match(fh.notices.at(-1) ?? "", /the prompt \/init generated failed to send \(session is compacting\) - run \/init again/);
    assert.doesNotMatch(fh.notices.join(" "), /prompt failed:|^not sent/, "not the plain-prompt wording, and nothing was put back");
  });

  it("a failed plain prompt keeps the giveBack: an empty editor takes the text back, a typed-over one takes it in the history", async () => {
    const fh = fakeHost([Promise.reject(new Error("busy"))]);
    const sa = new SessionActions(fh.host);
    assert.equal(await sa.prompt("hello there"), false);
    assert.equal(fh.editorText(), "hello there", "the text is back in the empty box");
    assert.match(fh.notices.at(-1) ?? "", /^prompt failed: busy/);

    const typed = fakeHost([Promise.reject(new Error("busy"))]);
    const again = new SessionActions(typed.host);
    (typed.host as unknown as { editor: { setText: (t: string) => void } }).editor.setText("typed meanwhile");
    assert.equal(await again.prompt("hello there"), false);
    assert.equal(typed.editorText(), "typed meanwhile", "the editor keeps what was typed meanwhile");
    assert.deepEqual(typed.history, ["hello there"], "the unsent text goes to the up-arrow history instead");
    assert.match(typed.notices.at(-1) ?? "", /not sent - it is in the up-arrow history/);
  });
});

describe("the double-open block (review round 2)", () => {
  const doubleOpen = () => {
    const fh = fakeHost([]);
    (fh.host as unknown as { metaForPath: () => unknown }).metaForPath = () => ({ externallyLive: true, active: true });
    (fh.host as unknown as { editor: { setText: (t: string) => void } }).editor.setText("typed meanwhile");
    return fh;
  };

  it("a generated prompt never goes back in the box: it says to run the command again", async () => {
    const fh = doubleOpen();
    assert.equal(await new SessionActions(fh.host).prompt("Write the project's AGENTS.md", "/init"), false);
    assert.equal(fh.editorText(), "typed meanwhile", "the box keeps what was typed, never the generated prompt");
    assert.match(fh.notices.at(-1) ?? "", /open in both toriel and another pi - close one before prompting here \(run the command again\)/);
    assert.deepEqual(fh.requests, [], "nothing was sent");
  });

  it("a plain prompt is put back in the box for a re-send, as before", async () => {
    const fh = doubleOpen();
    assert.equal(await new SessionActions(fh.host).prompt("hello there"), false);
    assert.equal(fh.editorText(), "hello there", "the plain prompt stays for the close-then-resend");
    assert.match(fh.notices.at(-1) ?? "", /close one before prompting here$/);
    assert.deepEqual(fh.requests, []);
  });
});
