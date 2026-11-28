import { log } from "../core/log";
import {
  type AssignmentRow,
  agentOf,
  assignmentOf,
  openTurn,
} from "../host/desk-read";
import {
  monthBudgetOf,
  projectBudgetOf,
  spendingStopOf,
} from "../host/spending";
import { instructionsFor } from "../memory/instructions";
import { readMatterBook } from "../memory/matters";
import { readPeople } from "../memory/who";
import { dayNow } from "../memory/zones";
import type { Desk } from "./desk-store";

// The spending stop (the v4 plan, bundle E): where one piece of work stops and asks him, at its wake (`spendingStopNow`,
// the clock's) or inside a pi turn (`spendingStopInTurn`, the door's `/spending`). A one-off project's cap (a `budget`
// instruction scoped to it, the owner's decisions of 28 Nov 2026) holds over all of its agents' work on it.

/** A wake that asks him about a piece of work at its spending stop. */
export const SPENDING_STOP = "spending_stop";

/** A wake at the spending stop, with what the desk tells the agent. */
export interface SpendingStop {
  line: string;
}

/** What each running turn was billed so far, by turn id, as pi's `/spending` reports it (this process only, a restart cuts the turns): sibling turns count each other's live cost. */
const liveUsd = new Map<number, number>();

/** A turn that asked him at its stop: a wake at it, or a turn the stop ended inside (`stopped_spending`). */
const IS_STOP = "(cause = ?1 or stopped_spending is not null)";

/**
 * Where a piece of work stands against its stop: assignment `id`, or with `project` a capped project, all its agents'
 * assignments pooled (the owner's decision of 28 Nov 2026: a project's approval and live cost are the project's). What
 * it was billed, running turns' live cost included; how many of its stops he answered (his answer after them; one the
 * stop ended inside answers nothing); whether a stop on a still open assignment waits for his answer.
 */
function spentOf(db: Desk["db"], scope: { id: string } | { project: string }) {
  const turns =
    "project" in scope
      ? "select * from turn where assignment_id in (select s.id from assignment s join agent a on a.id = s.agent_id where a.project = ?2)"
      : "select * from turn where assignment_id = ?2";
  const r = db
    .query<
      { answered: number; open: string; usd: number; waits: number },
      [string, string]
    >(
      `with t as (${turns}), last as (select coalesce(max(id), 0) as id from t where cause = 'answer' and stopped_spending is null)
      select coalesce(sum(cost_usd), 0) + coalesce(sum(search_usd), 0) as usd,
        coalesce(sum(${IS_STOP} and t.id < last.id), 0) as answered,
        coalesce(max(${IS_STOP} and t.id > last.id and assignment_id in (select id from assignment where closed_at is null)), 0) as waits,
        coalesce(json_group_array(case when ended_at is null then json_array(t.id, coalesce(cost_usd, 0) + coalesce(search_usd, 0)) end), '[]') as open
      from t, last`
    )
    .get(SPENDING_STOP, "project" in scope ? scope.project : scope.id);
  // A running turn counts what it reported live past what is stored of it (a reminded turn's first run is stored).
  const live = (
    JSON.parse(r?.open ?? "[]") as ([number, number] | null)[]
  ).reduce(
    (sum, t) => sum + (t ? Math.max(0, (liveUsd.get(t[0]) ?? 0) - t[1]) : 0),
    0
  );
  return {
    answered: r?.answered ?? 0,
    usd: (r?.usd ?? 0) + live,
    waits: Boolean(r?.waits),
  };
}

/**
 * Where assignment `s` stands against its spending stop (`spendingStopOf`), for a wake that is not his answer, over
 * each scope its work answers to (the owner's decision of 28 Nov 2026: both, the lower stops it): its agent's project's
 * cap, over the project; its matter's own budget, or with no cap the default, over the assignment. `waits` once one
 * asked him at its stop and he has not answered; a stop to ask at when what it was billed reached its stop again (each
 * answer to a stop gives it one more); null otherwise.
 */
export async function spendingStopNow(
  db: Desk["db"],
  s: AssignmentRow,
  monthly: number | undefined
): Promise<SpendingStop | "waits" | null> {
  const project = agentOf(db, s.agent_id)?.project ?? undefined;
  const cap = project ? projectBudgetOf(project)?.text : undefined;
  const own = s.matter_id
    ? instructionsFor({ matter: s.matter_id }).find(
        (i) => i.effect === "budget"
      )?.text
    : undefined;
  const scopes = [
    ...(project && cap
      ? [{ budget: cap, spent: spentOf(db, { project }) }]
      : []),
    ...(cap && !own ? [] : [{ budget: own, spent: spentOf(db, s) }]),
  ];
  if (scopes.some((x) => x.spent.waits)) {
    return "waits";
  }
  for (const { budget, spent } of scopes) {
    const base = spendingStopOf(monthly, false, budget);
    if (base === undefined || spent.usd < base * (spent.answered + 1)) {
      continue;
    }
    // Read only at the stop: whether he marked its matter important, which triples it.
    const isImportant =
      !budget &&
      s.matter_id !== null &&
      // biome-ignore lint/performance/noAwaitInLoops: at most two scopes, read only past a stop
      (await readMatterBook(await readPeople(), dayNow())).some(
        (v) => v.id === s.matter_id && v.important
      );
    const stop =
      (spendingStopOf(monthly, isImportant, budget) ?? base) *
      (spent.answered + 1);
    if (spent.usd >= stop) {
      return {
        line: `This work has been billed ${spent.usd.toFixed(2)} dollars, past its spending stop of ${stop.toFixed(2)}. End this turn with what you have and ask one card about the work, not the money ("Finding a clinic is taking longer than usual. Keep going?"), with what was spent as its context's last line. Until it is answered, nothing wakes you but the answer.`,
      };
    }
  }
  return null;
}

/** What a running turn is told when another turn of its work already asked him at their stop: end, ask nothing. */
const WAITS_LINE =
  "This work is at its spending stop and another turn already asked him about it. End this turn now with your notes; ask no card. Nothing wakes you but his answer.";

/**
 * The spending stop inside agent `agent`'s running turn (pi's extension asks after each tool call: `/spending`), `usd`
 * what the turn was billed so far: the stop's line, which ends the turn (the extension then runs only the door's tools,
 * for its notes and its card), when its assignment reached its stop; null otherwise, and for the main session or no
 * turn. The turn keeps its cause and counts as asked at its stop (`stopped_spending`), so only his answer wakes the work.
 */
export async function spendingStopInTurn(
  { db }: Desk,
  agent: string,
  usd: number
) {
  const t = openTurn(db, agent);
  const s = t && assignmentOf(db, t.assignment_id);
  // The turn asking at the stop goes on to its card.
  if (
    !(t && s) ||
    agentOf(db, agent)?.role === "main" ||
    t.cause === SPENDING_STOP ||
    t.stopped_spending
  ) {
    return null;
  }
  for (const id of liveUsd.keys()) {
    if (
      !db.query("select 1 from turn where id = ? and ended_at is null").get(id)
    ) {
      liveUsd.delete(id);
    }
  }
  liveUsd.set(t.id, usd);
  const stop = await spendingStopNow(db, s, monthBudgetOf()?.monthly);
  if (!stop) {
    return null;
  }
  if (stop === "waits") {
    log("desk.turn", { agent, turn: t.id, what: "spending_stop.waits" });
    return WAITS_LINE;
  }
  db.run("update turn set stopped_spending = 1 where id = ?", [t.id]);
  log("desk.turn", { agent, turn: t.id, what: "spending_stop.in_turn" });
  return stop.line;
}
