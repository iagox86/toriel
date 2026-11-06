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

function fakeHost(open: (cwd: string, name: string, report: string) => Promise<string>) {
  const notices: string[] = [];
  const panels: string[] = [];
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
  };
  return { host: host as unknown as Host, notices, panels };
}

const fakeRunPerf = async () => ({ answer: REPORT, truncated: false });
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("performanceReviewName", () => {
  it("is `performance review <YYYY-MM-DD HH:MM>` in local time, zero-padded", () => {
    assert.equal(performanceReviewName(new Date(2026, 1, 4, 5, 6)), "performance review 2026-02-04 05:06");
  });
});

describe("performanceReviewSeed", () => {
  it("carries the full report and frames it as starting context", () => {
    const seed = performanceReviewSeed(REPORT);
    assert.ok(seed.includes(REPORT), "the report must survive verbatim");
    assert.match(seed, /Performance review/);
    assert.match(seed, /starting context/);
  });
});

describe("/performance review session", () => {
  it("opens the report as a review session in the session's cwd and keeps the panel", async () => {
    const calls: Array<{ cwd: string; name: string; report: string }> = [];
    const { host, notices, panels } = fakeHost(async (cwd, name, report) => {
      calls.push({ cwd, name, report });
      return name;
    });
    new SessionCommands(host, fakeRunPerf).run("/performance");
    await settle();

    assert.equal(calls.length, 1);
    assert.deepEqual([calls[0]?.cwd, calls[0]?.report], ["/work", REPORT]);
    assert.match(calls[0]?.name ?? "", /^performance review \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    assert.ok(notices.includes(`performance: review session created - ${calls[0]?.name ?? ""}`), `notices: ${JSON.stringify(notices)}`);
    // the panel is still shown, and the report is auto-saved to a file it names
    assert.equal(panels.length, 1);
    assert.match(panels[0] ?? "", /^performance: analysis of this session \(saved to .+performance-.+\.md\)/);
    assert.ok((panels[0] ?? "").includes(REPORT));
    const dir = path.join(dataHome, "toriel", "performance");
    assert.equal(fs.readdirSync(dir).length, 1);
    assert.match(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0] ?? ""), "utf8"), new RegExp(`^# performance review\\n\\n${REPORT.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\n$`));
  });

  it("keeps the report (panel + auto-save) when opening the review session fails", async () => {
    const { host, notices, panels } = fakeHost(async () => {
      throw new Error("no daemon");
    });
    new SessionCommands(host, fakeRunPerf).run("/performance");
    await settle();

    const creation = notices.find((n) => n.startsWith("performance: review session"));
    assert.match(creation ?? "", /review session not created: no daemon/);
    assert.ok(creation?.includes("saved to") ?? false, "the notice must point at the saved report");
    assert.equal(panels.length, 1);
    assert.ok((panels[0] ?? "").includes(REPORT));
  });
});
