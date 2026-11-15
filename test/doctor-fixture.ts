// A complete, healthy toriel setup under a temporary HOME, for the doctor tests; `over` breaks pieces of it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DoctorOptions } from "../src/doctor.ts";
import { RESOURCES } from "../src/resources.ts";
import { renderSettings } from "../src/settings-file.ts";

export const GRANTS_RULE = "~/.local/share/toriel/permissions.json";
export const GOOD_CONFIG = { authorizerChain: ["toriel-grants"], permission: { "*": "ask", path: { "*": "ask", [GRANTS_RULE]: "ask" } } };

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
  /** No toriel settings file at all (the default is the commented defaults file, a healthy setup). */
  noSettings?: boolean;
  noPackage?: boolean;
  noPiDir?: boolean;
  stale?: boolean;
  noResources?: boolean;
  noCli?: boolean;
  noInhibit?: boolean;
  /** The git MCP server in mcp.yaml: "direct" (default, healthy), another exposure, or "none" for no mcp.yaml at all. */
  gitMcp?: string;
  /** Leave pi-web-access out of pi's packages. */
  noWeb?: boolean;
  /** Same for the gdb and ghidra servers (the debug and re-* agents). */
  gdbMcp?: string;
  ghidraMcp?: string;
  /** Extra servers for mcp.yaml (name -> entry), or raw text to append (a broken entry). */
  mcpExtra?: Record<string, unknown>;
  /** What pi's own mcp.json holds (the file toriel no longer reads: the doctor offers to move it). */
  piMcpJson?: unknown;
  /** Place a fake installed pi-permission-system package beside piCli: "absent" (unpatched) or "present" (carries the scope-patch marker). */
  scopePatch?: "absent" | "present";
}

export function setup(home: string, over: Over = {}) {
  const base = fs.mkdtempSync(path.join(home, "s-"));
  const agentDir = path.join(base, "agent");
  const mcpFile = path.join(base, "mcp.yaml");
  if (!over.noPiDir) {
    mk(path.join(agentDir, "extensions", "pi-permission-system"));
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [...(over.noPackage ? [] : ["npm:@gotgenes/pi-permission-system"]), ...(over.noWeb ? [] : ["npm:pi-web-access"])] }));
    if (!over.noPackage) {
      fs.writeFileSync(path.join(agentDir, "extensions", "pi-permission-system", "config.json"), typeof over.config === "string" ? over.config : JSON.stringify(over.config ?? GOOD_CONFIG));
    }
  }
  if (over.stale) {
    mk(path.join(agentDir, "extensions"));
    fs.symlinkSync("/nowhere", path.join(agentDir, "extensions", "toriel-agents.ts"));
  }
  if (over.gitMcp !== "none" && !over.noPiDir) {
    mk(agentDir);
    const server = (exposure: string | undefined) => ({ command: "node", args: ["x"], ...(exposure === "default" ? {} : { exposure: exposure ?? "direct" }) });
    const mcpServers: Record<string, unknown> = { git: server(over.gitMcp) };
    for (const [name, exposure] of [["gdb", over.gdbMcp], ["ghidra", over.ghidraMcp]] as const) {
      if (exposure !== "none") {
        mcpServers[name] = server(exposure);
      }
    }
    Object.assign(mcpServers, over.mcpExtra ?? {});
    fs.writeFileSync(mcpFile, JSON.stringify({ servers: mcpServers }));
  }
  if (over.piMcpJson !== undefined && !over.noPiDir) {
    mk(agentDir);
    fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify(over.piMcpJson));
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
  if (over.scopePatch !== undefined) {
    const pkg = path.join(base, "node_modules", "@gotgenes", "pi-permission-system", "src", "session");
    mk(pkg);
    fs.writeFileSync(path.join(pkg, "permission-session.ts"), over.scopePatch === "present" ? "// toriel-scope-patch\n" : "export {}\n");
  }
  const settingsFile = path.join(base, "toriel-settings.yaml");
  if (over.settings !== undefined) {
    fs.writeFileSync(settingsFile, over.settings);
  } else if (!over.noSettings) {
    fs.writeFileSync(settingsFile, renderSettings());
  }
  const grantsFile = path.join(home, ".local", "share", "toriel", "permissions.json");
  const opts: DoctorOptions = { agentDir, mcpFile, root, grantsFile, settingsFile, piCli, pathDirs: [bin], platform: "linux", startup: [], env: { TORIEL_NODE: "/nonexistent-node" } };
  return { agentDir, mcpFile, opts, config: path.join(agentDir, "extensions", "pi-permission-system", "config.json"), grantsFile };
}
