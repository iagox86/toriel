import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { Host } from "../src/host.ts";
// NOTE: deliberately does NOT import controller.ts - it runs main() on import
// (launching the live TUI), so nothing under test may come from there.
import { performanceReviewName, performanceReviewSeed, SessionCommands } from "../src/session-commands.ts";

// Auto-save goes under the XDG data home; aim it at a temp dir so the test
// never writes into the real performance reports.
const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), "performance-review-test-"));
process.env.XDG_DATA_HOME = dataHome;

const KEY = "/tmp/fake/session.jsonl";
const REPORT = "finding one\nfinding two";
const reportDir = () => path.join(dataHome, "toriel", "performance");
const clearReports = () => fs.rmSync(reportDir(), { recursive: true, force: true });

function fakeHost(open: (cwd: string, name: string) => Promise<{ name: string; uuid?: string }>) {
  const notices: string[] = [];
  const panels: string[] = [];
  const sent: Array<{ type: string; to?: string; text?: string }> = [];
  const host = {
    viewing: KEY,
    editor: { setText: () => {} },
    tui: { requestRender: () => {} },
    notify: (m: string) => void notices.push(m),
    metaForPath: () => ({ id: 7, active: true, model: "fake/model", cwd: "/work" }),
    cwdFor: () => "/work",
    infoPanel: { show: (text: string) => void panels.push(text) },
    copyText: async () => true,
    openReviewSession: open,
    request: async (cmd: { type: string; to?: string; text?: string }) => {
      sent.push(cmd);
      return {};
    },
  };
  return { host: host as unknown as Host, notices, panels, sent };
}

const fakeRunPerf = async () => ({ answer: REPORT, truncated: false });
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("performanceReviewName", () => {
  it("is `performance review <YYYY-MM-DD HH:MM>` in local time, zero-padded", () => {
    assert.equal(performanceReviewName(new Date(2026, 1, 4, 5, 6)), "performance review 2026-02-04 05:06");
  });
});

describe("performanceReviewSeed", () => {
  it("frames the session as waiting for the report", () => {
    const seed = performanceReviewSeed();
    assert.match(seed, /Performance review/);
    assert.match(seed, /starting context/);
    assert.match(seed, /will be delivered to this session as a message/);
  });
});

describe("/performance review session", () => {
  it("opens the review session BEFORE the analysis and delivers the report to it as a message", async () => {
    clearReports();
    const calls: Array<{ cwd: string; name: string }> = [];
    const { host, notices, panels, sent } = fakeHost(async (cwd, name) => {
      calls.push({ cwd, name });
      return { name, uuid: "uuid-1" };
    });
    new SessionCommands(host, fakeRunPerf).run("/performance");
    await settle();

    // the session opens at command time (no waiting for the analysis)
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.cwd, "/work");
    assert.match(calls[0]?.name ?? "", /^performance review \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    assert.ok(notices.some((n) => n.startsWith(`performance: review session - ${calls[0]?.name}`)), `notices: ${JSON.stringify(notices)}`);
    // the report reaches the session as a message, and is auto-saved either way
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.type, "message");
    assert.equal(sent[0]?.to, "uuid-1");
    assert.ok(sent[0]?.text?.includes(REPORT), "the report must survive verbatim in the delivery");
    assert.ok(notices.some((n) => n.includes("saved to")), `notices: ${JSON.stringify(notices)}`);
    // no panel: the review session is the report's home
    assert.equal(panels.length, 0);
    const dir = reportDir();
    assert.equal(fs.readdirSync(dir).length, 1);
    assert.match(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0] ?? ""), "utf8"), new RegExp(`^# performance review\\n\\n${REPORT.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}$`, "m"));
  });

  it("still analyzes and saves when opening the review session fails", async () => {
    clearReports();
    const { host, notices, panels, sent } = fakeHost(async () => {
      throw new Error("no daemon");
    });
    new SessionCommands(host, fakeRunPerf).run("/performance");
    await settle();

    const creation = notices.find((n) => n.startsWith("performance: review session"));
    assert.match(creation ?? "", /review session not created: no daemon/);
    assert.ok(notices.some((n) => n.includes("saved to") && n.includes("report")), `notices: ${JSON.stringify(notices)}`);
    assert.equal(sent.length, 0, "nothing is delivered when no session exists");
    assert.equal(panels.length, 0);
    assert.equal(fs.readdirSync(reportDir()).length, 1);
  });

  it("falls back to the saved file when delivery fails", async () => {
    clearReports();
    const { host: broken, notices } = fakeHost(async (_cwd, name) => ({ name, uuid: "uuid-2" }));
    // request() rejects: simulate the review session dying before delivery
    (broken as unknown as { request: () => Promise<never> }).request = async () => {
      throw new Error("session gone");
    };
    new SessionCommands(broken, fakeRunPerf).run("/performance");
    await settle();

    const delivery = notices.find((n) => n.includes("not delivered"));
    assert.match(delivery ?? "", /session gone/);
    assert.ok(delivery?.includes("saved to") ?? false, "the notice must point at the saved report");
  });
});
