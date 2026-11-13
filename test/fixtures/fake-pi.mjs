// Minimal stand-in for `pi --mode rpc`, enough for the daemon's RpcClient:
// get_state / get_messages / prompt / set_session_name / abort, JSONL on stdio.
// Like pi, the session file is only written once the first prompt arrives.
//
// Env: FAKE_PI_DIR (where new session files go; default: $TMPDIR/fake-pi-sessions), FAKE_PI_STARTUP_MS (delay
// before answering the first command), FAKE_PI_RUN_MS (how long a run lasts).
// FAKE_PI_SLOW=1 scripts a realistic run (thinking deltas, a bash tool call,
// streamed text; a prompt containing "fail" ends in a provider error). Each
// step lasts FAKE_PI_STEP_MS (default 400). Prompts that arrive mid-run queue
// (queue_update) and are delivered together when the turn ends, like pi's
// steeringMode "all".
//
// Names (board 156). By default the name is a plain variable. FAKE_PI_NAME_MODE turns on the way real pi
// resolves it: a name is a session_info entry written to the session file (once the file exists), a fork
// starts as a COPY of its parent's file so it reports the parent's name until its own entry lands, and
// get_state reports the latest entry that is still on the active branch. The mode also injects faults:
//   file       the model only
//   ignore:N   the first N name writes are silently dropped (the --name flag counts as the first), yet answered success
//   fail:N     the first N set_session_name calls answer success:false
//   delay:MS   a set_session_name is answered at once but lands MS later
// FAKE_PI_COMPACT_ORPHANS_NAME=1 makes a compaction move the active branch off the name entries.
import { tmpdir } from "node:os";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

const sessionId = flag("--session-id") ?? randomUUID();
let sessionFile = flag("--session");
const forkFrom = flag("--fork");
if (!sessionFile) {
  const dir = process.env.FAKE_PI_DIR ?? join(tmpdir(), "fake-pi-sessions");
  mkdirSync(dir, { recursive: true });
  sessionFile = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
}
let sessionName = flag("--name");
const nameMode = process.env.FAKE_PI_NAME_MODE ?? "";
const nameModel = nameMode !== "";
const nameFault = (kind) => {
  const m = new RegExp(`(?:^|,)${kind}:(\\d+)`).exec(nameMode);
  return m ? Number(m[1]) : 0;
};
const nameEntries = []; // { name, orphan }
let inheritedName;
let nameWrites = 0; // name writes seen: the --name flag first, then each set_session_name
let nameSetCalls = 0;
// let tests see how the daemon launched this child
mkdirSync(dirname(sessionFile), { recursive: true });
writeFileSync(`${sessionFile}.argv.json`, JSON.stringify(args));
writeFileSync(`${sessionFile}.env.json`, JSON.stringify({ pid: process.pid, TORIEL_SESSION_ID: process.env.TORIEL_SESSION_ID ?? null, TORIEL_SOCK: process.env.TORIEL_SOCK ?? null, TORIEL_CAN_SPAWN: process.env.TORIEL_CAN_SPAWN ?? null, TORIEL_AGENT_TYPES: process.env.TORIEL_AGENT_TYPES ?? null, TORIEL_SCOPE_ROOT: process.env.TORIEL_SCOPE_ROOT ?? null, TORIEL_SCOPE_MODE: process.env.TORIEL_SCOPE_MODE ?? null, TORIEL_SANDBOX: process.env.TORIEL_SANDBOX ?? null, TORIEL_SANDBOX_RW: process.env.TORIEL_SANDBOX_RW ?? null, TORIEL_SHARED_DIR: process.env.TORIEL_SHARED_DIR ?? null, cwd: process.cwd() }));
const messages = [];

function loadMessages(file) {
  if (!existsSync(file)) {
    return;
  }
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) {
      continue;
    }
    const entry = JSON.parse(line);
    if (entry.type === "message") {
      messages.push(entry.message);
    }
  }
}
loadMessages(forkFrom ?? sessionFile);
if (nameModel && forkFrom && existsSync(forkFrom)) {
  // pi's fork is a copy of the parent's file: its entries, and so its name, come along
  const lines = readFileSync(forkFrom, "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    const entry = JSON.parse(line);
    if (entry.type === "session_info" && entry.name) {
      inheritedName = entry.name;
    }
  }
  mkdirSync(dirname(sessionFile), { recursive: true });
  writeFileSync(sessionFile, `${[JSON.stringify({ type: "session", id: sessionId }), ...lines.filter((l) => JSON.parse(l).type !== "session")].join("\n")}\n`);
}
if (nameModel && existsSync(sessionFile) && !forkFrom) {
  for (const line of readFileSync(sessionFile, "utf8").split("\n").filter(Boolean)) {
    const entry = JSON.parse(line);
    if (entry.type === "session_info" && entry.name) {
      nameEntries.push({ name: entry.name, orphan: false });
    }
  }
}

const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const ok = (id, command, data) => out({ type: "response", id, command, success: true, data });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastEntryId = null;

// one name write: dropped, or kept in memory and (when the file exists) appended as a session_info entry
function writeName(name) {
  nameWrites++;
  if (nameWrites <= nameFault("ignore")) {
    return;
  }
  nameEntries.push({ name, orphan: false });
  if (existsSync(sessionFile)) {
    appendFileSync(sessionFile, `${JSON.stringify({ type: "session_info", id: randomUUID().slice(0, 8), parentId: lastEntryId, timestamp: new Date().toISOString(), name })}\n`);
  }
}
const resolveName = () => (nameModel ? [...nameEntries].reverse().find((e) => !e.orphan)?.name ?? inheritedName : sessionName);
if (nameModel && sessionName) {
  writeName(sessionName);
}
let model = { provider: "fake", id: "fake-model", contextWindow: 100000 };
let thinkingLevel = "medium";

function persist(message) {
  messages.push(message);
  mkdirSync(dirname(sessionFile), { recursive: true });
  if (!existsSync(sessionFile)) {
    writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: sessionId })}\n`);
  }
  const id = randomUUID().slice(0, 8);
  appendFileSync(sessionFile, `${JSON.stringify({ type: "message", id, parentId: lastEntryId, timestamp: new Date().toISOString(), message })}\n`);
  lastEntryId = id;
}

// Session-bridge mode (FAKE_PI_BRIDGE=1): like the toriel-session-bridge extension, the
// command `/toriel-inject {"id","text"}` appends a toriel-inject custom message - at the
// turn boundary while a run is in flight, or by starting a turn when idle - and reports
// it as a toriel-bridge status record. FAKE_PI_BRIDGE_FAIL=1 reports a failure instead.
const bridgePending = [];
const bridgeStatus = (r) => out({ type: "extension_ui_request", id: randomUUID(), method: "setStatus", statusKey: "toriel-bridge", statusText: JSON.stringify({ v: 1, ...r }) });
function persistCustom(p) {
  const custom = { role: "custom", customType: "toriel-inject", content: p.text, display: true, details: { id: p.id } };
  messages.push(custom);
  mkdirSync(dirname(sessionFile), { recursive: true });
  if (!existsSync(sessionFile)) {
    writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: sessionId })}\n`);
  }
  const id = randomUUID().slice(0, 8);
  const entry = { type: "custom_message", id, parentId: lastEntryId, timestamp: new Date().toISOString(), customType: custom.customType, content: custom.content, display: true, details: custom.details };
  appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
  lastEntryId = id;
  return { custom, entry };
}

let streaming = false;
let started = false;
let aborted = false;
let compacting = false;
const slow = process.env.FAKE_PI_SLOW === "1";
const stepMs = Number(process.env.FAKE_PI_STEP_MS ?? 400);
const queue = [];
const queueUpdate = () => out({ type: "queue_update", steering: [...queue], followUp: [] });

async function pause() {
  await sleep(stepMs);
  return !aborted;
}

// One scripted turn answering `texts` (already-delivered user messages).
async function slowRun(texts) {
  const prompt = texts.join("\n");
  const partial = { role: "assistant", content: [] };
  out({ type: "message_start", message: partial });
  const update = (e) => out({ type: "message_update", message: partial, assistantMessageEvent: e });
  update({ type: "thinking_start", contentIndex: 0 });
  for (const word of ["Let me", " think", " about", " that..."]) {
    if (!(await pause())) {
      return;
    }
    update({ type: "thinking_delta", contentIndex: 0, delta: word });
  }
  update({ type: "thinking_end", contentIndex: 0, content: "Let me think about that..." });
  if (prompt.includes("fail")) {
    const err = { role: "assistant", content: [], stopReason: "error", errorMessage: "provider exploded" };
    out({ type: "message_end", message: err });
    return;
  }
  const args = { command: "ls" };
  out({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args });
  if (!(await pause())) {
    return;
  }
  out({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "a.ts\nb.ts" }] } });
  update({ type: "text_start", contentIndex: 1 });
  for (const word of ["echo: ", prompt]) {
    if (!(await pause())) {
      return;
    }
    update({ type: "text_delta", contentIndex: 1, delta: word });
  }
  const final = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Let me think about that..." },
      { type: "text", text: `echo: ${prompt}` },
    ],
    usage: { input: 6, output: 4, cacheRead: 5000, totalTokens: 5010, cost: { total: 0.001 } },
    stopReason: "stop",
  };
  persist(final);
  out({ type: "message_end", message: final });
}

async function slowPrompt(first) {
  streaming = true;
  aborted = false;
  out({ type: "agent_start" });
  let texts = [first];
  while (texts.length > 0) {
    for (const t of texts) {
      const user = { role: "user", content: t };
      out({ type: "message_start", message: user });
      persist(user);
      out({ type: "message_end", message: user });
    }
    await slowRun(texts);
    if (bridgePending.length > 0 && !aborted) {
      // a turn boundary: append everything the bridge holds, then answer it
      const injected = bridgePending.splice(0);
      for (const p of injected) {
        out({ type: "entry_appended", entry: persistCustom(p).entry });
      }
      for (const p of injected) {
        bridgeStatus({ kind: "injected", id: p.id });
      }
      await slowRun(injected.map((p) => p.text));
    }
    texts = queue.splice(0, queue.length);
    if (texts.length > 0 && process.env.FAKE_PI_DROP_QUEUE_REMOVAL !== "1") {
      // with the flag set the empty-queue update is withheld, like a lost event
      queueUpdate();
    }
  }
  streaming = false;
  out({ type: "agent_settled" });
}

let bashStop;
let abortSettled = false;

async function handle(cmd) {
  if (!started) {
    started = true;
    await sleep(Number(process.env.FAKE_PI_STARTUP_MS ?? 0));
    if (process.env.FAKE_PI_USAGE) {
      // what the toriel-usage extension does: a status record the daemon should consume
      out({ type: "extension_ui_request", id: "usage-1", method: "setStatus", statusKey: "toriel-usage", statusText: process.env.FAKE_PI_USAGE });
    }
  }
  switch (cmd.type) {
    case "get_state":
      return ok(cmd.id, "get_state", {
        model,
        thinkingLevel,
        isStreaming: streaming,
        sessionFile,
        sessionId,
        sessionName: resolveName(),
        messageCount: messages.length,
        pendingMessageCount: queue.length,
      });
    case "get_last_assistant_text": {
      const last = [...messages].reverse().find((m) => m.role === "assistant");
      const part = Array.isArray(last?.content) ? last.content.find((c) => c.type === "text") : undefined;
      return ok(cmd.id, "get_last_assistant_text", { text: part?.text ?? null });
    }
    case "get_messages":
      return ok(cmd.id, "get_messages", { messages });
    case "set_session_name": {
      if (!nameModel) {
        sessionName = cmd.name;
        return ok(cmd.id, "set_session_name", null);
      }
      nameSetCalls++;
      if (nameSetCalls <= nameFault("fail")) {
        return out({ type: "response", id: cmd.id, command: "set_session_name", success: false, error: "name rejected" });
      }
      const delayMs = nameFault("delay");
      if (delayMs > 0) {
        setTimeout(() => writeName(cmd.name), delayMs);
      } else {
        writeName(cmd.name);
      }
      return ok(cmd.id, "set_session_name", null);
    }
    case "get_available_models":
      return ok(cmd.id, "get_available_models", {
        models: [
          { provider: "fake", id: "fake-model", contextWindow: 1000, reasoning: false },
          { provider: "fake", id: "fake-big", contextWindow: 9000, reasoning: true },
          { provider: "other", id: "fake-big", contextWindow: 9000, reasoning: true },
        ],
      });
    case "set_model":
      model = { provider: cmd.provider, id: cmd.modelId, contextWindow: 100000 };
      return ok(cmd.id, "set_model", model);
    case "get_session_stats":
      return ok(cmd.id, "get_session_stats", {
        sessionFile,
        sessionId,
        totalMessages: messages.length,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: messages.filter((m) => m.role === "assistant").length * 10 },
        cost: messages.filter((m) => m.role === "assistant").length * 0.001,
        contextUsage: { tokens: messages.length === 0 ? null : messages.length * 100, contextWindow: 100000, percent: messages.length * 0.1 },
      });
    case "set_thinking_level":
      thinkingLevel = cmd.level;
      return ok(cmd.id, "set_thinking_level", null);
    case "get_available_thinking_levels":
      return ok(cmd.id, "get_available_thinking_levels", { levels: ["off", "minimal", "low", "medium", "high"] });
    case "compact":
      compacting = true;
      out({ type: "compaction_start", reason: "manual" });
      await sleep(Number(process.env.FAKE_PI_COMPACT_MS ?? 0));
      compacting = false;
      if (process.env.FAKE_PI_COMPACT_ORPHANS_NAME === "1") {
        for (const e of nameEntries) {
          e.orphan = true;
        }
      }
      out({ type: "compaction_end", reason: "manual", result: { tokensBefore: 5000, estimatedTokensAfter: 800 }, aborted: false, willRetry: false });
      return ok(cmd.id, "compact", { summary: "s", firstKeptEntryId: "x", tokensBefore: 5000, estimatedTokensAfter: 800 });
    case "bash":
      // "sleep" commands stay running until abort_bash, like a long command would
      if (cmd.command === "sleep") {
        await new Promise((resolve) => {
          bashStop = resolve;
        });
        return ok(cmd.id, "bash", { output: "", exitCode: undefined, cancelled: true, truncated: false });
      }
      return ok(cmd.id, "bash", { output: `ran: ${cmd.command}\n`, exitCode: 0, cancelled: false, truncated: false });
    case "abort_bash":
      bashStop?.();
      return ok(cmd.id, "abort_bash", null);
    case "abort":
      aborted = true;
      if (process.env.FAKE_PI_ABORT_SETTLES_FIRST === "1") {
        // like pi: the run settles (with an error message) before the abort call is answered
        const err = { role: "assistant", content: [], stopReason: "error", errorMessage: "This operation was aborted" };
        out({ type: "message_start", message: err });
        out({ type: "message_end", message: err });
        streaming = false;
        out({ type: "agent_settled" });
        abortSettled = true;
      }
      return ok(cmd.id, "abort", null);
    case "get_commands":
      return ok(cmd.id, "get_commands", {
        commands: [
          { name: "skill:demo", description: "A demo skill", source: "skill" },
          { name: "compact", description: "Compact the context", source: "extension" },
          ...(process.env.FAKE_PI_JOBS === "1" ? [{ name: "toriel-background", description: "toriel: move the running foreground bash command(s) to the background", source: "extension" }] : []),
          ...(process.env.FAKE_PI_BRIDGE === "1" ? [{ name: "toriel-inject", description: "toriel internal: deliver a message from another session", source: "extension" }] : []),
        ],
      });
    case "clear_queue": {
      const steering = queue.splice(0, queue.length);
      queueUpdate();
      return ok(cmd.id, "clear_queue", { steering, followUp: [] });
    }
    case "prompt": {
      if (cmd.message === "/toriel-background") {
        ok(cmd.id, "prompt", { disposition: "handled" });
        return out({ type: "extension_ui_request", id: randomUUID(), method: "notify", message: "Moved to the background: j1 (fake)", notifyType: "info" });
      }
      if (cmd.message.startsWith("/toriel-inject ")) {
        ok(cmd.id, "prompt", { disposition: "handled" });
        const p = JSON.parse(cmd.message.slice("/toriel-inject ".length));
        if (process.env.FAKE_PI_BRIDGE_FAIL === "1") {
          return bridgeStatus({ kind: "failed", id: p.id, error: "inject refused" });
        }
        if (streaming) {
          bridgePending.push(p);
          return;
        }
        streaming = true;
        out({ type: "agent_start" });
        const { custom } = persistCustom(p);
        out({ type: "message_start", message: custom });
        out({ type: "message_end", message: custom });
        bridgeStatus({ kind: "injected", id: p.id });
        const assistant = { role: "assistant", content: [{ type: "text", text: `echo: ${p.text}` }], usage: { input: 6, output: 4, cacheRead: 5000, totalTokens: 5010, cost: { total: 0.001 } }, stopReason: "stop" };
        out({ type: "message_start", message: assistant });
        persist(assistant);
        out({ type: "message_end", message: assistant });
        streaming = false;
        return out({ type: "agent_settled" });
      }
      if (compacting) {
        return out({ type: "response", id: cmd.id, command: "prompt", success: false, error: "Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry." });
      }
      if (cmd.message.trim() === "/ask") {
        // a permission dialog pi settles by itself after its timeout, never answered by anyone
        ok(cmd.id, "prompt", { disposition: "started" });
        return out({ type: "extension_ui_request", id: "ask-1", method: "confirm", title: "Allow?", message: "run rm", ...(process.env.FAKE_PI_ASK_MS === "0" ? {} : { timeout: Number(process.env.FAKE_PI_ASK_MS ?? 300) }) });
      }
      if (cmd.message.trim() === "/ask-select") {
        // pi-permission-system's ask: a select dialog whose title names the command (long ones wrap across lines)
        ok(cmd.id, "prompt", { disposition: "started" });
        const command = process.env.FAKE_PI_ASK_COMMAND ?? "sudo -V";
        return out({
          type: "extension_ui_request",
          id: "ask-select-1",
          method: "select",
          title: `Permission Required\ntool    : bash\nrule    : sudo *\ncommand : ${command.replace(/(.{20})/g, "$1\n")}`,
          options: ["Yes", `Yes, allow bash "${command}" for this session`, "No", "No, provide reason"],
        });
      }
      if (cmd.message.trim() === "/mcp") {
        // like pi's extension command: answered as a notice, never entering the conversation
        ok(cmd.id, "prompt", { disposition: "started" });
        return out({
          type: "extension_ui_request",
          id: "mcp-status",
          method: "notify",
          message: "mealie: connected, 12 tools (direct)\nfreecad: failed (direct)\n    connection refused\nconfig error: bad.json",
          notifyType: "info",
        });
      }
      if (slow) {
        if (streaming) {
          queue.push(cmd.message);
          queueUpdate();
          return ok(cmd.id, "prompt", { disposition: "queued" });
        }
        ok(cmd.id, "prompt", { disposition: "started" });
        return slowPrompt(cmd.message);
      }
      ok(cmd.id, "prompt", { disposition: "started" });
      streaming = true;
      out({ type: "agent_start" });
      const user = { role: "user", content: cmd.message };
      out({ type: "message_start", message: user });
      persist(user);
      out({ type: "message_end", message: user });
      await sleep(Number(process.env.FAKE_PI_RUN_MS ?? 50));
      // "[turns N]" makes N-1 tool-call turns before the answer; "[hang]" runs until aborted (subagent limit tests)
      aborted = false;
      const turns = Number(/\[turns (\d+)\]/.exec(cmd.message)?.[1] ?? 1);
      for (let i = 1; i < turns && !aborted; i++) {
        const step = { role: "assistant", content: [{ type: "text", text: `step ${i}` }], usage: { input: 6, output: 4, cacheRead: 5000, totalTokens: 5010, cost: { total: 0.001 } }, stopReason: "toolUse" };
        out({ type: "message_start", message: step });
        persist(step);
        out({ type: "message_end", message: step });
        await sleep(30);
      }
      if (cmd.message.includes("[error]")) {
        // a run that fails on its own (no abort): the provider errors after the tool turns
        const failed = { role: "assistant", content: [], stopReason: "error", errorMessage: "provider exploded" };
        out({ type: "message_start", message: failed });
        out({ type: "message_end", message: failed });
        streaming = false;
        out({ type: "agent_settled" });
        return;
      }
      while (cmd.message.includes("[hang]") && !aborted) {
        await sleep(20);
      }
      if (aborted) {
        streaming = false;
        if (!abortSettled) {
          // an abort by the user ends the run with an "aborted" assistant message
          const stopped = { role: "assistant", content: [], stopReason: "aborted" };
          out({ type: "message_start", message: stopped });
          out({ type: "message_end", message: stopped });
          out({ type: "agent_settled" });
        }
        abortSettled = false;
        return;
      }
      const assistant = {
        role: "assistant",
        content: [{ type: "text", text: `echo: ${cmd.message}${cmd.images?.length ? ` [${cmd.images.length} image(s): ${cmd.images.map((i) => i.mimeType).join(",")}]` : ""}` }],
        usage: { input: 6, output: 4, cacheRead: 5000, totalTokens: 5010, cost: { total: 0.001 } },
        stopReason: "stop",
      };
      out({ type: "message_start", message: assistant });
      persist(assistant);
      out({ type: "message_end", message: assistant });
      streaming = false;
      out({ type: "agent_settled" });
      return;
    }
    default:
      return ok(cmd.id, cmd.type, null);
  }
}

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  for (let i = buf.indexOf("\n"); i !== -1; i = buf.indexOf("\n")) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line) {
      void handle(JSON.parse(line));
    }
  }
});
process.on("SIGTERM", () => process.exit(0));
if (process.env.FAKE_PI_STAY === "1") {
  // outlive a closed stdin, like a pi that is not told to stop (only SIGTERM ends it)
  setInterval(() => {}, 1000);
}
