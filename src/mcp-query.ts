// The /mcp question of a session (ticket 346): pi answers as a notice - the
// toriel-mcp extension's pending list while its servers connect, pi's own list
// once they have - so the question arms one swallow tap shared by its askers.
// The tap outlives the pending answer: it holds one outstanding shot per /mcp
// prompt of the child still out, and goes when every shot's answer arrived (or
// the caps spent them). A stopped or replaced child takes everything with it,
// so a new ask meets the new child and keeps its notices.
import type { RpcClient } from "@earendil-works/pi-coding-agent";
import { parseMcpStatus } from "./mcp.ts";
import { MCP_PENDING_COMMAND, MCP_PENDING_MARK } from "../pi/extensions/lib/mcp-config.ts";
import { errText } from "./util.ts";
import { log } from "./log.ts";

/** pi's own answer when no server is configured: recognized by shape too, so the tap leaves before the cap expires. */
const NO_SERVERS_TEXT = "No MCP servers configured";

/** The words pi's own status line starts with after the server name (`name: state ...`): what separates a real status from
 *  another extension's notice, which the loose `name: text` line grammar would otherwise swallow as an answer (review of batch 4).
 *  `closed` too: pi's runtime can leave a server there, and one unrecognized state line would fail the whole text (round 2).
 *  A state word must end at its edge: nothing, a comma, a colon, an ellipsis, or pi's ` (<exposure>)` tail - a space in front of
 *  plain words like in `something: connected to remote` or `something: failed to load` stays out (review round 2). */
const SERVER_STATES = ["connected", "starting", "connecting", "closed", "disabled", "disconnected", "needs sign-in", "failed"];
const STATE_DETAIL = new RegExp(`^(?:${SERVER_STATES.join("|")})($|[,:(\u2026]| ?\\()`);

/** The unindented lines pi's /mcp prints about the configuration, not about one server: an answer made only of these is one all the same. */
const CONFIG_LINES = ["config error: ", "overridden: "];

const serverState = (detail: string): boolean => STATE_DETAIL.test(detail);

/**
 * The text of an /mcp answer: the pending list behind its mark, or text whose
 * unindented lines are all of pi's /mcp grammar - a server line whose detail
 * starts with a state word, or a `config error: `/`overridden: ` line. Undefined
 * for any other notify: pi's (or the extension's) problem report, or an
 * unrelated notice, which the tap must let past instead of eating as a late
 * answer.
 */
export function mcpAnswerOf(text: string): string | undefined {
  if (text.startsWith(MCP_PENDING_MARK)) {
    return text.slice(MCP_PENDING_MARK.length);
  }
  if (text.startsWith(NO_SERVERS_TEXT)) {
    return text;
  }
  const unindented = text.split("\n").filter((line) => line.length > 0 && !/^\s/.test(line));
  if (unindented.length === 0) {
    return undefined;
  }
  const ofGrammar = (line: string): boolean => {
    if (CONFIG_LINES.some((config) => line.startsWith(config))) {
      return true;
    }
    const servers = parseMcpStatus(line);
    return servers.length === 1 && serverState(servers[0].detail);
  };
  return unindented.every(ofGrammar) ? text : undefined;
}

/** What an /mcp question needs from the daemon around it: how to ask a child, and whether a child may be asked the pending command (a child without the toriel-mcp extension would hear it as a model turn). The errors its askers read come with it. */
export interface McpQueriesEnv {
  prompt: (child: RpcClient, text: string) => Promise<void>;
  hasPendingCommand: (child: RpcClient) => Promise<boolean>;
  /** The error an asker reads when the question runs to its cap. */
  capError: string;
  /** The error an asker reads when the child is gone before an answer. */
  dropError: string;
}

/** One in-flight question of a session: the askers share its promise, and its timers bound the wait. */
export interface McpQuery {
  child: RpcClient;
  /** The pending-command grace; cleared when the question settles, whatever settled it. */
  grace: NodeJS.Timeout;
  /** Ends the question's wait with the honest error. */
  cap: NodeJS.Timeout;
  promise: Promise<string>;
  resolve: (text: string) => void;
  reject: (err: Error) => void;
}

/** The swallow tap that catches a question's answer: made for one child, so a replaced child's notices never reach it. */
export interface McpTap {
  child: RpcClient;
  /** Called with every notice of the child; true when the tap took it (the question's answer, or the answer pending until then). */
  take: (text: string) => boolean;
}

interface Question extends McpQuery {
  /** The tap record the question asks through: a give-up of the question spends one outstanding shot of it. */
  record: TapRecord;
  /** Any settle: stops the question's timers and takes it out of the share and the record's waiting list. */
  settle: (ok: boolean, value: string | Error) => void;
}

/** The tap of a session with its bookkeeping: the questions an answer still has to serve, and one shot per /mcp prompt of the
 *  child that is still out, in prompt order - each shot is spent at most once, by its own answer, its cap or a prompt error,
 *  and the tap retires when no shot is left (review round 4: a settled question's cap must not spend a shot twice, or a
 *  shared tap can retire early and pi's next answer leaks to controllers as a raw notice). */
interface TapRecord extends McpTap {
  waiting: Question[];
  shots: Question[];
}

/**
 * The /mcp questions of every session. One is in flight per session and a
 * second asker shares its answer instead of asking again. When the pending
 * answer resolved the askers while pi's own /mcp is still out, a further ask of
 * the same child joins the still-armed tap: it pushes its own shot instead of
 * replacing it (review round 2), so each answer pi sends is
 * the tap's to swallow and neither one leaks raw to the controllers. The
 * pending answer resolves the askers at once and takes the question out of the
 * share; the tap stays until every outstanding prompt's answer arrived, or a
 * give-up spent the last shot. `drop` is for a child that went away: its
 * askers get an error, and the new child keeps every notice.
 */
export class McpQueries {
  private readonly env: McpQueriesEnv;
  /** Unresolved questions, by session id. */
  private readonly questions = new Map<number, Question>();
  /** The tap of the question in flight, or one its pending answer already resolved; by session id. */
  private readonly taps = new Map<number, TapRecord>();

  constructor(env: McpQueriesEnv) {
    this.env = env;
  }

  /** The promise an ask shares, while one question is unresolved for `id`; undefined when a fresh ask should start. */
  shared(id: number): Promise<string> | undefined {
    return this.questions.get(id)?.promise;
  }

  /** Whether a notify of `child` was taken as the session's answer: only a tap made for exactly this child takes it. */
  accept(id: number, child: RpcClient | undefined, text: string): boolean {
    if (child === undefined) {
      return false;
    }
    const tap = this.taps.get(id);
    return tap !== undefined && tap.child === child && tap.take(text);
  }

  /** Ask the child and wait for its answer through that child's notices. A question already in flight answers instead. */
  ask(id: number, child: RpcClient, graceMs: number, capMs: number): Promise<string> {
    const running = this.questions.get(id);
    if (running) {
      return running.promise;
    }
    let resolve!: (text: string) => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<string>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const prior = this.taps.get(id);
    const joined = prior !== undefined && prior.child === child;
    // the asks of one child share its tap: a further ask while pi still has an /mcp out joins its tap with its own shot rather
    // than making a new one, so every answer pi sends stays swallowed and no asker's notice misses it
    const done = { settled: false };
    const settle = (ok: boolean, value: string | Error): void => {
      if (done.settled) {
        return;
      }
      done.settled = true;
      clearTimeout(question.grace);
      // the cap is NOT cleared here: for a question the pending answer settled early, it is the only bound on the shot pi still
      // holds - hung real answers otherwise leave the tap eating notices forever (review round 2); a spent timer on a question
      // whose shot is gone is nothing, for giveUp splices its question out of the record's shot list and answers shift it out
      if (this.questions.get(id) === question) {
        this.questions.delete(id);
      }
      const at = question.record.waiting.indexOf(question);
      if (at >= 0) {
        question.record.waiting.splice(at, 1);
      }
      if (ok) {
        resolve(value as string);
      } else {
        reject(value as Error);
      }
    };
    const question: Question = { child, promise, resolve, reject, grace: undefined!, cap: undefined!, record: undefined!, settle };
    const tap = joined ? prior! : this.newTap(id, child, question);
    question.record = tap;
    if (joined) {
      tap.shots.push(question); // its own shot rides the tap, in prompt order (pi answers its /mcp prompts first in, first out)
    }
    tap.waiting.push(question);
    // pi's /mcp waits for every server's connect before it answers (ticket 346): when it is slow, the extension lists the
    // registered servers as connecting at once - through its own command, which only a child that has it hears
    question.grace = setTimeout(() => {
      void this.env
        .hasPendingCommand(child)
        .then(async (has) => {
          if (has && !done.settled) {
            return this.env.prompt(child, `/${MCP_PENDING_COMMAND}`);
          }
          return undefined;
        })
        .catch((err: unknown) => log(`${MCP_PENDING_COMMAND} failed: ${errText(err)}`));
    }, graceMs);
    question.grace.unref();
    question.cap = setTimeout(() => {
      settle(false, new Error(this.env.capError));
      this.giveUp(id, tap, question);
    }, capMs);
    question.cap.unref();
    this.questions.set(id, question);
    this.env.prompt(child, "/mcp").catch((err: unknown) => {
      settle(false, err instanceof Error ? err : new Error(errText(err)));
      this.giveUp(id, tap, question);
      clearTimeout(question.cap); // the shot is spent; its bound is done
    });
    return promise;
  }

  /** The session's child went away: both the question and its tap are gone with it, and an unresolved asker reads why. */
  drop(id: number): void {
    const question = this.questions.get(id);
    if (question) {
      question.settle(false, new Error(this.env.dropError));
    }
    this.taps.delete(id);
  }

  /** The swallow tap, armed for exactly this child: it starts with its ask's shot, the /mcp prompt that ask sent. */
  private newTap(id: number, child: RpcClient, first: Question): TapRecord {
    const tap: TapRecord = { child, waiting: [], shots: [first], take: undefined! };
    tap.take = (text) => {
      if (text.startsWith(MCP_PENDING_MARK)) {
        // the extension's list of registered servers: the asker it belongs to is answered now, but the tap stays for pi's
        // own answer - the question leaves the share (a new ask starts fresh), its grace is done and its cap stays to bound
        // its shot's swallow window, and the shot still rides in the record's list
        const waiting = tap.waiting[0];
        if (waiting) {
          waiting.settle(true, text.slice(MCP_PENDING_MARK.length));
        }
        return true;
      }
      const answer = mcpAnswerOf(text);
      if (answer === undefined) {
        return false;
      }
      // pi's own answer, whatever pace its connects kept: it spends the oldest shot only (its own question's cap therefore
      // spends nothing), the oldest waiting asker takes the text, and no shot left takes the tap with it
      const spent = tap.shots.shift();
      if (spent) {
        clearTimeout(spent.cap);
      }
      const waiting = tap.waiting.shift();
      if (waiting) {
        waiting.settle(true, answer);
      }
      if (tap.shots.length === 0 && this.taps.get(id) === tap) {
        this.taps.delete(id);
      }
      return true;
    };
    this.taps.set(id, tap);
    return tap;
  }

  /** A give-up (the question's cap, or an /mcp prompt that never reached the child) spends the question's own shot, only once; nobody left means the tap retires. */
  private giveUp(id: number, tap: TapRecord, question: Question): void {
    const at = tap.shots.indexOf(question);
    if (at >= 0) {
      tap.shots.splice(at, 1);
    }
    if (tap.shots.length === 0 && this.taps.get(id) === tap) {
      this.taps.delete(id);
    }
  }
}
