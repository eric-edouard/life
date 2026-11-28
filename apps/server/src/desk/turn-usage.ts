import type { TurnSpent } from "../memory/spends";
import type { Desk } from "./desk-store";
import type { Run, Usage } from "./runtimes/contract";

// A desk turn's usage: one rule for adding a run's to the stored row (`turnWithUsageOf`, the turn's end and the spending
// stop's live count alike), and the run each watched turn runs now, for what it used so far (`liveUsageOf`).

/** A turn's usage columns, as stored and as spends read them. */
export type UsageColumns = Pick<
  TurnSpent,
  "cost_usd" | "search_usd" | "tokens_cached" | "tokens_in" | "tokens_out"
>;

/**
 * Turn `t` with one more run's usage `u` added (a reminded turn runs twice): its tokens add up; what it was billed, and
 * its searches' price, each from its first run, null once a run came without it (null plus anything stays null). Pure:
 * the row's write (`addUsage`) and the spending stop's live count (`spentOf`) alike.
 */
export function turnWithUsageOf<T extends UsageColumns>(t: T, u: Usage): T {
  const isFirst = t.tokens_in === null;
  const sum = (was: number | null, more: number | null | undefined) => {
    if (isFirst) {
      return more ?? null;
    }
    return was === null || more === null || more === undefined
      ? null
      : was + more;
  };
  return {
    ...t,
    cost_usd: sum(t.cost_usd, u.billedUsd),
    search_usd: sum(t.search_usd, u.searchUsd),
    tokens_cached: (t.tokens_cached ?? 0) + u.tokensCached,
    tokens_in: (t.tokens_in ?? 0) + u.tokensIn,
    tokens_out: (t.tokens_out ?? 0) + u.tokensOut,
  };
}

/** The run each watched turn runs now (a reminded turn's second), for what it used so far (`liveUsageOf`). */
const runs = new WeakMap<Desk["db"], Map<number, Run>>();
export function runsIn(db: Desk["db"]) {
  const r = runs.get(db) ?? new Map<number, Run>();
  runs.set(db, r);
  return r;
}

/** What turn `turn`'s running run used so far, not yet in its row (`turnWithUsageOf` adds it); none when none runs or its runtime can't say. */
export const liveUsageOf = (desk: Desk, turn: number) =>
  runsIn(desk.db).get(turn)?.usage?.();
