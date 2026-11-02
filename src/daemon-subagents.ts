// Subagents: real pi sessions the daemon starts on behalf of another session
// (the toriel_agent / toriel_agents tools), nested under it in the switcher.
// A foreground call holds its request open until the subagent settles and
// answers with its final text; a background call answers at once and the
// result arrives later as a message to the parent. Limits live in
// subagents.ts; this file starts, watches and stops the sessions.
import type * as net from "node:net";
import { findAgent, type AgentProfile } from "./agents.ts";
import type { Cmd, DaemonContext, Responder } from "./daemon-context.ts";
import { deliverToTarget } from "./daemon-handlers-messages.ts";
import type { DaemonSession } from "./daemon-session.ts";
import { loadLineage, parentMap, recordSubagent, subagentDepth } from "./lineage.ts";
import { log } from "./log.ts";
import { formatReceived } from "./received.ts";
import { uniqueName } from "./session-id.ts";
import {
  childBudget,
  describeRecord,
  limitBreach,
  parseHandle,
  refuseSpawn,
  resultText,
  SubagentBook,
  type SubagentLimits,
  type SubagentRecord,
  type SubagentState,
} from "./subagents.ts";
import { errText } from "./util.ts";

const NO_UUID = "00000000-0000-0000-0000-000000000000";
const DEFAULT_WAIT_MS = 5 * 60_000;

export class SubagentManager {
  readonly book = new SubagentBook();
  readonly limits: SubagentLimits;
  private readonly ctx: () => DaemonContext;
  /** Resolvers of whoever waits for a record to end, by handle. */
  private readonly ending = new Map<number, Array<() => void>>();
  /** Resolvers of the run a subagent was just given, by daemon session number. */
  private readonly settling = new Map<number, () => void>();
  /** Handles being stopped, so two stops (a limit and a cancel) do not both abort. */
  private readonly stopping = new Set<number>();

  constructor(ctx: () => DaemonContext, limits: SubagentLimits) {
    this.ctx = ctx;
    this.limits = limits;
  }

  /** Resolves when the record is no longer running. */
  whenEnded(rec: SubagentRecord): Promise<void> {
    if (rec.state !== "running") {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.ending.set(rec.handle, [...(this.ending.get(rec.handle) ?? []), resolve]);
    });
  }

  /** A session's run settled (called from the child manager). */
  onSettled(s: DaemonSession): void {
    const settle = this.settling.get(s.id);
    this.settling.delete(s.id);
    settle?.();
  }

  /** An assistant message finished in `s`: cut the subagent off when it went over its budget or turns. */
  onMessage(s: DaemonSession, message: { role?: string; stopReason?: string } | undefined): void {
    const rec = this.book.bySession(s.id);
    if (rec?.state !== "running" || message?.role !== "assistant") {
      return;
    }
    rec.turns++;
    const why = limitBreach({ turns: rec.turns, maxTurns: rec.maxTurns, tokens: s.totalTokens, budget: rec.budget, continuing: message.stopReason === "toolUse" });
    if (why) {
      void this.stop(rec, why, "limit");
    }
  }

  /** A session's process went away: if it was a subagent it is over, and its foreground subagents go with it. */
  onStopped(s: DaemonSession): void {
    const rec = this.book.bySession(s.id);
    if (rec?.state === "running") {
      void this.finish(rec, "stopped", "its session was stopped");
    }
    if (s.sessionId) {
      for (const r of this.book.ofParent(s.sessionId)) {
        if (r.state === "running" && !r.background) {
          void this.stop(r, "its parent session stopped");
        }
      }
    }
  }

  /** End a running subagent early: abort its run, keep what it said so far. */
  async stop(rec: SubagentRecord, note: string, state: SubagentState = "stopped"): Promise<void> {
    if (rec.state !== "running") {
      return;
    }
    if (this.stopping.has(rec.handle)) {
      return this.whenEnded(rec);
    }
    this.stopping.add(rec.handle);
    try {
      await this.ctx().registry.get(rec.session)?.child?.abort();
    } catch (err) {
      log(`subagent #${rec.handle}: abort failed: ${errText(err)}`);
    }
    await this.finish(rec, state, note);
  }

  /** Record the outcome once: take the final text, stop the process (the file stays), wake the waiters. */
  async finish(rec: SubagentRecord, state: SubagentState, note?: string): Promise<void> {
    if (rec.state !== "running") {
      return;
    }
    rec.state = state;
    rec.note = note ?? rec.note;
    rec.endedAt = Date.now();
    const ctx = this.ctx();
    const child = ctx.registry.get(rec.session);
    try {
      rec.result = (await child?.child?.getLastAssistantText()) ?? undefined;
    } catch (err) {
      log(`subagent #${rec.handle}: could not read its last answer: ${errText(err)}`);
    }
    this.settling.delete(rec.session);
    if (child?.child) {
      await ctx.children.deactivate(child);
    }
    log(`subagent #${rec.handle} (${rec.agent}) ${state}${rec.note ? `: ${rec.note}` : ""}`);
    ctx.hub.broadcastSessions();
    for (const wake of this.ending.get(rec.handle) ?? []) {
      wake();
    }
    this.ending.delete(rec.handle);
  }

  /** Create, launch and prompt a subagent for `parent`; the record is returned running (or already failed). */
  async start(parent: DaemonSession, cmd: Cmd<"agent_spawn">): Promise<SubagentRecord> {
    const ctx = this.ctx();
    const parentUuid = parent.sessionId as string;
    const base = findAgent(cmd.agent, parent.cwd);
    if (cmd.model !== undefined && !cmd.model.includes("/")) {
      throw new Error("model must be provider/id");
    }
    if (cmd.context === "fork" && cmd.model !== undefined) {
      throw new Error("model cannot be changed with context: fork (a fork keeps its parent's model)");
    }
    if (cmd.context === "fork" && !parent.sessionFile) {
      throw new Error("this session has no file to fork yet");
    }
    const refusal = refuseSpawn({
      limits: this.limits,
      book: this.book,
      parent: parentUuid,
      parentProfile: parent.agent,
      parentDepth: subagentDepth(parentUuid, parentMap(loadLineage())),
    });
    if (refusal) {
      throw new Error(refusal);
    }
    const parentRec = this.book.byChild(parentUuid);
    const parentLeft = parentRec ? Math.max(0, parentRec.budget - parent.totalTokens) : undefined;
    const budget = childBudget(base.budget, this.limits, parentLeft);
    const parentName = parent.sessionName ?? `session ${parentUuid.slice(0, 8)}`;
    const profile: AgentProfile = {
      ...base,
      model: cmd.model ?? base.model,
      prompt: [
        `You are a subagent of the session "${parentName}" (${parentUuid}), started to do one task. Your final message is returned to it as the result and it sees nothing else you do, so make that message complete and concise. Nobody can answer questions during your run; stay within the task.`,
        base.prompt,
        cmd.system,
      ]
        .filter((p) => p?.trim())
        .join("\n\n"),
    };
    // everything above is synchronous with the record below, so parallel calls cannot both slip past a limit
    const child = ctx.registry.create(parent.cwd);
    const taken = ctx.registry.all().flatMap((x) => (x.sessionName ? [x.sessionName] : []));
    const name = uniqueName(`${base.name}: ${cmd.description}`.slice(0, 60), taken);
    const rec = this.book.add({
      parent: parentUuid,
      session: child.id,
      childName: name,
      agent: base.name,
      description: cmd.description,
      background: cmd.background === true,
      budget,
      maxTurns: base.maxTurns,
    });
    log(`subagent #${rec.handle} (${base.name}) started for ${parentName}: ${cmd.description}`);
    try {
      await ctx.children.start(child, { agent: profile, name, forkPath: cmd.context === "fork" ? parent.sessionFile : undefined });
      if (rec.state !== "running") {
        return rec; // stopped while it was starting
      }
      rec.childId = child.sessionId;
      if (child.sessionId) {
        recordSubagent({ id: parentUuid, name: parentName, file: parent.sessionFile ?? "" }, { id: child.sessionId, name, file: child.sessionFile ?? "" });
      }
      const settled = new Promise<void>((resolve) => this.settling.set(child.id, resolve));
      await (child.child as NonNullable<DaemonSession["child"]>).prompt(cmd.task);
      void settled.then(() => this.finish(rec, "done"));
    } catch (err) {
      await this.finish(rec, "failed", errText(err));
    }
    ctx.hub.broadcastSessions();
    return rec;
  }

  /** Background results arrive as a message to the parent, which is started if it is idle on disk. */
  async deliver(rec: SubagentRecord): Promise<void> {
    const ctx = this.ctx();
    const parent = ctx.registry.all().find((s) => s.sessionId === rec.parent);
    if (!parent) {
      log(`subagent #${rec.handle}: its parent is gone, result not delivered`);
      return;
    }
    const verb = rec.state === "done" ? "finished" : rec.state === "failed" ? "failed" : "was cut short";
    const body = `Subagent #${rec.handle} (${rec.agent}: ${rec.description}) ${verb}.\n\n${resultText(rec)}`;
    try {
      await deliverToTarget(
        ctx,
        { id: parent.id, uuid: parent.sessionId, name: parent.sessionName, file: parent.sessionFile, cwd: parent.cwd, session: parent },
        formatReceived(rec.childName ?? rec.agent, rec.childId ?? NO_UUID, body),
      );
    } catch (err) {
      log(`subagent #${rec.handle}: could not deliver its result: ${errText(err)}`);
    }
  }
}

function parentSession(ctx: DaemonContext, from: string): DaemonSession {
  const parent = ctx.registry.all().find((s) => s.sessionId === from && s.child);
  if (!parent) {
    throw new Error("the session asking is not running here");
  }
  return parent;
}

/** `toriel_agent`: start a subagent. Foreground answers with its final text; a cancelled call (the socket closing) stops it. */
export async function handleAgentSpawn(ctx: DaemonContext, cmd: Cmd<"agent_spawn">, socket: net.Socket, res: Responder): Promise<void> {
  const parent = parentSession(ctx, cmd.from);
  // listened for before the start, which takes a while: a caller that gives up meanwhile must still stop the subagent
  let rec: SubagentRecord | undefined;
  let cancelled = false;
  const cancel = (): void => {
    cancelled = true;
    if (rec) {
      void ctx.subagents.stop(rec, "its parent cancelled the call");
    }
  };
  if (!cmd.background) {
    socket.once("close", cancel);
  }
  try {
    rec = await ctx.subagents.start(parent, cmd);
  } catch (err) {
    socket.off("close", cancel);
    throw err;
  }
  if (cmd.background) {
    void ctx.subagents.whenEnded(rec).then(() => ctx.subagents.deliver(rec as SubagentRecord));
    res(true, undefined, {
      handle: rec.handle,
      state: rec.state,
      text: `Started subagent #${rec.handle} (${rec.agent}) in the background. Its result arrives later as a message; toriel_agents can list, wait for or stop it.`,
    });
    return;
  }
  if (cancelled) {
    cancel();
  }
  await ctx.subagents.whenEnded(rec);
  socket.off("close", cancel);
  res(true, undefined, { handle: rec.handle, state: rec.state, text: resultText(rec) });
}

/** `toriel_agents`: list, status, wait, stop and result for the subagents one session started. */
export async function handleAgentsOp(ctx: DaemonContext, cmd: Cmd<"agents_op">, socket: net.Socket, res: Responder): Promise<void> {
  const mine = ctx.subagents.book.ofParent(cmd.from);
  const pick = (): SubagentRecord => {
    const handle = parseHandle(cmd.ref);
    if (handle === undefined) {
      throw new Error(`${cmd.action} needs an id such as #2`);
    }
    const rec = mine.find((r) => r.handle === handle);
    if (!rec) {
      throw new Error(`you have no subagent #${handle}${mine.length > 0 ? ` (yours: ${mine.map((r) => `#${r.handle}`).join(", ")})` : ""}`);
    }
    return rec;
  };
  switch (cmd.action) {
    case "list":
      res(true, undefined, { text: mine.length === 0 ? "No subagents started by this session." : mine.map((r) => describeRecord(r)).join("\n") });
      return;
    case "status":
      res(true, undefined, { text: describeRecord(pick()) });
      return;
    case "result": {
      const rec = pick();
      res(true, undefined, { state: rec.state, text: resultText(rec) });
      return;
    }
    case "stop": {
      const rec = pick();
      await ctx.subagents.stop(rec, "stopped by its parent");
      res(true, undefined, { state: rec.state, text: rec.state === "running" ? "Still running." : resultText(rec) });
      return;
    }
    case "wait": {
      const targets = cmd.ref ? [pick()] : mine.filter((r) => r.state === "running");
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), cmd.timeoutMs ?? DEFAULT_WAIT_MS);
      });
      // a caller that went away stops waiting; the subagents keep running
      const gone = new Promise<"gone">((resolve) => socket.once("close", () => resolve("gone")));
      const outcome = await Promise.race([Promise.all(targets.map((r) => ctx.subagents.whenEnded(r))).then(() => "ended" as const), timeout, gone]);
      clearTimeout(timer);
      if (outcome === "gone") {
        return;
      }
      const head = outcome === "timeout" ? "Timed out; still running:\n" : "";
      const only = targets.length === 1 ? targets[0] : undefined;
      const body = only && only.state !== "running" ? resultText(only) : targets.map((r) => describeRecord(r)).join("\n") || "Nothing is running.";
      res(true, undefined, { text: `${head}${body}` });
      return;
    }
  }
}
