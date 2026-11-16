// The shift+tab mode cycle (ticket 233): normal -> auto -> plan -> normal, like Claude Code's mode key. The two switches (auto mode,
// plan mode) are separate flags the daemon keeps, and the cycle makes them exclusive: a key press never leaves both on.

export type Mode = "normal" | "auto" | "plan";

/** The slice of a session's meta the cycle reads. */
export interface ModeMeta {
  auto?: boolean;
  plan?: boolean;
  /** Plan mode is a marker named by the session's id, so a session with none yet (nothing sent) cannot enter it. */
  sessionId?: string;
}

/** The mode a session is in: plan wins when both flags are on (it is the stricter one). */
export function modeOf(m: ModeMeta): Mode {
  return m.plan ? "plan" : m.auto ? "auto" : "normal";
}

/** The mode one key press moves to. Plan is skipped for a session that cannot enter it yet. */
export function nextMode(m: ModeMeta): Mode {
  switch (modeOf(m)) {
    case "normal":
      return "auto";
    case "auto":
      return m.sessionId === undefined ? "normal" : "plan";
    case "plan":
      return "normal";
  }
}

/** The flag changes that reach `to` from `m`, in the order to send them (plan first: it can be refused, and auto is only dropped once it is on). Nothing for a flag that is already right. */
export function switches(m: ModeMeta, to: Mode): Array<{ flag: "auto" | "plan"; on: boolean }> {
  const out: Array<{ flag: "auto" | "plan"; on: boolean }> = [];
  const want = { auto: to === "auto", plan: to === "plan" };
  if ((m.plan === true) !== want.plan) {
    out.push({ flag: "plan", on: want.plan });
  }
  if ((m.auto === true) !== want.auto) {
    out.push({ flag: "auto", on: want.auto });
  }
  return out;
}
