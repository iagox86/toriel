// A complete, healthy toriel setup under a temporary HOME, for the doctor tests; `over` breaks pieces of it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DoctorOptions } from "../src/doctor.ts";
import { RESOURCES } from "../src/resources.ts";

export const GRANTS_RULE = "~/.local/share/toriel/permissions.json";
export const GOOD_CONFIG = { authorizerChain: ["toriel-grants"], permission: { "*": "allow", path: { "*": "allow", [GRANTS_RULE]: "ask" } } };

const mk = (p: string) => fs.mkdirSync(p, { recursive: true });

/** Point HOME at a fresh temp directory (the grants-file rule is written with ~); `done()` puts everything back. */
export function tempHome(): { home: string; done(): void } {
  const saved = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "toriel-doctor-"));
  process.env.HOME = home;
  return {
    home,
    done: () => {
      process.env.HOME = saved;
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

export interface Over {
  config?: unknown;
  settings?: string;
  noPackage?: boolean;
  noPiDir?: boolean;
  stale?: boolean;
  noResources?: boolean;
  noCli?: boolean;
  noInhibit?: boolean;
}

export function setup(home: string, over: Over = {}) {
  const base = fs.mkdtempSync(path.join(home, "s-"));
  const agentDir = path.join(base, "agent");
  if (!over.noPiDir) {
    mk(path.join(agentDir, "extensions", "pi-permission-system"));
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: over.noPackage ? [] : ["npm:@gotgenes/pi-permission-system"] }));
    if (!over.noPackage) {
      fs.writeFileSync(path.join(agentDir, "extensions", "pi-permission-system", "config.json"), typeof over.config === "string" ? over.config : JSON.stringify(over.config ?? GOOD_CONFIG));
    }
  }
  if (over.stale) {
    mk(path.join(agentDir, "extensions"));
    fs.symlinkSync("/nowhere", path.join(agentDir, "extensions", "toriel-agents.ts"));
  }
  const root = path.join(base, "pi");
  if (!over.noResources) {
    for (const r of RESOURCES) {
      mk(path.dirname(path.join(root, r.path)));
      fs.writeFileSync(path.join(root, r.path), "");
    }
  }
  const bin = path.join(base, "bin");
  mk(bin);
  if (!over.noInhibit) {
    fs.writeFileSync(path.join(bin, "systemd-inhibit"), "#!/bin/sh\n", { mode: 0o755 });
  }
  const piCli = path.join(base, "cli.js");
  if (!over.noCli) {
    fs.writeFileSync(piCli, "");
  }
  const settingsFile = path.join(base, "toriel-settings.json");
  if (over.settings !== undefined) {
    fs.writeFileSync(settingsFile, over.settings);
  }
  const grantsFile = path.join(home, ".local", "share", "toriel", "permissions.json");
  const opts: DoctorOptions = { agentDir, root, grantsFile, settingsFile, piCli, pathDirs: [bin], platform: "linux", startup: [], env: {} };
  return { agentDir, opts, config: path.join(agentDir, "extensions", "pi-permission-system", "config.json"), grantsFile };
}
