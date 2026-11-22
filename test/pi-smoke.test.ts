// The pinned pi still behaves the way toriel assumes (ticket 75). These run the real pi in toriel's node_modules, with no model and no
// network and an empty config directory, so they are what a pi bump (`toriel update pi`) runs into first: a change that breaks one of
// toriel's assumptions fails here, in one place, instead of as a live bug.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createEditToolDefinition } from "@earendil-works/pi-coding-agent";
import { DEFAULT_PI_CLI } from "../src/config.ts";
import { EDIT_SCHEMA } from "../pi/extensions/toriel-files.ts";

const ROOT = join(import.meta.dirname, "..");
const agentDir = mkdtempSync(join(tmpdir(), "pi-smoke-"));
const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };

function pi(args: string[]): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [DEFAULT_PI_CLI, ...args], { env, encoding: "utf8", timeout: 30_000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("the pinned pi", () => {
  it("is the version package.json pins", () => {
    const pinned = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { dependencies: Record<string, string> }).dependencies["@earendil-works/pi-coding-agent"];
    assert.equal(pi(["--version"]).out.trim(), pinned);
  });

  it("refuses a --tools list that mixes bare names with +name (profileArgs relies on it never being built)", () => {
    const r = pi(["--tools", "read,+grep", "--no-extensions", "-p", "hi"]);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /tool names cannot be mixed with \+name or -name entries/);
  });

  it("loads the bundled permission package by -e under --no-extensions (it is the gate every session needs)", async () => {
    const reply = await rpc("get_commands", ["-e", join(ROOT, "node_modules", "@gotgenes", "pi-permission-system")]);
    const names = ((reply.data as { commands: Array<{ name: string }> }).commands ?? []).map((c) => c.name);
    assert.ok(names.includes("permission-system"), `the package's command is registered (got ${names.join(", ")})`);
  });

  it("lets an extension replace the built-in edit tool under the same name (toriel-files adds replaceAll that way)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-smoke-edit-"));
    const dump = join(dir, "tools.json");
    const probe = join(dir, "probe.ts");
    writeFileSync(probe, `import { writeFileSync } from "node:fs";\nexport default function (pi: any) {\n  pi.on("session_start", () => writeFileSync(${JSON.stringify(dump)}, JSON.stringify(pi.getAllTools().map((t: any) => ({ name: t.name, replaceAll: Boolean(t.parameters?.properties?.edits?.items?.properties?.replaceAll) })))));\n}\n`);
    await rpc("get_state", ["-e", join(ROOT, "pi", "extensions", "toriel-files.ts"), "-e", probe], { TORIEL_CHILD: "1" });
    await new Promise((r) => setTimeout(r, 300));
    const tools = JSON.parse(readFileSync(dump, "utf8")) as Array<{ name: string; replaceAll: boolean }>;
    assert.equal(tools.filter((t) => t.name === "edit").length, 1, "one edit tool, not two");
    assert.equal(tools.find((t) => t.name === "edit")?.replaceAll, true, "and it is the extension's");
  });

  it("has an edit schema that toriel-files' override still matches apart from replaceAll (ticket 241)", () => {
    // pi's schema is a typebox object: round-trip it to plain JSON for comparison
    interface EditSchema {
      properties: { edits: { items: { required: string[]; properties: Record<string, { type?: string; description?: string }> } } };
    }
    const theirs = JSON.parse(JSON.stringify(createEditToolDefinition(process.cwd()).parameters)) as EditSchema;
    const ours = JSON.parse(JSON.stringify(EDIT_SCHEMA)) as EditSchema;
    const item = (schema: EditSchema) => schema.properties.edits.items;
    const hint = "Update EDIT_SCHEMA in pi/extensions/toriel-files.ts to pi's current edit parameters (keeping replaceAll), and check pi's edit.js for behavior changes the override would shadow.";

    // replaceAll is the one addition; it must be optional, a boolean, and nothing else may differ in what is required
    assert.equal(item(ours).properties.replaceAll?.type, "boolean", "replaceAll is a boolean");
    assert.ok(!item(ours).required.includes("replaceAll"), "and optional");
    const withoutAddition = structuredClone(ours);
    delete item(withoutAddition).properties.replaceAll;

    // the oldText description is ours with a clause about replaceAll appended: it must still START with pi's sentence
    const theirOld = item(theirs).properties.oldText?.description ?? "";
    const ourOld = item(withoutAddition).properties.oldText?.description ?? "";
    assert.ok(ourOld.startsWith(theirOld.replace(/\.$/, "")), `oldText description drifted from pi's: ${theirOld}\n${hint}`);
    (item(withoutAddition).properties.oldText ?? {}).description = theirOld;

    assert.deepEqual(withoutAddition, theirs, `the edit schema differs from pi's built-in.\n${hint}`);
  });

  it("answers a get_state request over RPC (the daemon's handshake with every child)", async () => {
    const reply = await rpc("get_state");
    assert.equal(reply.success, true);
    assert.equal(reply.command, "get_state");
    assert.equal(typeof (reply.data as Record<string, unknown>).sessionId, "string", "the controller keys a session by the sessionId in get_state");
  });
});

/** One RPC request to a fresh pi (no model, no network, an empty config directory) and its reply. */
async function rpc(command: string, extra: string[] = [], moreEnv: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const child = spawn(process.execPath, [DEFAULT_PI_CLI, "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--offline", ...extra], { env: { ...env, ...moreEnv }, stdio: ["pipe", "pipe", "pipe"] });
  try {
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`pi did not answer ${command} in 20s`)), 20_000);
      let buf = "";
      child.stdout.on("data", (d: Buffer) => {
        buf += d.toString();
        for (const line of buf.split("\n")) {
          try {
            const msg = JSON.parse(line) as Record<string, unknown>;
            if (msg.type === "response" && msg.id === "smoke") {
              clearTimeout(timer);
              resolve(msg);
            }
          } catch {
            // a partial or non-JSON line
          }
        }
      });
      child.on("error", reject);
      child.stdin.write(`${JSON.stringify({ type: command, id: "smoke" })}\n`);
    });
  } finally {
    child.kill();
  }
}
