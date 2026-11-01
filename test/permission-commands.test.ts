import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCommandLine } from "../src/cli.ts";
import { SESSION_COMMANDS, SWITCHER_COMMANDS } from "../src/commands.ts";
import type { Host } from "../src/host.ts";
import { durationWords, grantChoice, grantLabel, grantListing } from "../src/permission-format.ts";
import { permissionCompletions, runPermissions } from "../src/permission-commands.ts";
import type { GrantView } from "../src/shared.ts";

const NOW = new Date(2026, 10, 1, 12, 0, 0);
const grant = (over: Partial<GrantView> = {}): GrantView => ({ id: 3, session: "11111111-2222-3333-4444-555555555555", surface: "bash", pattern: "git status", createdAt: NOW.getTime(), expiresAt: NOW.getTime() + 52 * 60_000, source: "command", dormant: false, ...over });

function fakeHost(grants: GrantView[] = []) {
  const requests: Array<Record<string, unknown>> = [];
  const notices: string[] = [];
  const panels: Array<{ title: string; choices: string[]; pick: (c: string) => void }> = [];
  const info: string[] = [];
  const host = {
    notify: (m: string) => void notices.push(m),
    tui: { requestRender: () => {} },
    infoPanel: { show: (t: string) => void info.push(t) },
    choicePanel: { open: (title: string, choices: string[], _current: unknown, pick: (c: string) => void) => void panels.push({ title, choices, pick }) },
    request: async (cmd: Record<string, unknown>) => {
      requests.push(cmd);
      if (cmd.type === "permission_list") {
        return { grants };
      }
      if (cmd.type === "permission_add") {
        return { echo: `granted ${cmd.surface} "${cmd.pattern}"` };
      }
      if (cmd.type === "permission_restore") {
        return { count: grants.length };
      }
      return { grants: grants.filter((g) => String(g.id) === cmd.ref || cmd.all), count: grants.filter((g) => String(g.id) === cmd.ref || cmd.all).length };
    },
  };
  return { host: host as unknown as Host, requests, notices, panels, info };
}

const parse = (line: string, scope: "session" | "switcher" = "session") => {
  const r = parseCommandLine(scope === "session" ? SESSION_COMMANDS : SWITCHER_COMMANDS, line);
  assert.equal(r.kind, "run", JSON.stringify(r));
  return (r as Extract<typeof r, { kind: "run" }>).call;
};
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("/permissions parsing", () => {
  it("reads the action, the words after it and the options, in any order", () => {
    const c = parse('/permissions add bash "git status *" --for 1h --note "why not"');
    assert.deepEqual(c.args, ["add", "bash", "git status *"]);
    assert.equal(c.opts.for, "1h");
    assert.equal(c.opts.note, "why not");
    assert.deepEqual(parse("/permissions --for 30m add mcp exa:*").args, ["add", "mcp", "exa:*"]);
    assert.deepEqual(parse("/permissions").args, []);
    assert.equal(parse("/permissions revoke --all").opts.all, true);
  });

  it("has --help text in both places, and the switcher does not offer add's flags", () => {
    for (const scope of ["session", "switcher"] as const) {
      const r = parseCommandLine(scope === "session" ? SESSION_COMMANDS : SWITCHER_COMMANDS, "/permissions --help");
      assert.equal(r.kind, "help");
      assert.match((r as { text: string }).text, /Actions:[\s\S]*revoke[\s\S]*restore/);
    }
    assert.equal(parseCommandLine(SWITCHER_COMMANDS, "/permissions add bash x --for 1h").kind, "error");
  });
});

describe("/permissions completion", () => {
  it("completes the action, then the surface after add, then the lifetime after --for", () => {
    assert.deepEqual(permissionCompletions("").map((c) => (typeof c === "string" ? c : c.value)), ["list", "add", "revoke", "restore"]);
    assert.deepEqual(permissionCompletions("re").map((c) => (typeof c === "string" ? c : c.value)), ["revoke", "restore"]);
    assert.deepEqual(permissionCompletions("add b").map((c) => (typeof c === "string" ? c : c.value)), ["add bash"]);
    assert.deepEqual(permissionCompletions("add bash git --for ").map((c) => (typeof c === "string" ? c : c.value)), ["add bash git --for 30m", "add bash git --for 1h", "add bash git --for 8h", "add bash git --for session"]);
    assert.deepEqual(permissionCompletions("add bash git --for 3").map((c) => (typeof c === "string" ? c : c.value)), ["add bash git --for 30m"]);
    assert.deepEqual(permissionCompletions("add bash git"), []);
  });
});

describe("/permissions actions", () => {
  it("adds a grant to the viewed session with the lifetime and note, and shows the daemon's echo", async () => {
    const f = fakeHost();
    await runPermissions(f.host, parse('/permissions add bash "git status" --for 1h --note ci'), 7);
    assert.deepEqual(f.requests, [{ type: "permission_add", session: 7, surface: "bash", pattern: "git status", for: "1h", note: "ci", source: "command" }]);
    assert.deepEqual(f.notices, ['granted bash "git status"']);
  });

  it("treats --session as no expiry, and joins an unquoted pattern", async () => {
    const f = fakeHost();
    await runPermissions(f.host, parse("/permissions add bash git status --session"), 7);
    assert.equal(f.requests[0]?.for, "session");
    assert.equal(f.requests[0]?.pattern, "git status");
  });

  it("explains missing pieces instead of asking the daemon", async () => {
    const f = fakeHost();
    await runPermissions(f.host, parse("/permissions add bash"), 7);
    await runPermissions(f.host, parse("/permissions add bash x --for 1h --session"), 7);
    await runPermissions(f.host, parse('/permissions add bash "x"', "session"), undefined);
    await runPermissions(f.host, parse("/permissions restore"), undefined);
    await runPermissions(f.host, parse("/permissions frobnicate"), 7);
    assert.equal(f.requests.length, 0);
    assert.match(f.notices[0] ?? "", /needs a surface and a pattern/);
    assert.match(f.notices[1] ?? "", /not both/);
    assert.match(f.notices[2] ?? "", /open the session first/);
    assert.match(f.notices[3] ?? "", /open the session first/);
    assert.match(f.notices[4] ?? "", /"frobnicate" is not an action/);
  });

  it("lists this session's grants, or every session's with --all or from the switcher", async () => {
    const f = fakeHost([grant()]);
    await runPermissions(f.host, parse("/permissions"), 7);
    await runPermissions(f.host, parse("/permissions list --all"), 7);
    await runPermissions(f.host, parse("/permissions", "switcher"), undefined);
    assert.deepEqual(f.requests.map((r) => r.session), [7, undefined, undefined]);
    assert.equal(f.info.length, 3);
    assert.match(f.info[0] ?? "", /#3 bash "git status" \| expires/);
  });

  it("says what to do when there is nothing to list", async () => {
    const f = fakeHost([]);
    await runPermissions(f.host, parse("/permissions"), 7);
    assert.match(f.notices[0] ?? "", /no permission grants in this session.*allow for 1 hour/);
  });

  it("revokes by id or pattern, or everything with --all", async () => {
    const f = fakeHost([grant()]);
    await runPermissions(f.host, parse("/permissions revoke 3"), 7);
    await runPermissions(f.host, parse("/permissions revoke --all"), 7);
    assert.deepEqual(f.requests.map((r) => [r.type, r.ref, r.all]), [["permission_revoke", "3", false], ["permission_revoke", undefined, true]]);
    assert.match(f.notices[0] ?? "", /^revoked #3 bash "git status"/);
  });

  it("opens a pick list when revoke names nothing, and revokes the one picked", async () => {
    const f = fakeHost([grant(), grant({ id: 4, pattern: "ls", dormant: true })]);
    await runPermissions(f.host, parse("/permissions revoke"), undefined);
    assert.equal(f.panels.length, 1);
    assert.match(f.panels[0]?.choices[0] ?? "", /^#3 bash "git status" - expires .* \[11111111\]$/);
    assert.match(f.panels[0]?.choices[1] ?? "", /saved, not active/);
    f.panels[0]?.pick(f.panels[0].choices[1] as string);
    await settle();
    assert.deepEqual(f.requests.at(-1), { type: "permission_revoke", ref: "4", all: false, session: undefined });
  });

  it("restores saved grants in the viewed session and says how many", async () => {
    const f = fakeHost([grant({ dormant: true }), grant({ id: 4, dormant: true })]);
    await runPermissions(f.host, parse("/permissions restore"), 7);
    assert.deepEqual(f.requests, [{ type: "permission_restore", session: 7 }]);
    assert.match(f.notices[0] ?? "", /turned on 2 saved grants/);
  });

  it("reports the daemon's refusal as a notice instead of throwing", async () => {
    const f = fakeHost();
    (f.host as unknown as { request: () => Promise<never> }).request = async () => {
      throw new Error("pi does not let a grant cover file-path requests");
    };
    await runPermissions(f.host, parse("/permissions add path_write /tmp/x"), 7);
    assert.match(f.notices[0] ?? "", /\/permissions add: pi does not let a grant cover file-path/);
  });
});

describe("grant formatting", () => {
  it("labels and describes grants, marking saved and permanent ones", () => {
    assert.equal(grantLabel(grant()), '#3 bash "git status"');
    assert.match(grantChoice(grant(), NOW, false), /^#3 bash "git status" - expires 12:52 \(in 52m\)$/);
    assert.match(grantChoice(grant({ expiresAt: null }), NOW, false), /until revoked$/);
    assert.match(grantChoice(grant({ dormant: true, sessionName: "Mealie" }), NOW, true), /saved, not active \[Mealie\]$/);
  });

  it("lists with sessions when asked, notes the saved ones and what the list leaves out", () => {
    const text = grantListing([grant({ source: "dialog", note: "ci run", sessionName: "Mealie" }), grant({ id: 4, dormant: true })], NOW, true);
    assert.match(text, /#3 bash "git status" \| expires 12:52 \(in 52m\) \| from a permission prompt/);
    assert.match(text, /session: Mealie/);
    assert.match(text, /ci run/);
    assert.match(text, /SAVED, NOT ACTIVE/);
    assert.match(text, /1 saved grant is inactive/);
    assert.match(text, /Not listed: answers given to pi's own/);
  });

  it("reads a duration in words", () => {
    assert.equal(durationWords("1h"), "1 hour");
    assert.equal(durationWords("8h"), "8 hours");
    assert.equal(durationWords("30m"), "30 minutes");
    assert.equal(durationWords("2d"), "2 days");
    assert.equal(durationWords("1h30m"), "1h30m");
  });
});
