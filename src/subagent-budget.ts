// How a running subagent's budget reads in the UI ("budget 38k/150k, turn 7/25"). Pure.
import { fmtTokens } from "./format.ts";

export interface BudgetFigures {
  tokens: number;
  budget: number;
  turns: number;
  maxTurns?: number;
}

/** From this share of the budget on, the figure is drawn as a warning. */
export const BUDGET_WARN = 0.8;

/** "budget 38k/150k" plus "turn 7/25" when its profile caps turns; says so when nothing is left to spend. */
export function budgetText(b: BudgetFigures): string {
  const turns = b.maxTurns !== undefined ? `, turn ${b.turns}/${b.maxTurns}` : "";
  if (b.budget <= 0) {
    return `budget none left${turns}`;
  }
  return `budget ${fmtTokens(b.tokens)}/${fmtTokens(b.budget)}${turns}`;
}

/** Whether to draw it as a warning: close to the token cap, or on the last turns. */
export function budgetNearCap(b: BudgetFigures): boolean {
  if (b.budget <= 0 || b.tokens >= b.budget * BUDGET_WARN) {
    return true;
  }
  return b.maxTurns !== undefined && b.turns >= b.maxTurns * BUDGET_WARN;
}
