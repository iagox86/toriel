// Subagents: real pi sessions the daemon starts on behalf of another session
// (the toriel_agent / toriel_agents tools), nested under it in the switcher.
// A foreground call holds its request open until the subagent settles and
// answers with its final text; a background call answers at once and the
// result arrives later as a message to the parent. Limits live in
// subagents.ts; this file starts, watches and stops the sessions.
import * as fs from "node:fs";
import type * as net from "node:net";
import { findAgent, type AgentProfile } from "./agents.ts";
import { SEED_GRANTS } from "./seed-grants.ts";
import { validateSubagentCwd } from "./subagent-cwd.ts";
import type { Cmd, DaemonContext, Responder } from "./daemon-context.ts";
import { removeSession } from "./daemon-handlers-lifecycle.ts";
import { deliverToTarget } from "./daemon-handlers-messages.ts";
import type { DaemonSession } from "./daemon-session.ts";
import { modelProblem } from "./model-match.ts";
import { detachFromParent, loadLineage, parentMap, recordSubagent, subagentDepth } from "./lineage.ts";
import { log } from "./log.ts";
import { formatReceived } from "./received.ts";
import { uniqueName } from "./session-id.ts";
import {
  childBudget,
  describeRecord,
  expiredSubagents,
  abnormalEnd,
  limitBreach,
  subagentResultText,
  messageTokens,
  parseHandle,
  refuseSpawn,
  resultText,
  SubagentBook,
  type SubagentLimits,
  type SweepCandidate,
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
  /** The outcome a stop asked for, by handle: it wins over the settle the abort causes. */
  private readonly forced = new Map<number, { state: SubagentState; note: string }>();

  /** How long a finished subagent stays in the switcher. */
  readonly keepMs: number;

  constructor(ctx: () => DaemonContext, limits: SubagentLimits, keepMs: number) {
    this.ctx = ctx;
    this.limits = limits;
    this.keepMs = keepMs;
  }

  /** The parent has the result: the switcher greys the row, and the grace window before deletion starts. */
  markDelivered(rec: SubagentRecord): void {
    rec.deliveredAt ??= Date.now();
    this.ctx().hub.broadcastSessions();
  }

  /**
   * Delete the subagents whose grace window has ended, the way /delete does (the file goes to the
   * trash, so /restore brings it back), and cut their lineage link so a restored one is top-level.
   * Works from lineage.json and file times, so it also catches subagents finished before a restart.
   */
  async sweep(now = Date.now()): Promise<void> {
    const ctx = this.ctx();
    const lineage = loadLineage();
    const mtime = (file: string | undefined): number => {
      try {
        return file ? fs.statSync(file).mtimeMs : 0;
      } catch {
        return 0;
      }
    };
    const cands: SweepCandidate[] = [];
    for (const [uuid, entry] of Object.entries(lineage)) {
      if (entry.kind !== "subagent") {
        continue;
      }
      const s = ctx.registry.all().find((x) => x.sessionId === uuid);
      const file = s?.sessionFile ?? ((entry.parent ? lineage[entry.parent.id]?.forks?.find((f) => f.id === uuid)?.file : undefined) || undefined);
      cands.push({ uuid, file, mtime: mtime(file), live: s?.child !== undefined || s?.spawning === true, record: this.book.byChild(uuid) });
    }
    let swept = false;
    for (const c of expiredSubagents(cands, now, this.keepMs)) {
      try {
        await removeSession(ctx, ctx.registry.all().find((x) => x.sessionId === c.uuid), c.file);
        log(`subagent session ${c.uuid} timed out of the switcher; its file is in the trash`);
      } catch (err) {
        // the link stays, so the next sweep tries again instead of stranding the file
        log(`could not delete the finished subagent ${c.uuid}: ${errText(err)}`);
        continue;
      }
      detachFromParent(c.uuid);
      swept = true;
    }
    if (swept) {
      ctx.hub.broadcastSessions();
    }
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
  onMessage(s: DaemonSession, message: { role?: string; stopReason?: string; errorMessage?: string; usage?: { input?: number; output?: number; cacheWrite?: number } } | undefined): void {
    const rec = this.book.bySession(s.id);
    if (rec?.state !== "running" || message?.role !== "assistant") {
      return;
    }
    // the empty message pi ends an aborted or failed run with is not a turn of work
    if (message.stopReason !== "error" && message.stopReason !== "aborted") {
      rec.turns++;
    }
    rec.tokens += messageTokens(message.usage);
    rec.lastStop = message.stopReason;
    rec.lastError = message.errorMessage;
    this.ctx().hub.broadcastSessions(); // the budget figure in the UI moves with each message
    const why = limitBreach({ turns: rec.turns, maxTurns: rec.maxTurns, tokens: rec.tokens, budget: rec.budget, continuing: message.stopReason === "toolUse" });
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
    // said before the abort: the run settles on its own as soon as it is aborted, and that settle must not win as a plain "done"
    this.forced.set(rec.handle, { state, note });
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
    // a stop in progress decides the outcome; otherwise a run that settled on an error or an abort is not a "done"
    const forced = this.forced.get(rec.handle);
    const abnormal = state === "done" && !forced ? abnormalEnd(rec.lastStop, rec.lastError) : undefined;
    rec.state = forced?.state ?? abnormal?.state ?? state;
    rec.note = forced?.note ?? abnormal?.note ?? note ?? rec.note;
    rec.endedAt = Date.now();
    this.forced.delete(rec.handle);
    const ctx = this.ctx();
    const child = ctx.registry.get(rec.session);
    try {
      if (child?.child) {
        rec.result = subagentResultText((await child.child.getMessages()) as Array<{ role?: string; content?: unknown }>);
      }
    } catch (err) {
      log(`subagent #${rec.handle}: could not read its last answer: ${errText(err)}`);
    }
    this.settling.delete(rec.session);
    if (child?.child) {
      await ctx.children.deactivate(child);
    }
    log(`subagent #${rec.handle} (${rec.agent}) ${rec.state}${rec.note ? `: ${rec.note}` : ""}`);
    ctx.hub.broadcastSessions();
    for (const wake of this.ending.get(rec.handle) ?? []) {
      wake();
    }
    this.ending.delete(rec.handle);
  }

  /** Throws when `wanted` is not a model pi knows; if pi cannot be asked, the start goes ahead and pi's own error applies. */
  private async checkModel(parent: DaemonSession, wanted: string | undefined): Promise<void> {
    if (wanted === undefined || !parent.child) {
      return;
    }
    let models: Array<{ provider: string; id: string }>;
    try {
      models = await parent.child.getAvailableModels();
    } catch (err) {
      log(`could not check the subagent's model ${wanted}: ${errText(err)}`);
      return;
    }
    const problem = modelProblem(models, wanted);
    if (problem) {
      throw new Error(problem);
    }
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
    // fail now, with the valid names, rather than after the subagent's process has started and died on it;
    // before the limit check below, which must stay synchronous with creating the record
    await this.checkModel(parent, cmd.context === "fork" ? undefined : (cmd.model ?? base.model));
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
    const parentLeft = parentRec ? Math.max(0, parentRec.budget - parentRec.tokens) : undefined;
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
    // fail before the record exists rather than leaving the child on a dead directory; a child's scope root is its
    // cwd, so it must be inside the parent's cwd or a linked worktree of the same repo (delegating never widens)
    if (cmd.cwd !== undefined) {
      const check = validateSubagentCwd(cmd.cwd, parent.cwd);
      if (!check.ok) {
        throw new Error(check.error);
      }
    }
    // everything above is synchronous with the record below, so parallel calls cannot both slip past a limit
    const child = ctx.registry.create(cmd.cwd ?? parent.cwd);
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
        // stopped while it was starting: the process that just came up has no task and no lineage, so it goes
        // again, and with it the registry entry (pi writes the file on the first prompt, so there is none)
        await ctx.children.deactivate(child);
        ctx.registry.delete(child.id);
        ctx.hub.broadcastSessions();
        return rec;
      }
      rec.childId = child.sessionId;
      if (child.sessionId) {
        // copy the parent's active grants first (copySession keeps expiry and notes), then the seed
        // grants: a seed's add() replaces the same-pattern copy, so the read-only seed wins
        try {
          ctx.grants.copySession(parentUuid, child.sessionId);
        } catch (err) {
          log(`subagent #${rec.handle}: parent grants not inherited: ${errText(err)}`);
        }
        // a failure to seed is logged, never thrown: more prompting, never less
        for (const seed of SEED_GRANTS) {
          try {
            ctx.grants.add({ session: child.sessionId, surface: seed.surface, pattern: seed.pattern, source: "spawn" });
          } catch (err) {
            log(`subagent #${rec.handle}: seed grant ${seed.pattern} not added: ${errText(err)}`);
          }
        }
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
      this.markDelivered(rec);
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
    this.markDelivered(rec);
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
  ctx.subagents.markDelivered(rec);
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
      let onClose = (): void => {};
      const gone = new Promise<"gone">((resolve) => {
        onClose = () => resolve("gone");
        socket.once("close", onClose);
      });
      const outcome = await Promise.race([Promise.all(targets.map((r) => ctx.subagents.whenEnded(r))).then(() => "ended" as const), timeout, gone]);
      clearTimeout(timer);
      socket.off("close", onClose);
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
