import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ANSI_STYLE, applyFixes, CATALOG, collectFindings, type DoctorOptions, exitCode, KITTY_SHIFT_ENTER, lineDiff, plannedFixes, previewFixes, readKittyConfig, renderDoctor, runDoctor } from "../src/doctor.ts";
import { readMcpYaml } from "../src/mcp-config.ts";
import { loadSettings } from "../src/settings.ts";
import { renderSettings } from "../src/settings-file.ts";
import { GRANTS_RULE, setup as setupIn, tempHome } from "./doctor-fixture.ts";

let env: ReturnType<typeof tempHome>;
beforeEach(() => {
  env = tempHome();
});
afterEach(() => env.done());
const setup = (over: Parameters<typeof setupIn>[1] = {}) => setupIn(env.home, over);

/** A setup whose only toriel settings are an old settings.json in the XDG config directory (no explicit settings file). */
function legacySetup(json = '{"model":"m1","sandbox":"off","note":1}') {
  const s = setup({ noSettings: true });
  const config = path.join(env.home, "xdg");
  fs.mkdirSync(path.join(config, "toriel"), { recursive: true });
  fs.writeFileSync(path.join(config, "toriel", "settings.json"), json);
  const { settingsFile: _unused, ...rest } = s.opts;
  return { opts: { ...rest, env: { ...rest.env, XDG_CONFIG_HOME: config } } as DoctorOptions, dir: path.join(config, "toriel") };
}

describe("the settings file", () => {
  it("is missing: reported as recommended, and doctor --fix writes the commented defaults, once", () => {
    const s = setup({ noSettings: true });
    const file = s.opts.settingsFile as string;
    const found = collectFindings(s.opts).filter((f) => f.id === "settings-file");
    assert.equal(found.length, 1);
    assert.equal(found[0]?.level, "recommended");
    const [group] = plannedFixes(runDoctor(s.opts));
    assert.equal(group?.file, file);
    assert.match(previewFixes(file, group?.fixes ?? []), /^\+ # toriel settings\./m);
    assert.equal(fs.existsSync(file), false, "previewing writes nothing");
    assert.equal(applyFixes(file, group?.fixes ?? []), undefined, "nothing to back up");
    assert.equal(fs.readFileSync(file, "utf8"), renderSettings());
    assert.deepEqual(collectFindings(s.opts).filter((f) => f.id === "settings-file"), []);
    assert.deepEqual(plannedFixes(runDoctor(s.opts)), [], "and a second run has nothing to do");
  });

  it("is an old settings.json: offered as a conversion that keeps the values and sets the old file aside", () => {
    const s = legacySetup();
    const found = collectFindings(s.opts).filter((f) => f.id === "settings-yaml");
    assert.equal(found.length, 1);
    assert.match(found[0]?.message ?? "", /settings\.json/);
    const [group] = plannedFixes(runDoctor(s.opts));
    const yaml = path.join(s.dir, "settings.yaml");
    assert.equal(group?.file, yaml);
    const preview = previewFixes(yaml, group?.fixes ?? []);
    assert.match(preview, /\+ model: "m1"/);
    assert.match(preview, /settings\.json would be renamed/);
    assert.equal(fs.existsSync(yaml), false, "previewing writes nothing");
    const backup = applyFixes(yaml, group?.fixes ?? [], new Date(2026, 10, 13, 9, 5, 7));
    assert.equal(backup, path.join(s.dir, "settings.json.bak-20261113-090507"));
    assert.equal(fs.readFileSync(backup as string, "utf8"), '{"model":"m1","sandbox":"off","note":1}');
    assert.equal(fs.existsSync(path.join(s.dir, "settings.json")), false);
    const loaded = loadSettings(yaml);
    assert.equal(loaded.settings.model, "m1");
    assert.deepEqual(loaded.problems, ['unknown setting "note"']);
    assert.deepEqual(collectFindings(s.opts).filter((f) => f.id === "settings-yaml"), []);
  });

  it("is an old settings.json that cannot be read: the conversion is refused and nothing moves", () => {
    const s = legacySetup("{ broken");
    const [group] = plannedFixes(runDoctor(s.opts));
    const yaml = path.join(s.dir, "settings.yaml");
    assert.throws(() => previewFixes(yaml, group?.fixes ?? []));
    assert.throws(() => applyFixes(yaml, group?.fixes ?? []));
    assert.ok(fs.existsSync(path.join(s.dir, "settings.json")));
    assert.equal(fs.existsSync(yaml), false);
  });

  it("refuses a group that mixes a custom fix with a JSON edit, rather than dropping one", () => {
    const s = legacySetup();
    const [group] = plannedFixes(runDoctor(s.opts));
    const mixed = [...(group?.fixes ?? []), { file: group?.file ?? "", summary: "x", edit: (c: Record<string, unknown>) => c }];
    assert.throws(() => previewFixes(group?.file ?? "", mixed), /cannot mix/);
    assert.throws(() => applyFixes(group?.file ?? "", mixed), /cannot mix/);
    assert.ok(fs.existsSync(path.join(s.dir, "settings.json")), "nothing was moved");
  });

  it("is quiet when TORIEL_SETTINGS names a file, even a JSON one", () => {
    const s = setup({ settings: '{"model":"m"}' });
    assert.deepEqual(collectFindings(s.opts).filter((f) => f.id === "settings-file" || f.id === "settings-yaml"), []);
  });
});

describe("doctor checks", () => {
  it("finds nothing wrong with a complete setup", () => {
    const { opts, agentDir } = setup();
    fs.mkdirSync(path.join(agentDir, "feedback"), { recursive: true });
    const all = { ...opts, feedbackDir: path.join(agentDir, "feedback") };
    assert.deepEqual(collectFindings(all), []);
    const checks = runDoctor(all);
    assert.equal(exitCode(checks), 0);
    assert.ok(checks.every((c) => c.state === "ok"));
    assert.match(renderDoctor(checks), /Everything checks out\./);
  });

  /** A lane naming a provider that models.json does not have. */
  const lanesScenario = (): DoctorOptions => {
    const s = setup({ settings: '{"agentLanes":{"cheap":"nowhere/x"}}' });
    fs.writeFileSync(path.join(s.opts.agentDir as string, "models.json"), JSON.stringify({ providers: { litellm: {} } }));
    return s.opts;
  };

  /** models.json with a litellm route whose numbers litellm no longer agrees with (ticket 215). */
  const litellmScenario = (routes: Record<string, unknown> = { "local-model": { contextWindow: 262144, maxTokens: 65536 }, "new-route": { contextWindow: 1 } }) => {
    const s = setup({});
    fs.writeFileSync(path.join(s.agentDir, "models.json"), JSON.stringify({ providers: { litellm: { baseUrl: "https://l.example/v1", apiKey: "!secret-command", models: [{ id: "local-model", name: "Local", contextWindow: 122880, maxTokens: 65536 }, { id: "retired" }] } } }));
    return { ...s, opts: { ...s.opts, probeLitellm: () => ({ routes }) as never } };
  };

  it("finds stale litellm metadata, offers to rewrite it, and says so when the proxy cannot be asked (ticket 215)", () => {
    const s = litellmScenario();
    const found = collectFindings(s.opts).filter((f) => f.id === "litellm-models");
    assert.equal(found.length, 1);
    assert.match(found[0]?.message ?? "", /local-model: contextWindow 122880 -> 262144/);
    assert.match(found[0]?.message ?? "", /retired is in models\.json but not served/);
    assert.match(found[0]?.message ?? "", /1 route litellm serves is not in models\.json/);
    assert.match(found[0]?.message ?? "", /not the backend's real limits/);
    assert.doesNotMatch(JSON.stringify(found), /secret-command/, "the credential is never shown");
    // matching numbers, an unreachable proxy and a missing litellm provider are all quiet
    assert.deepEqual(collectFindings(litellmScenario({ "local-model": { contextWindow: 122880, maxTokens: 65536 } }).opts).filter((f) => f.id === "litellm-models"), []);
    assert.deepEqual(collectFindings({ ...s.opts, probeLitellm: () => "HTTP 401" }).filter((f) => f.id === "litellm-models"), []);
    assert.deepEqual(collectFindings(setup({}).opts).filter((f) => f.id === "litellm-models"), []);
    // without a probe (the in-app /doctor) the check is shown as skipped, not as ok
    const { probeLitellm: _drop, ...noProbe } = s.opts;
    const check = runDoctor(noProbe).find((c) => c.id === "litellm-models");
    assert.equal(check?.state, "skipped");
    assert.match(check?.note ?? "", /toriel doctor/);
  });

  it("reads what the daemon learned at start instead of asking the proxy, and only for the proxy models.json names (ticket 221)", () => {
    const s = litellmScenario();
    const { probeLitellm: _drop, ...noProbe } = s.opts;
    const cacheFile = path.join(s.agentDir, "litellm-routes.json");
    const write = (c: object) => fs.writeFileSync(cacheFile, JSON.stringify(c));
    const routes = { "local-model": { contextWindow: 262144, maxTokens: 65536 } };
    const withCache = { ...noProbe, litellmCacheFile: cacheFile };
    // no cache: nothing found, shown as skipped
    assert.deepEqual(collectFindings(withCache).filter((f) => f.id === "litellm-models"), []);
    assert.equal(runDoctor(withCache).find((c) => c.id === "litellm-models")?.state, "skipped");
    // a cache for this proxy: the same finding the CLI would give, and the fix still rewrites the file
    write({ providers: { litellm: { checkedAt: Date.now(), baseUrl: "https://l.example/v1", routes } } });
    const found = collectFindings(withCache).filter((f) => f.id === "litellm-models");
    assert.equal(found.length, 1);
    assert.match(found[0]?.message ?? "", /local-model: contextWindow 122880 -> 262144/);
    assert.equal(runDoctor(withCache).find((c) => c.id === "litellm-models")?.state, "problem");
    // a cache that asked a different proxy says nothing about this one
    write({ providers: { litellm: { checkedAt: Date.now(), baseUrl: "https://other.example/v1", routes } } });
    assert.deepEqual(collectFindings(withCache).filter((f) => f.id === "litellm-models"), []);
    assert.equal(runDoctor(withCache).find((c) => c.id === "litellm-models")?.state, "skipped");
    // matching numbers: ok, with the time it was asked; an unreadable cache is no cache
    write({ providers: { litellm: { checkedAt: Date.now(), baseUrl: "https://l.example/v1", routes: { "local-model": { contextWindow: 122880, maxTokens: 65536 } } } } });
    const ok = runDoctor(withCache).find((c) => c.id === "litellm-models");
    assert.equal(ok?.state, "ok");
    assert.match(ok?.note ?? "", /when the daemon started/);
    fs.writeFileSync(cacheFile, "not json");
    assert.deepEqual(collectFindings(withCache).filter((f) => f.id === "litellm-models"), []);
  });

  it("checks a bifrost gateway the same way, per provider, and the fix edits only that provider (ticket 221)", () => {
    const s = setup({});
    const modelsFile = path.join(s.agentDir, "models.json");
    const original = { providers: { litellm: { baseUrl: "https://l.example/v1", models: [{ id: "keep", contextWindow: 1 }] }, "work-bifrost": { baseUrl: "https://b.example/openai", apiKey: "BF_SECRET_ENV", models: [{ id: "anthropic/claude-x", name: "Claude", contextWindow: 100000, maxTokens: 8192 }] }, openai: { baseUrl: "https://o/v1", models: [{ id: "gpt", contextWindow: 5 }] } } };
    fs.writeFileSync(modelsFile, JSON.stringify(original));
    let asked: unknown[] = [];
    const probe = (t: { kind?: string }) => {
      asked.push(t.kind);
      return t.kind === "bifrost" ? { routes: { "anthropic/claude-x": { contextWindow: 200000, maxTokens: 8192 } } } : "HTTP 401";
    };
    const found = collectFindings({ ...s.opts, probeLitellm: probe as never }).filter((f) => f.id === "bifrost-models");
    assert.deepEqual(asked, ["litellm", "bifrost"], "each gateway is asked, an ordinary provider is not");
    assert.equal(found.length, 1);
    assert.match(found[0]?.message ?? "", /"work-bifrost"/);
    assert.match(found[0]?.message ?? "", /anthropic\/claude-x: contextWindow 100000 -> 200000/);
    assert.doesNotMatch(JSON.stringify(found), /BF_SECRET_ENV/, "the credential is never shown");
    const fixed = found[0]?.fix?.edit(structuredClone(original) as Record<string, unknown>) as typeof original;
    assert.equal(fixed.providers["work-bifrost"].models[0]?.contextWindow, 200000);
    assert.deepEqual(fixed.providers.litellm, original.providers.litellm, "the other providers are untouched");
    assert.deepEqual(fixed.providers.openai, original.providers.openai);
    // the in-app report reads the daemon's cache for it, with its own catalog line
    const { probeLitellm: _drop, ...noProbe } = s.opts;
    const cacheFile = path.join(s.agentDir, "litellm-routes.json");
    fs.writeFileSync(cacheFile, JSON.stringify({ providers: { "work-bifrost": { checkedAt: Date.now(), baseUrl: "https://b.example/openai", routes: { "anthropic/claude-x": { contextWindow: 200000 } } } } }));
    const check = runDoctor({ ...noProbe, litellmCacheFile: cacheFile }).find((c) => c.id === "bifrost-models");
    assert.equal(check?.state, "problem");
    assert.equal(runDoctor({ ...noProbe, litellmCacheFile: cacheFile }).find((c) => c.id === "litellm-models")?.state, "skipped", "litellm has no cache entry");
    asked = [];
  });

  it("only ever reports findings the catalog knows, and the catalog has no dead entries", () => {
    const scenarios: DoctorOptions[] = [
      { ...setup({ noPiDir: true, noResources: true, stale: false, noCli: true, noInhibit: true, settings: '{"bogus":1}' }).opts, startup: ["node is too old"] },
      setup({ stale: true }).opts,
      setup({ noSettings: true }).opts,
      legacySetup().opts,
      setup({ noPackage: true }).opts,
      setup({ noBundled: true }).opts,
      setup({ config: {} }).opts,
      { ...setup({}).opts, env: { WAYLAND_DISPLAY: "wayland-0" }, pathDirs: ["/nonexistent-path"], startup: [] },
      { ...setup({}).opts, tty: true, env: { TERM: "xterm-256color" }, startup: [] },
      { ...setup({}).opts, tty: true, env: { TMUX: "/tmp/tmux-1000/default,1,0" }, probeTmux: () => ({ extendedKeys: "off" }), startup: [] },
      { ...setup({}).opts, tty: true, env: { TMUX: "/tmp/tmux-1000/default,1,0" }, probeTmux: () => ({ extendedKeys: "on", clientTerm: "xterm-kitty", clientFeatures: "RGB" }), kittyConfig: "", startup: [] },
      setup({ gitMcp: "none" }).opts,
      setup({ gdbMcp: "none", ghidraMcp: "codemode" }).opts,
      setup({ config: { authorizerChain: ["toriel-grants"], permission: { "*": "allow", path: { "*": "allow", [GRANTS_RULE]: "ask" } } } }).opts,
      { ...setup({ settings: '{"sandbox":"bwrap"}' }).opts, probeBwrap: () => "bwrap is not installed (the bubblewrap package)" },
      setup({}).opts,
      lanesScenario(),
      litellmScenario().opts,
      (() => {
        const s = setup({});
        fs.writeFileSync(path.join(s.agentDir, "models.json"), JSON.stringify({ providers: { bifrost: { baseUrl: "https://b.example/v1", models: [{ id: "a/b", contextWindow: 1 }] } } }));
        return { ...s.opts, probeLitellm: () => ({ routes: { "a/b": { contextWindow: 2 } } }) as never };
      })(),
      (() => {
        const s = setup({});
        const bundle = path.join(s.agentDir, "feedback", "2026-11-22T22-45-23-015Z-abcd1234");
        fs.mkdirSync(bundle, { recursive: true });
        fs.writeFileSync(path.join(bundle, "session.jsonl"), "");
        fs.truncateSync(path.join(bundle, "session.jsonl"), 3 * 1024 ** 3);
        return { ...s.opts, feedbackDir: path.join(s.agentDir, "feedback"), startup: [] };
      })(),
      setup({ mcpExtra: { broken: { exposure: "direct" } } }).opts,
      setup({ piMcpJson: { mcpServers: { freecad: { url: "http://127.0.0.1:39280/mcp" } } } }).opts,
      setup({ config: { authorizerChain: ["toriel-grants"], permission: { "*": "allow", external_directory_write: { "/tmp/*": "allow" }, path: { "*": "ask", [GRANTS_RULE]: "ask" } } }, settings: JSON.stringify({ scopeGuardAcceptedAllows: [{ surface: "external_directory_write", pattern: "/tmp/*" }, { surface: "*", pattern: "*" }] }) }).opts,
      { ...setup({ settings: '{"chatto":{"url":"https://chat.example.com","tokenFile":"/nonexistent/chatto.token","group":"Toriel","allowedUser":"u1"}}' }).opts, chatClientInstalled: () => false },
      { ...setup({ settings: '{"chatto":{"url":"https://chat.example.com","tokenEnv":"CHAT_T","group":"Toriel","allowedUser":"u1"}}' }).opts, env: { ...process.env, CHAT_T: "t" }, chatClientInstalled: () => true, probeChat: () => ["the inbox name is taken"] },
    ];
    const seen = new Set<string>();
    for (const opts of scenarios) {
      for (const f of collectFindings(opts)) {
        seen.add(f.id);
      }
    }
    const catalog = CATALOG.map((c) => c.id);
    assert.equal(new Set(catalog).size, catalog.length, "catalog ids are unique");
    assert.deepEqual([...seen].filter((id) => !catalog.includes(id)), [], "a finding id is missing from the catalog (src/doctor.ts)");
    assert.deepEqual(catalog.filter((id) => !seen.has(id)), [], "a catalog entry nothing can report any more");
  });

  it("does not flag allows the toriel settings record as accepted (scopeGuardAcceptedAllows)", () => {
    const allows = { authorizerChain: ["toriel-grants"], permission: { "*": "allow", external_directory_write: { "/tmp/*": "allow" }, path: { "*": "ask", [GRANTS_RULE]: "ask" } } };
    const acceptance = JSON.stringify({ scopeGuardAcceptedAllows: [{ surface: "external_directory_write", pattern: "/tmp/*" }, { surface: "*", pattern: "*" }] });
    const without = collectFindings(setup({ config: allows }).opts);
    assert.ok(without.some((f) => f.id === "scope-guard-short-circuit"), "the same config without an acceptance still fires");
    const quiet = collectFindings(setup({ config: allows, settings: acceptance }).opts);
    assert.deepEqual(quiet.filter((f) => f.id === "scope-guard-short-circuit"), []);
    assert.ok(quiet.every((f) => f.id !== "settings"), "the acceptance list itself parses cleanly");
  });

  it("grades what it finds, and exits 1 only for a required problem", () => {
    const grants = runDoctor(setup({ config: {} }).opts);
    assert.deepEqual(grants.filter((c) => c.state === "problem").map((c) => [c.id, c.level]), [["grants-chain", "feature"], ["grants-path-rule", "hardening"]]);
    assert.equal(exitCode(grants), 0);
    const allows = runDoctor(setup({ config: { authorizerChain: ["toriel-grants"], permission: { "*": "allow", path: { "*": "allow", [GRANTS_RULE]: "ask" } } } }).opts);
    assert.deepEqual(allows.filter((c) => c.state === "problem").map((c) => [c.id, c.level]), [["scope-guard-short-circuit", "hardening"]]);
    assert.equal(exitCode(allows), 0);
    const noPackage = runDoctor(setup({ noPackage: true }).opts);
    assert.deepEqual(noPackage.filter((c) => c.state === "problem").map((c) => [c.id, c.level]), [["permission-package", "recommended"]]);
    assert.equal(exitCode(noPackage), 0);
    const noCli = runDoctor(setup({ noCli: true }).opts);
    assert.equal(exitCode(noCli), 1);
    assert.match(collectFindings(setup({ noCli: true }).opts)[0]?.message ?? "", /pi's cli\.js is not at .*cli\.js: run npm install/);
  });

  it("clipboard: only when a display is present, and only when its tool is missing", () => {
    const { opts } = setup({});
    const base = path.dirname(opts.agentDir as string);
    const bin = path.join(base, "bin");
    const nothing = fs.mkdtempSync(path.join(base, "empty-")); // not /bin: on Fedora it is a symlink to /usr/bin, which may hold the tools
    for (const tool of ["wl-paste", "wl-copy", "xclip"]) {
      fs.writeFileSync(path.join(bin, tool), "#!/bin/sh\n", { mode: 0o755 });
    }
    const finding = (env: NodeJS.ProcessEnv, pathDirs: readonly string[] = [env.PATH ?? ""]) => collectFindings({ ...opts, env, startup: [], pathDirs }).filter((f) => f.id === "clipboard");
    assert.deepEqual(finding({}), [], "no display, no clipboard finding");
    assert.equal(finding({ WAYLAND_DISPLAY: "wayland-0" }, [nothing]).length, 1, "wayland without wl-clipboard");
    assert.match(finding({ WAYLAND_DISPLAY: "wayland-0" }, [nothing])[0]?.message ?? "", /wl-clipboard/);
    assert.deepEqual(finding({ WAYLAND_DISPLAY: "wayland-0" }, [bin]), [], "wl-paste and wl-copy present");
    assert.equal(finding({ DISPLAY: ":0" }, [nothing]).length, 1, "x11 without xclip");
    assert.match(finding({ DISPLAY: ":0" }, [nothing])[0]?.message ?? "", /xclip/);
    assert.deepEqual(finding({ DISPLAY: ":0" }, [bin]), [], "xclip present");
  });

  it("notify-send: only with a display, only when notifications are on, only when the tool is missing (ticket 234)", () => {
    const { opts } = setup({});
    const base = path.dirname(opts.agentDir as string);
    const nothing = fs.mkdtempSync(path.join(base, "empty-"));
    const have = fs.mkdtempSync(path.join(base, "have-"));
    fs.writeFileSync(path.join(have, "notify-send"), "#!/bin/sh\n", { mode: 0o755 });
    const finding = (env: NodeJS.ProcessEnv, dirs: string, settings?: string) => {
      const o = settings === undefined ? opts : setup({ settings }).opts;
      return collectFindings({ ...o, env, startup: [], pathDirs: [dirs] }).filter((f) => f.id === "notify-send");
    };
    assert.deepEqual(finding({}, nothing), [], "no display (ssh, a tty): nothing to notify");
    assert.equal(finding({ WAYLAND_DISPLAY: "wayland-0" }, nothing).length, 1);
    assert.match(finding({ WAYLAND_DISPLAY: "wayland-0" }, nothing)[0]?.manual ?? "", /dnf install libnotify/);
    assert.deepEqual(finding({ WAYLAND_DISPLAY: "wayland-0" }, have), [], "present");
    assert.deepEqual(finding({ WAYLAND_DISPLAY: "wayland-0" }, nothing, '{"permissionNotifications":false}'), [], "switched off");
  });

  it("truecolor: only for a real terminal without a truecolor signal", () => {
    const finding = (env: NodeJS.ProcessEnv, tty?: boolean) => collectFindings({ ...setup({}).opts, tty, env, startup: [] }).filter((f) => f.id === "truecolor");
    assert.deepEqual(finding({ TERM: "xterm-256color" }), [], "not a real terminal: skipped");
    assert.equal(finding({ TERM: "xterm-256color" }, true).length, 1);
    assert.match(finding({ TERM: "xterm-256color" }, true)[0]?.message ?? "", /truecolor/);
    assert.deepEqual(finding({ COLORTERM: "truecolor", TERM: "xterm-256color" }, true), [], "COLORTERM says truecolor");
    assert.deepEqual(finding({ TERM: "xterm-kitty" }, true), [], "a known truecolor terminal by name");
  });

  it("tmux-keys: only inside tmux in a real terminal, and only when extended-keys is off (ticket 142)", () => {
    const finding = (env: NodeJS.ProcessEnv, extendedKeys: string | undefined, tty = true) =>
      collectFindings({ ...setup({}).opts, tty, env, startup: [], probeTmux: () => ({ extendedKeys }) }).filter((f) => f.id === "tmux-keys");
    const inTmux = { TMUX: "/tmp/tmux-1000/default,1,0" };
    assert.equal(finding(inTmux, "off").length, 1);
    assert.match(finding(inTmux, "off")[0]?.message ?? "", /extended-keys on/);
    assert.deepEqual(finding(inTmux, "on"), []);
    assert.deepEqual(finding(inTmux, "always"), []);
    assert.deepEqual(finding(inTmux, undefined), [], "tmux could not be asked: no guess");
    assert.deepEqual(finding({}, "off"), [], "not under tmux");
    assert.deepEqual(finding(inTmux, "off", false), [], "not a real terminal");
  });

  it("tmux-hyperlinks: under tmux, when tmux says the client lacks hyperlinks (ticket 211)", () => {
    const inTmux = { TMUX: "/tmp/tmux-1000/default,1,0" };
    const finding = (clientTerm: string | undefined, clientFeatures: string | undefined, env: NodeJS.ProcessEnv = inTmux, tty = true) =>
      collectFindings({ ...setup({}).opts, tty, env, startup: [], probeTmux: () => ({ extendedKeys: "on", clientTerm, clientFeatures }), kittyConfig: "map shift+enter send_text all x" }).filter((f) => f.id === "tmux-hyperlinks");
    const missing = finding("xterm-kitty", "bpaste,clipboard,RGB,title");
    assert.equal(missing.length, 1);
    assert.match(missing[0]?.message ?? "", /set -as terminal-features ",xterm-kitty:hyperlinks"/);
    assert.match(missing[0]?.message ?? "", /restart the tmux server/);
    assert.ok(missing[0]?.manual, "tmux.conf is not a file doctor edits");
    assert.deepEqual(finding("xterm-kitty", "bpaste,clipboard,hyperlinks,RGB"), [], "it is on, from whatever pattern or detection");
    assert.equal(finding("xterm-256color", "RGB").length, 1, "any terminal, not only kitty");
    assert.deepEqual(finding("xterm-kitty", undefined), [], "tmux too old to say: no guess");
    assert.deepEqual(finding("xterm-kitty", ""), [], "tmux before 3.2 renders the format as an empty string: terminal-features does not exist there, so the fix cannot be offered");
    assert.deepEqual(finding(undefined, "RGB"), [], "tmux could not say which terminal");
    assert.deepEqual(finding("xterm-kitty", "RGB", {}), [], "not under tmux");
    assert.deepEqual(finding("xterm-kitty", "RGB", inTmux, false), [], "not a real terminal");
  });

  it("feedback-size: names the bundle folders once they pass 2 GB, and only when asked to look (ticket 240)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-fbsize-"));
    try {
      const bundle = path.join(dir, "2026-11-22T22-45-23-015Z-abcd1234");
      fs.mkdirSync(bundle);
      const big = path.join(bundle, "session.jsonl");
      fs.closeSync(fs.openSync(big, "w"));
      const find = (feedbackDir?: string) => collectFindings({ ...setup({}).opts, startup: [], feedbackDir }).filter((f) => f.id === "feedback-size");
      fs.truncateSync(big, 1024 ** 3);
      assert.deepEqual(find(dir), [], "1 GB is fine");
      fs.truncateSync(big, 2 * 1024 ** 3 + 1);
      const found = find(dir);
      assert.equal(found.length, 1);
      assert.match(found[0]?.message ?? "", /use 2\.0 GB[\s\S]*toriel feedback prune --older-than 30d/);
      assert.ok(found[0]?.manual && !found[0]?.fix, "deleting feedback is never automatic");
      assert.deepEqual(find(undefined), [], "not asked to look: skipped");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mcp-yaml: an entry of mcp.yaml that cannot be used is named, with why (ticket 216)", () => {
    const found = collectFindings({ ...setup({ mcpExtra: { broken: { exposure: "direct" }, odd: { command: "x", lifecycle: "lazy" } } }).opts, startup: [] }).filter((f) => f.id === "mcp-yaml");
    assert.equal(found.length, 2);
    assert.match(found.map((f) => f.message).join("\n"), /"broken": give exactly one of url[\s\S]*"odd": unknown key "lifecycle"/);
    assert.ok(found.every((f) => f.manual && !f.fix));
    assert.deepEqual(collectFindings({ ...setup({}).opts, startup: [] }).filter((f) => f.id === "mcp-yaml"), []);
  });

  it("mcp-json: servers still in pi's mcp.json are moved into mcp.yaml, and the old file is set aside (ticket 216)", () => {
    const s = setup({ piMcpJson: { mcpServers: { freecad: { url: "http://127.0.0.1:39280/mcp" }, gdb: { command: "other" }, odd: { command: "x", lifecycle: "lazy" } } } });
    const found = collectFindings({ ...s.opts, startup: [] }).filter((f) => f.id === "mcp-json");
    assert.equal(found.length, 1);
    assert.match(found[0]?.message ?? "", /still lists freecad, gdb and odd.*mcp\.yaml.*2 to add.*odd\.lifecycle cannot be carried over/);
    const fix = found[0]?.fix;
    assert.ok(fix?.custom);
    const piJson = path.join(s.agentDir, "mcp.json");
    const before = fs.readFileSync(s.mcpFile, "utf8");
    assert.match(fix?.custom?.preview() ?? "", /mcp\.yaml would gain:[\s\S]*freecad[\s\S]*odd[\s\S]*mcp\.json would be renamed/);
    // a secret in the old file must not be printed by the preview (review finding)
    fs.writeFileSync(piJson, JSON.stringify({ mcpServers: { secretive: { command: "x", env: { API_KEY: "sk-very-secret" }, headers: { Authorization: "Bearer s3cret" } }, remote: { url: "https://user:p4ss@h.example/mcp?token=tok" } } }));
    const secretive = collectFindings({ ...s.opts, startup: [] }).find((f) => f.id === "mcp-json");
    const shown = secretive?.fix?.custom?.preview() ?? "";
    assert.match(shown, /secretive/);
    assert.match(shown, /API_KEY: "?\*\*\*/);
    assert.doesNotMatch(shown, /sk-very-secret|s3cret|p4ss|tok\b/);
    assert.doesNotMatch(secretive?.message ?? "", /sk-very-secret|s3cret|p4ss/);
    fs.writeFileSync(piJson, JSON.stringify({ mcpServers: { freecad: { url: "http://127.0.0.1:39280/mcp" }, gdb: { command: "other" }, odd: { command: "x", lifecycle: "lazy" } } }));
    assert.equal(fs.readFileSync(s.mcpFile, "utf8"), before, "previewing writes nothing");
    const backup = fix?.custom?.apply(new Date(2026, 10, 14, 12, 0, 0));
    assert.match(backup ?? "", /mcp\.json\.bak-20261114-120000$/);
    assert.ok(fs.existsSync(backup as string) && !fs.existsSync(piJson), "pi's file is set aside, not deleted");
    const now = JSON.parse(JSON.stringify(readMcpYaml(s.mcpFile).servers));
    assert.deepEqual(now.freecad, { url: "http://127.0.0.1:39280/mcp" });
    assert.deepEqual(now.odd, { command: "x" });
    assert.deepEqual(now.gdb, { command: "node", args: ["x"], exposure: "direct" }, "a server already in mcp.yaml is not overwritten");
    assert.deepEqual(collectFindings({ ...s.opts, startup: [] }).filter((f) => f.id === "mcp-json"), []);
    assert.deepEqual(collectFindings({ ...setup({}).opts, startup: [] }).filter((f) => f.id === "mcp-json"), [], "an empty or missing mcp.json is fine");
  });

  it("kitty-shift-enter: under tmux in kitty, unless kitty.conf maps shift+enter (ticket 142)", () => {
    const inTmux = { TMUX: "/tmp/tmux-1000/default,1,0" };
    const finding = (clientTerm: string | undefined, kittyConfig: string, env: NodeJS.ProcessEnv = inTmux, tty = true) =>
      collectFindings({ ...setup({}).opts, tty, env, startup: [], probeTmux: () => ({ extendedKeys: "on", clientTerm }), kittyConfig }).filter((f) => f.id === "kitty-shift-enter");
    assert.equal(finding("xterm-kitty", "").length, 1, "no kitty.conf at all");
    assert.equal(finding("xterm-kitty", "font_size 12\nmap shift+enter\nmap ctrl+a\n").length, 1, "a map line with no action does not count");
    assert.match(finding("xterm-kitty", "")[0]?.message ?? "", /map shift\+enter send_text all \\x1b\[13;2u/);
    assert.deepEqual(finding("xterm-kitty", "map shift+enter send_text all \\x1b[13;2u\n"), []);
    assert.deepEqual(finding("xterm-kitty", "  MAP  shift+enter  send_text all x"), [], "spacing and case");
    assert.deepEqual(finding("xterm-kitty", "map --release shift+enter send_text all x"), [], "a map with options");
    assert.equal(finding("xterm-kitty", "# map shift+enter send_text all x").length, 1, "a comment does not count");
    assert.deepEqual(finding("xterm-256color", ""), [], "another terminal");
    assert.deepEqual(finding(undefined, ""), [], "tmux could not say which terminal");
    assert.deepEqual(finding("xterm-kitty", "", {}), [], "not under tmux");
    assert.deepEqual(finding("xterm-kitty", "", inTmux, false), [], "not a real terminal");
  });

  it("reads kitty's config with its includes, and treats a missing one as empty", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-kitty-"));
    const env = { KITTY_CONFIG_DIRECTORY: dir };
    assert.equal(readKittyConfig(env), "");
    fs.writeFileSync(path.join(dir, "kitty.conf"), "include keys.conf\nfont_size 12\n");
    fs.writeFileSync(path.join(dir, "keys.conf"), "map shift+enter send_text all \\x1b[13;2u\n");
    assert.match(readKittyConfig(env), KITTY_SHIFT_ENTER);
    fs.writeFileSync(path.join(dir, "keys.conf"), "include kitty.conf\n");
    assert.doesNotMatch(readKittyConfig(env), KITTY_SHIFT_ENTER, "an include loop ends");
  });

  it("skips the checks that need the permission package when it is not there, and says so", () => {
    const checks = runDoctor(setup({ noPackage: true }).opts);
    assert.deepEqual(checks.filter((c) => c.state === "skipped").map((c) => c.id), ["grants-chain", "feedback-size", "grants-path-rule", "scope-guard-short-circuit"]);
    assert.match(renderDoctor(checks), /skipped {2}permission grants are switched on[\s\S]*needs pi-permission-system/);
  });

  it("reports start-up problems it is handed, and settings problems", () => {
    const f = collectFindings({ ...setup({ settings: '{"scheduleDailyLimit":0}' }).opts, startup: ["XDG_RUNTIME_DIR is not set"] });
    assert.deepEqual(f.map((x) => [x.id, x.level]), [["startup", "required"], ["settings", "recommended"]]);
    assert.match(f[1]?.message ?? "", /^toriel settings: scheduleDailyLimit must be a number of at least 1/);
  });

  it("asks for the git MCP server only when it is missing: the agents' sessions declare it directly whatever its exposure (ticket 298)", () => {
    const grade = (gitMcp: string) => collectFindings(setup({ gitMcp }).opts).filter((x) => x.id === "mcp-git-server");
    for (const fine of ["direct", "default", "deferred"]) {
      assert.deepEqual(grade(fine), [], fine);
    }
    const [f] = grade("none");
    assert.equal(f?.level, "feature");
    assert.match(f?.message ?? "", /the "git" MCP server is missing from .*mcp\.yaml: the advisory-diff, code-review and git-archaeology agents need it/);
    assert.equal(f?.fix, undefined, "a missing entry needs the user's own command and args");
  });

  it("does not flag a codemode server: pi's tool_search searches codemode tools like deferred ones, and toriel's sessions all have it (ticket 298)", () => {
    assert.deepEqual(collectFindings(setup({ gitMcp: "codemode" }).opts).filter((x) => x.id === "mcp-codemode"), []);
    assert.deepEqual(collectFindings(setup({ gitMcp: "codemode", settings: "codemode: true\n" }).opts).filter((x) => x.id === "mcp-codemode"), []);
  });

  it("asks for pi-web-access when it is neither bundled nor the user's own, since the research-web agent has no web tools without it", () => {
    assert.deepEqual(collectFindings(setup({}).opts).filter((x) => x.id === "web-package"), []);
    const [f] = collectFindings(setup({ noWeb: true }).opts).filter((x) => x.id === "web-package");
    assert.equal(f?.level, "feature");
    assert.match(f?.message ?? "", /advisory-diff and research-web agents need pi-web-access .*toriel's copy is not installed \(run npm install in the toriel directory\) and it is not in the packages of .*settings\.json/);
    assert.equal(f?.fix, undefined);
    // the user's own install is enough, even when toriel's copy is not there
    assert.deepEqual(collectFindings(setup({ noWeb: true, userWeb: true }).opts).filter((x) => x.id === "web-package"), []);
  });

  it("says when the bundledPackagesOff setting is why there is no web package (ticket 230)", () => {
    const { opts } = setup({ settings: "bundledPackagesOff:\n  - pi-web-access\n" });
    const [f] = collectFindings(opts).filter((x) => x.id === "web-package");
    assert.match(f?.message ?? "", /the bundledPackagesOff setting turns toriel's copy off/);
  });

  it("reports a bundled package that npm install did not leave behind, and not one the user has or switched off (ticket 230)", () => {
    const ok = collectFindings(setup({}).opts).filter((x) => x.id === "bundled-packages");
    assert.deepEqual(ok, []);
    const [f] = collectFindings(setup({ noBundled: true }).opts).filter((x) => x.id === "bundled-packages");
    assert.equal(f?.level, "feature");
    assert.match(f?.message ?? "", /@juicesharp\/rpiv-ask-user-question, pi-web-access and pi-hermes-memory are bundled with toriel but not installed in .*run npm install/);
    assert.equal(f?.fix, undefined);
    const off = collectFindings(setup({ noBundled: true, settings: "bundledPackagesOff:\n  - pi-hermes-memory\n" }).opts).filter((x) => x.id === "bundled-packages");
    assert.match(off[0]?.message ?? "", /^@juicesharp\/rpiv-ask-user-question and pi-web-access are bundled/);
  });

  it("asks for the gdb and ghidra MCP servers the same way, one check per server", () => {
    const grade = (id: string, over: object) => collectFindings(setup(over).opts).filter((x) => x.id === id);
    assert.deepEqual(grade("mcp-gdb-server", {}), []);
    assert.deepEqual(grade("mcp-ghidra-server", {}), []);
    assert.deepEqual(grade("mcp-gdb-server", { gdbMcp: "deferred" }), [], "any exposure will do");
    const [gdb] = grade("mcp-gdb-server", { gdbMcp: "none" });
    assert.equal(gdb?.level, "feature");
    assert.match(gdb?.message ?? "", /^the "gdb" MCP server is missing from .*mcp\.yaml: the crash-analysis and debug agents need it/);
    const [missing] = grade("mcp-ghidra-server", { ghidraMcp: "none" });
    assert.match(missing?.message ?? "", /^the "ghidra" MCP server is missing from .*mcp\.yaml: the binary-diff, re-explain, re-find and re-trace agents need it/);
    assert.equal(missing?.fix, undefined, "a missing entry needs the user's own command and args: no automatic fix");
    assert.deepEqual(grade("mcp-git-server", { gdbMcp: "none", ghidraMcp: "none" }), [], "one server's problem is not another's");
  });

  it("checks that bwrap works unless the sandbox setting is off (the default is on since 2026-11-15)", () => {
    const broken = () => "bwrap is not installed (the bubblewrap package)";
    for (const settings of ['{"sandbox":"bwrap"}', undefined]) {
      const on = collectFindings({ ...setup(settings === undefined ? {} : { settings }).opts, probeBwrap: broken });
      assert.deepEqual(on.map((x) => [x.id, x.level]), [["sandbox-bwrap", "feature"]], `settings ${settings ?? "(default)"}`);
      assert.match(on[0]?.message ?? "", /the command sandbox is on.*but bwrap is not installed.*refuse every bash command.*"sandbox": "off"/);
      assert.equal(on[0]?.fix, undefined, "installing a package is not an automatic edit");
    }
    assert.deepEqual(collectFindings({ ...setup({}).opts, probeBwrap: () => undefined }), [], "a working bwrap is fine");
    assert.deepEqual(collectFindings({ ...setup({ settings: '{"sandbox":"off"}' }).opts, probeBwrap: broken }), [], "switched off: nothing to check");
  });

  it("says a chatto setting without a group is unusable (ticket 292)", () => {
    const settings = '{"chatto":{"url":"https://chat.example.com","tokenEnv":"X","allowedUser":"u1"}}';
    const found = collectFindings({ ...setup({ settings }).opts, probeBwrap: () => undefined }).filter((x) => x.id === "settings");
    assert.match(found[0]?.message ?? "", /chatto\.group is required/);
    assert.ok(found[0]?.manual);
  });

  it("checks the chat bridge's token only when the chatto setting is on (ticket 271)", () => {
    const chatto = (token: string) => `{"chatto":{"url":"https://chat.example.com","tokenFile":${JSON.stringify(token)},"group":"Toriel","allowedUser":"u1"}}`;
    const grade = (settings: string) => collectFindings({ ...setup({ settings }).opts, probeBwrap: () => undefined }).filter((x) => x.id.startsWith("chat-bridge"));
    assert.deepEqual(grade("{}"), [], "no chatto setting: nothing to say");
    const missing = grade(chatto("/nonexistent/chatto.token"));
    assert.deepEqual(missing.map((x) => [x.id, x.level]), [["chat-bridge-token", "feature"]]);
    assert.match(missing[0]?.message ?? "", /cannot start: the token file .* does not exist/);
    assert.ok(missing[0]?.manual);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-chat-"));
    try {
      const file = path.join(dir, "token");
      fs.writeFileSync(file, "t");
      fs.chmodSync(file, 0o644);
      assert.match(grade(chatto(file))[0]?.message ?? "", /chmod 600/);
      fs.chmodSync(file, 0o600);
      assert.deepEqual(grade(chatto(file)), [], "a private token file and the package installed: fine");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const noPackage = collectFindings({ ...setup({ settings: chatto("/nonexistent/t") }).opts, probeBwrap: () => undefined, chatClientInstalled: () => false }).filter((x) => x.id === "chat-bridge-package");
    assert.match(noPackage[0]?.message ?? "", /@chatto\/client is not installed/);
    assert.ok(noPackage[0]?.manual);
  });

  it("asks the chat server only from a terminal, only with a token and the package, and reports what it found (ticket 293)", () => {
    const settings = '{"chatto":{"url":"https://chat.example.com","tokenEnv":"CHAT_T","group":"G2","inboxChannel":"inbox-2","allowedUser":"u1"}}';
    const asked: unknown[] = [];
    const taken = 'the chat bridge\'s inbox name "inbox-2" is taken by a room in group "Other"';
    const probeChat = (c: unknown) => {
      asked.push(c);
      return [taken];
    };
    const base = { ...setup({ settings }).opts, probeBwrap: () => undefined, chatClientInstalled: () => true };
    const found = collectFindings({ ...base, env: { ...process.env, CHAT_T: "t" }, probeChat }).filter((f) => f.id === "chat-bridge-server");
    assert.deepEqual(found.map((f) => [f.level, f.message]), [["feature", taken]]);
    assert.ok(found[0]?.manual);
    assert.match(JSON.stringify(asked[0]), /"group":"G2".*"inboxChannel":"inbox-2"/);
    asked.length = 0;
    const noToken = collectFindings({ ...base, env: { ...process.env, CHAT_T: "" }, probeChat });
    assert.equal(asked.length, 0, "no token: the server is not asked");
    assert.ok(noToken.some((f) => f.id === "chat-bridge-token"));
    const inApp = runDoctor({ ...base, env: { ...process.env, CHAT_T: "t" } }).find((c) => c.id === "chat-bridge-server");
    assert.equal(inApp?.state, "skipped", "the in-app /doctor does not block on the network");
    assert.match(inApp?.note ?? "", /toriel doctor/);
    const brokenToken = runDoctor({ ...base, env: { ...process.env, CHAT_T: "" }, probeChat }).find((c) => c.id === "chat-bridge-server");
    assert.equal(brokenToken?.state, "skipped", "a skipped token check above means the server was never asked: not ok");
    assert.match(brokenToken?.note ?? "", /the token and the package/);
  });

  it("flags a model tier whose provider pi does not know, and stays quiet without lanes or with known providers", () => {
    const s = setup({ settings: '{"agentLanes":{"cheap":"litellm/local-model","medium":"nope/x"}}' });
    fs.writeFileSync(path.join(s.opts.agentDir as string, "models.json"), JSON.stringify({ providers: { litellm: {} } }));
    const found = collectFindings(s.opts).filter((f) => f.id === "agent-lanes");
    assert.equal(found.length, 1);
    assert.equal(found[0]?.level, "feature");
    assert.match(found[0]?.message ?? "", /agentLanes\.medium is nope\/x, but pi has no provider "nope"/);
    assert.ok(found[0]?.manual);
    // a login in auth.json counts as a provider
    fs.writeFileSync(path.join(s.opts.agentDir as string, "auth.json"), JSON.stringify({ nope: { type: "oauth" } }));
    assert.deepEqual(collectFindings(s.opts).filter((f) => f.id === "agent-lanes"), []);
    assert.deepEqual(collectFindings(setup({}).opts).filter((f) => f.id === "agent-lanes"), [], "no lanes, nothing to check");
  });

  it("asks for the sleep lock only on linux, and only when preventSleep is not off", () => {
    assert.deepEqual(collectFindings(setup({ noInhibit: true }).opts).map((x) => [x.id, x.level]), [["sleep-lock", "feature"]]);
    assert.deepEqual(collectFindings({ ...setup({ noInhibit: true }).opts, platform: "darwin" }), []);
    assert.deepEqual(collectFindings(setup({ noInhibit: true, settings: '{"preventSleep":false}' }).opts), []);
  });
});

describe("doctor report", () => {
  it("has a section per level, marks problems, and says which are fixable", () => {
    const text = renderDoctor(runDoctor(setup({ config: {} }).opts));
    assert.match(text, /^toriel doctor\n\nRequired \(toriel does not work without these\)\n {2}ok /);
    assert.match(text, /Optional features[\s\S]*PROBLEM {2}permission grants are switched on[\s\S]*\[fixable: add "toriel-grants" to "authorizerChain"\]/);
    assert.match(text, /Hardening[\s\S]*PROBLEM {2}an agent cannot edit the permission grants file/);
    assert.match(text, /2 problems, 2 fixable automatically \(toriel doctor --fix, or \/doctor --fix\)\.$/);
  });

  it("says for every problem whether it is fixable or manual, with the reason, and counts the manual ones", () => {
    const text = renderDoctor(runDoctor({ ...setup({ noInhibit: true, config: {} }).opts }));
    assert.match(text, /systemd-inhibit is not on PATH[^\n]*\[manual: installing systemd is a system package install/);
    assert.match(text, /\[fixable: add "toriel-grants" to "authorizerChain"\]/);
    assert.match(text, /3 problems, 2 fixable automatically \(toriel doctor --fix, or \/doctor --fix\), 1 needs you \(see "manual" above\)\.$/);
    // every line a PROBLEM entry indents must carry one of the two labels (a skipped entry's note must not)
    let last = "";
    for (const line of text.split("\n")) {
      const tag = /^ {2}(ok|skipped|PROBLEM) {2}/.exec(line);
      if (tag) {
        last = tag[1];
      } else if (/^ {11}\S/.test(line) && last === "PROBLEM") {
        assert.match(line, /\[(fixable|manual): /, line);
      }
    }
  });

  it("gives every finding a fix or a stated reason there is none", () => {
    // the Finding type demands one of the two at compile time; this catches an empty reason or a fix that has no summary
    const findings = collectFindings({ ...setup({ noInhibit: true, config: {} }).opts, probeBwrap: () => "bwrap is not installed" });
    assert.ok(findings.length > 0);
    for (const f of findings) {
      assert.ok(f.fix ? f.fix.summary.length > 0 : (f.manual ?? "").length > 0, `${f.id} has neither a fix nor a manual reason`);
    }
  });

  it("leaves the passing checks out of the compact report and counts them", () => {
    const text = renderDoctor(runDoctor(setup({ config: {} }).opts), { compact: true });
    assert.match(text, /Required: all 5 ok/);
    assert.match(text, /Recommended: all 5 ok/);
    assert.doesNotMatch(text, / ok {7}/);
    assert.match(text, /Optional features[\s\S]*PROBLEM {2}permission grants[\s\S]*\(20 ok\)/);
  });
});

describe("doctor report colours", () => {
  // one setup per test: its temp directory shows in the messages, so two setups would never read the same
  let found: ReturnType<typeof runDoctor>;
  beforeEach(() => {
    found = runDoctor(setup({ config: {} }).opts);
  });
  const checks = () => found;
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

  it("adds no escape codes unless asked", () => {
    assert.doesNotMatch(renderDoctor(checks()), /\x1b/);
  });

  it("colours ok green, PROBLEM red and the problem count red, and leaves the words the same", () => {
    const plain = renderDoctor(checks());
    const coloured = renderDoctor(checks(), { style: ANSI_STYLE });
    assert.equal(strip(coloured), plain);
    assert.match(coloured, /\x1b\[32mok {5}\x1b\[39m/);
    assert.match(coloured, /\x1b\[31mPROBLEM\x1b\[39m/);
    assert.match(coloured, /\x1b\[31m2 problems\x1b\[39m, 2 fixable/);
  });

  it("colours the compact report too, with the passing checks' count dim", () => {
    const coloured = renderDoctor(checks(), { compact: true, style: ANSI_STYLE });
    assert.match(coloured, /Required\x1b\[22m: \x1b\[32mall 5 ok\x1b\[39m/);
    assert.match(coloured, /\x1b\[2m {2}\(20 ok\)\x1b\[22m/);
  });
});

describe("doctor fixes", () => {
  it("rewrites stale litellm numbers in models.json, keeping everything else and a backup (ticket 215)", () => {
    const s = setup({});
    const file = path.join(s.agentDir, "models.json");
    const original = JSON.stringify({ providers: { litellm: { baseUrl: "https://l.example/v1", apiKey: "k", models: [{ id: "local-model", name: "Local", reasoning: true, contextWindow: 122880, maxTokens: 65536 }] }, zai: { baseUrl: "https://z" } } }, null, 2);
    fs.writeFileSync(file, original);
    const opts = { ...s.opts, probeLitellm: () => ({ routes: { "local-model": { contextWindow: 262144, maxTokens: 65536 } } }) as never };
    const [group] = plannedFixes(runDoctor(opts));
    assert.equal(group?.file, file);
    assert.match(previewFixes(file, group?.fixes ?? []), /\+ +"contextWindow": 262144/);
    const backup = applyFixes(file, group?.fixes ?? [], new Date(2026, 10, 14, 9, 5, 7));
    assert.equal(fs.readFileSync(backup as string, "utf8"), original);
    const now = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(now.providers.litellm.models, [{ id: "local-model", name: "Local", reasoning: true, contextWindow: 262144, maxTokens: 65536 }]);
    assert.equal(now.providers.litellm.apiKey, "k");
    assert.deepEqual(now.providers.zai, { baseUrl: "https://z" });
    assert.deepEqual(collectFindings(opts).filter((f) => f.id === "litellm-models"), [], "nothing left to fix");
  });

  it("adds the chain entry and the path rule, keeping a backup and the file's mode", () => {
    const s = setup({ config: { permission: { "*": "allow", bash: { "*": "allow", "sudo *": "ask" } } } });
    fs.chmodSync(s.config, 0o640);
    const original = fs.readFileSync(s.config, "utf8");
    const [group] = plannedFixes(runDoctor(s.opts));
    assert.equal(group?.file, s.config);
    assert.equal(group?.fixes.length, 2);
    const diff = previewFixes(s.config, group?.fixes ?? []);
    assert.match(diff, /\+ {3}"authorizerChain": \[/);
    assert.match(diff, /\+ {7}"~\/\.local\/share\/toriel\/permissions\.json": "ask"/);
    assert.doesNotMatch(diff, /\+ {7}"\*": "allow",/, "the fix no longer seeds an allow-all into a missing path section (an omitted fallback means ask)");
    assert.equal(fs.readFileSync(s.config, "utf8"), original, "previewing writes nothing");
    const backup = applyFixes(s.config, group?.fixes ?? [], new Date(2026, 10, 1, 9, 5, 7));
    assert.match(backup ?? "", /config\.json\.bak-20261101-090507$/);
    assert.equal(fs.readFileSync(backup as string, "utf8"), original);
    assert.equal(fs.statSync(s.config).mode & 0o777, 0o640);
    const now = JSON.parse(fs.readFileSync(s.config, "utf8"));
    assert.deepEqual(now.authorizerChain, ["toriel-grants"]);
    assert.deepEqual(now.permission.bash, { "*": "allow", "sudo *": "ask" }, "the user's own rules are untouched");
    assert.deepEqual(now.permission.path, { [GRANTS_RULE]: "ask" });
    assert.deepEqual(collectFindings(s.opts).map((f) => f.id), ["scope-guard-short-circuit"], "the grants problems are gone; the \"*\": allow fallback remains, and only a person should narrow it");
    assert.deepEqual(plannedFixes(runDoctor(s.opts)), [], "and there is nothing left to fix");
  });

  it("appends to an existing chain and path block, and turns an explicit allow on the file into ask", () => {
    const s = setup({ config: { authorizerChain: ["model-judge"], permission: { path: { "*.env": "deny", [GRANTS_RULE]: "allow" } } } });
    const [group] = plannedFixes(runDoctor(s.opts));
    applyFixes(s.config, group?.fixes ?? []);
    const now = JSON.parse(fs.readFileSync(s.config, "utf8"));
    assert.deepEqual(now.authorizerChain, ["model-judge", "toriel-grants"]);
    assert.deepEqual(Object.entries(now.permission.path), [["*.env", "deny"], [GRANTS_RULE, "ask"]], "the rule moves last so it wins");
    assert.deepEqual(collectFindings(s.opts), []);
  });

  it("does not touch a config it cannot read as a JSON object", () => {
    const s = setup({ config: { authorizerChain: ["toriel-grants"], permission: {} } });
    fs.writeFileSync(s.config, "{ not json");
    assert.throws(() => previewFixes(s.config, [{ file: s.config, summary: "x", edit: (c) => c }]));
    fs.writeFileSync(s.config, "[]");
    assert.throws(() => previewFixes(s.config, [{ file: s.config, summary: "x", edit: (c) => c }]), /not a JSON object/);
    assert.equal(fs.readFileSync(s.config, "utf8"), "[]");
    assert.deepEqual(fs.readdirSync(path.dirname(s.config)), ["config.json"], "no backup for a failed fix");
  });

  it("offers no fix for the package, the files or the settings: those need a person", () => {
    assert.deepEqual(plannedFixes(runDoctor(setup({ noPackage: true, noCli: true, noResources: true }).opts)), []);
  });
});

describe("lineDiff", () => {
  it("is empty when nothing changes", () => {
    assert.equal(lineDiff("a\nb", "a\nb"), "");
  });

  it("marks added and removed lines with two lines of context and ellipses between distant changes", () => {
    const before = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"].join("\n");
    const after = ["1", "X", "3", "4", "5", "6", "7", "8", "Y", "10"].join("\n");
    assert.equal(lineDiff(before, after), ["  1", "- 2", "+ X", "  3", "  4", "  ...", "  7", "  8", "- 9", "+ Y", "  10"].join("\n"));
  });
});
