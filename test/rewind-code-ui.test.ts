// The rewind list and its question about the code (ticket 11): what the list shows under the highlighted message, and what each
// answer asks the daemon for.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { recordAfter, recordBefore } from "../pi/extensions/lib/file-history.ts";

const historyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-rwui-"));
process.env.TORIEL_FILE_HISTORY_DIR = historyRoot;
const { SessionActions } = await import("../src/session-actions.ts");
const { RewindPicker, codeLine, pickerLines } = await import("../src/rewind-picker.ts");
type Host = import("../src/host.ts").Host;

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const ENTER = "\r";

const AT = Date.parse("2026-11-15T10:00:00Z");
const msg = (id: string, role: string, text: string, ts: number) => ({ type: "message", id, timestamp: new Date(ts).toISOString(), message: { role, content: text, timestamp: 1 } });

/** A session file with two prompts (the second sent at AT) and, when `edited`, a journal that says the agent changed a file after it. */
function setup(edited: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-rwui-s-"));
  const file = path.join(dir, "s.jsonl");
  const id = `sess-${path.basename(dir)}`;
  const lines = [{ type: "session", version: 3, id, timestamp: new Date(AT - 9000).toISOString(), cwd: dir }, msg("a", "user", "first", AT - 5000), msg("b", "assistant", "ok", AT - 4000), msg("c", "user", "second", AT), msg("d", "assistant", "done", AT + 500)];
  fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  const target = path.join(dir, "code.txt");
  fs.writeFileSync(target, "1\n2\n3\n");
  if (edited) {
    const journal = path.join(historyRoot, id);
    recordBefore(journal, "k1", "edit", target, AT + 100);
    fs.writeFileSync(target, "1\nTWO\n3\n4\n");
    recordAfter(journal, "k1", target, AT + 101);
  }
  const requests: Array<Record<string, unknown>> = [];
  const notices: string[] = [];
  const questions: Array<{ title: string; choices: string[]; pick: (c: string) => void }> = [];
  const picker = new RewindPicker();
  const host = {
    viewing: file,
    views: new Map(),
    metaForPath: () => ({ id: 1, streaming: false }),
    reloadView: () => {},
    loadLocal: async () => {},
    editor: { setText: () => {} },
    notify: (m: string) => void notices.push(m),
    rewindPicker: picker,
    choicePanel: { open: (title: string, choices: string[], _cur: unknown, pick: (c: string) => void) => void questions.push({ title, choices, pick }) },
    request: async (cmd: Record<string, unknown>) => {
      requests.push(cmd);
      return cmd.type === "rewind" ? { text: "second", removed: 2, code: { restored: [target], left: [] } } : { code: { restored: [target], left: [] } };
    },
    tui: { requestRender() {} },
  };
  const actions = new SessionActions(host as unknown as Host);
  const open = () => (actions as unknown as { openRewind(): void }).openRewind();
  return { actions, open, picker, requests, notices, questions, target };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("the list under the highlighted message", () => {
  it("shows how many files the agent changed since it, and the lines", () => {
    const s = setup(true);
    s.open();
    const lines = pickerLines([], 0, 80, s.picker.codeOf());
    assert.match(strip(lines.join("\n")), /code since: 1 file changed \+2 -1/);
    assert.match(strip(codeLine({ files: 2, added: 5, removed: 0, leftAlone: 1 })), /2 files changed \+5 -0 \(1 more changed since or too big: left alone\)/);
  });

  it("shows nothing for a message nothing was changed after", () => {
    const s = setup(false);
    s.open();
    assert.equal(s.picker.codeOf(), undefined);
  });
});

describe("enter on a message", () => {
  it("with changed files asks what to undo, and the answer decides the request", async () => {
    const s = setup(true);
    s.open();
    s.actions.pickerKeys(ENTER);
    assert.equal(s.questions.length, 1);
    assert.deepEqual(s.questions[0]?.choices, ["Conversation and code", "Conversation only", "Code only", "Cancel"]);
    assert.match(s.questions[0]?.title ?? "", /also undo 1 file \(\+2 -1\)\?/);
    assert.deepEqual(s.requests, [], "nothing happens before the answer");

    s.questions[0]?.pick("Conversation and code");
    await settle();
    assert.deepEqual(s.requests.at(-1), { type: "rewind", session: 1, entryId: "c", code: true });
    assert.match(s.notices.at(-1) ?? "", /rewound - 2 entries moved to trash - 1 file put back/);

    s.questions[0]?.pick("Conversation only");
    await settle();
    assert.deepEqual(s.requests.at(-1), { type: "rewind", session: 1, entryId: "c" });

    s.questions[0]?.pick("Code only");
    await settle();
    assert.deepEqual(s.requests.at(-1), { type: "restore_code", session: 1, entryId: "c" });
    assert.match(s.notices.at(-1) ?? "", /code restored - 1 file put back \(the conversation is unchanged\)/);

    const count = s.requests.length;
    s.questions[0]?.pick("Cancel");
    await settle();
    assert.equal(s.requests.length, count, "cancel asks for nothing");
  });

  it("without changed files rewinds at once, as before", async () => {
    const s = setup(false);
    s.open();
    s.actions.pickerKeys(ENTER);
    await settle();
    assert.deepEqual(s.questions, []);
    assert.deepEqual(s.requests, [{ type: "rewind", session: 1, entryId: "c" }]);
  });

  it("names the files left alone, without their contents", async () => {
    const s = setup(true);
    s.open();
    fs.writeFileSync(s.target, "typed by hand\n");
    s.actions.pickerKeys(ENTER);
    const q = s.questions[0];
    assert.deepEqual(q?.choices, ["Conversation only", "Cancel"], "nothing can be put back, so only the conversation is offered");
    assert.match(q?.title ?? "", /also undo nothing: no changed file can be put back and 1 stays\?/);
  });
});
