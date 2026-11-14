import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_USAGE_PAUSE } from "../src/daemon-schedule.ts";
import { DEFAULT_GRANT_DURATIONS } from "../src/dialogs.ts";
import { DEFAULT_GRANT_LIMITS } from "../src/permissions.ts";
import { DEFAULT_LIMITS } from "../src/scheduler.ts";
import { DEFAULT_SANDBOX_WRITABLE, DEFAULT_TRASH_RETENTION_DAYS, loadSettings, resolveChildConfig, SETTING_KEYS, type TorielSettings } from "../src/settings.ts";
import { convertLegacySettings, ensureSettingsFile, renderSettings, SETTINGS_TEMPLATE, templateDefaults, updateSettings } from "../src/settings-file.ts";
import { DEFAULT_KEEP_MS, DEFAULT_SUBAGENT_LIMITS, HARD_MAX_DEPTH, subagentKeepMs, subagentLimitsFrom } from "../src/subagents.ts";
import { DEFAULT_INTERVAL_MINUTES, DEFAULT_MIN_NEW_MESSAGES, DEFAULT_SUMMARY_MODEL } from "../src/summarize.ts";

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "toriel-sf-"));
const write = (text: string) => {
  const file = path.join(dir(), "settings.yaml");
  fs.writeFileSync(file, text);
  return file;
};

describe("the settings template", () => {
  it("covers every key the loader accepts, and nothing else", () => {
    const keys = SETTINGS_TEMPLATE.flatMap((g) => g.entries.map((e) => e.key));
    assert.equal(new Set(keys).size, keys.length, "no key twice");
    assert.deepEqual([...keys].sort(), [...SETTING_KEYS].sort());
  });

  it("parses without a problem, and says what each key does", () => {
    const text = renderSettings();
    const loaded = loadSettings(write(text));
    assert.deepEqual(loaded.problems, []);
    const lines = text.split("\n");
    for (const { key } of SETTINGS_TEMPLATE.flatMap((g) => g.entries)) {
      const at = lines.findIndex((l) => l.startsWith(`${key}:`) || l.startsWith(`# ${key}:`));
      assert.ok(at > 0, `${key} is in the file`);
      assert.match(lines[at - 1] ?? "", /^# /, `${key} has a comment above it`);
    }
  });

  it("has nothing in effect until a line is uncommented: absent means the code's current default", () => {
    const loaded = loadSettings(write(renderSettings()));
    assert.deepEqual(loaded, { settings: {}, problems: [] });
    assert.match(renderSettings(), /^# summaryModel: "litellm\/local-model"$/m);
    assert.doesNotMatch(renderSettings(), /^[a-zA-Z]/m, "every setting line is commented");
  });

  it("shows the defaults the code uses, so uncommenting every line changes nothing", () => {
    const text = renderSettings();
    const withDefault = Object.keys(templateDefaults());
    const uncommented = text.split("\n").map((l) => (withDefault.some((k) => l.startsWith(`# ${k}: `)) ? l.slice(2) : l)).join("\n");
    const s = loadSettings(write(uncommented)).settings;
    const expected: TorielSettings = {
      steeringMode: "all",
      summaryModel: DEFAULT_SUMMARY_MODEL,
      summaryIntervalMinutes: DEFAULT_INTERVAL_MINUTES,
      summaryMinNewMessages: DEFAULT_MIN_NEW_MESSAGES,
      autoName: true,
      preventSleep: true,
      showExternalSessions: false,
      trashRetentionDays: DEFAULT_TRASH_RETENTION_DAYS,
      scheduleUsagePause: DEFAULT_USAGE_PAUSE,
      scheduleDailyLimit: DEFAULT_LIMITS.dailyFires,
      subagentMaxConcurrent: DEFAULT_SUBAGENT_LIMITS.maxConcurrent,
      subagentMaxDepth: DEFAULT_SUBAGENT_LIMITS.maxDepth,
      subagentMaxSpawns: DEFAULT_SUBAGENT_LIMITS.maxSpawnsPerParent,
      subagentBudgetTokens: DEFAULT_SUBAGENT_LIMITS.budget,
      subagentKeepMinutes: DEFAULT_KEEP_MS / 60_000,
      subagentIdleMinutes: DEFAULT_SUBAGENT_LIMITS.idleMs / 60_000,
      subagentMaxMinutes: DEFAULT_SUBAGENT_LIMITS.maxMs / 60_000,
      warnNoPermissionSystem: true,
      permissionGrantLimit: DEFAULT_GRANT_LIMITS.perSession,
      permissionGrantDurations: [...DEFAULT_GRANT_DURATIONS],
      sandbox: "off",
      sandboxWritable: [...DEFAULT_SANDBOX_WRITABLE],
    };
    assert.deepEqual(s, expected);
    assert.deepEqual(resolveChildConfig(s, {}), resolveChildConfig({}, {}), "the child's model, steering and cli come out the same");
    assert.deepEqual(subagentLimitsFrom(s), DEFAULT_SUBAGENT_LIMITS);
    assert.equal(subagentKeepMs(s, undefined), DEFAULT_KEEP_MS);
  });

  it("shows the keys with no fixed default as commented examples", () => {
    const text = renderSettings();
    assert.match(text, /^# model: /m);
    assert.match(text, /^# scopeGuardAcceptedAllows: /m);
    assert.deepEqual(Object.keys(loadSettings(write(renderSettings(templateDefaults()))).settings).filter((k) => ["provider", "model", "thinking", "piCli", "scopeGuardAcceptedAllows"].includes(k)), []);
  });
});

describe("ensureSettingsFile", () => {
  it("creates the file in a fresh config directory, once", () => {
    const env = { XDG_CONFIG_HOME: dir() };
    const made = ensureSettingsFile(env);
    assert.equal(made, path.join(env.XDG_CONFIG_HOME, "toriel", "settings.yaml"));
    assert.equal(fs.readFileSync(made as string, "utf8"), renderSettings());
    fs.appendFileSync(made as string, "model: mine\n");
    assert.equal(ensureSettingsFile(env), undefined, "the second run does nothing");
    assert.match(fs.readFileSync(made as string, "utf8"), /model: mine\n$/, "and leaves the edit alone");
  });

  it("never writes beside an old settings.json, or over a file TORIEL_SETTINGS names", () => {
    const base = dir();
    fs.mkdirSync(path.join(base, "toriel"));
    fs.writeFileSync(path.join(base, "toriel", "settings.json"), "{}");
    assert.equal(ensureSettingsFile({ XDG_CONFIG_HOME: base }), undefined);
    assert.equal(fs.existsSync(path.join(base, "toriel", "settings.yaml")), false);
    const named = write("model: x\n");
    assert.equal(ensureSettingsFile({ TORIEL_SETTINGS: named }), undefined);
    assert.equal(fs.readFileSync(named, "utf8"), "model: x\n");
  });

  it("creates the file at the path TORIEL_SETTINGS names when nothing is there", () => {
    const named = path.join(dir(), "sub", "mine.yaml");
    assert.equal(ensureSettingsFile({ TORIEL_SETTINGS: named }), named);
    assert.ok(fs.existsSync(named));
  });
});

describe("convertLegacySettings", () => {
  it("keeps every value in the commented template, and keeps keys it does not know", () => {
    const old = JSON.stringify({ model: "m1", steeringMode: "one-at-a-time", sandboxWritable: ["~/x"], scopeGuardAcceptedAllows: [{ surface: "*", pattern: "/tmp/*" }], futureKey: { a: 1 } }, null, 2);
    const text = convertLegacySettings(old);
    const loaded = loadSettings(write(text));
    assert.equal(loaded.settings.model, "m1");
    assert.equal(loaded.settings.steeringMode, "one-at-a-time");
    assert.deepEqual(loaded.settings.sandboxWritable, ["~/x"]);
    assert.deepEqual(loaded.settings.scopeGuardAcceptedAllows, [{ surface: "*", pattern: "/tmp/*" }]);
    assert.deepEqual(loaded.problems, ['unknown setting "futureKey"'], "an unknown key survives, and is still reported");
    assert.match(text, /^# Model new sessions use/m, "the comments came with it");
    assert.match(text, /^futureKey:/m);
  });

  it("writes only what the person set as active lines; every default stays commented", () => {
    const text = convertLegacySettings('{"model":"m1","sandbox":"bwrap"}');
    const active = text.split("\n").filter((l) => /^[a-zA-Z]/.test(l));
    assert.deepEqual(active, ['model: "m1"', 'sandbox: "bwrap"']);
    assert.match(text, /^# steeringMode: "all"$/m);
    assert.equal(loadSettings(write(text)).settings.steeringMode, undefined, "so a default that changes later still reaches this file");
  });

  it("refuses text it cannot read, so the old file is left alone", () => {
    assert.throws(() => convertLegacySettings("{ not json"));
    assert.throws(() => convertLegacySettings("[1, 2]"), /not a JSON object/);
  });
});

describe("updateSettings", () => {
  it("changes and removes keys without losing the comments around them", () => {
    const file = write("# my notes on this host\nmodel: a  # the cheap one\n\n# keep this\nthinking: low\n");
    updateSettings(file, { model: "b", provider: "p", thinking: undefined });
    const text = fs.readFileSync(file, "utf8");
    assert.match(text, /# my notes on this host/);
    assert.match(text, /model: b\s+# the cheap one/);
    assert.match(text, /provider: p/);
    assert.doesNotMatch(text, /thinking/);
    assert.deepEqual(loadSettings(file).settings, { model: "b", provider: "p" });
  });

  it("keeps the comments of the generated file through an edit", () => {
    const file = write(renderSettings());
    updateSettings(file, { summaryIntervalMinutes: 15, scopeGuardAcceptedAllows: [{ surface: "*", pattern: "/tmp/*" }] });
    const text = fs.readFileSync(file, "utf8");
    assert.match(text, /^# Re-summarize changed sessions this often/m);
    assert.match(text, /^# Subagents$/m);
    assert.match(text, /^summaryIntervalMinutes: 15$/m);
    const loaded = loadSettings(file);
    assert.deepEqual(loaded.problems, []);
    assert.equal(loaded.settings.summaryIntervalMinutes, 15);
    assert.deepEqual(loaded.settings.scopeGuardAcceptedAllows, [{ surface: "*", pattern: "/tmp/*" }]);
  });

  it("creates the file when there is none, and refuses one it cannot read", () => {
    const file = path.join(dir(), "new.yaml");
    updateSettings(file, { model: "m" });
    assert.deepEqual(loadSettings(file).settings, { model: "m" });
    assert.throws(() => updateSettings(write("model: [unclosed\n"), { model: "x" }));
  });
});

describe("subagent settings", () => {
  it("apply to the limits, with the depth held to the hard maximum", () => {
    const limits = subagentLimitsFrom({ subagentMaxConcurrent: 6, subagentMaxDepth: 9, subagentMaxSpawns: 50, subagentBudgetTokens: 1000 });
    assert.deepEqual(limits, { maxConcurrent: 6, maxDepth: HARD_MAX_DEPTH, maxSpawnsPerParent: 50, budget: 1000, idleMs: DEFAULT_SUBAGENT_LIMITS.idleMs, maxMs: 0 });
    assert.deepEqual(subagentLimitsFrom({}), DEFAULT_SUBAGENT_LIMITS);
  });

  it("take the keep time from the settings, and from the environment first when it is valid", () => {
    assert.equal(subagentKeepMs({ subagentKeepMinutes: 5 }, undefined), 300_000);
    assert.equal(subagentKeepMs({ subagentKeepMinutes: 0 }, undefined), 0);
    assert.equal(subagentKeepMs({ subagentKeepMinutes: 5 }, "1500"), 1500);
    assert.equal(subagentKeepMs({ subagentKeepMinutes: 5 }, "junk"), 300_000);
    assert.equal(subagentKeepMs({}, undefined), DEFAULT_KEEP_MS);
  });
});
