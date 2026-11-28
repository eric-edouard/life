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

/**
 * What assignment `id`'s turns were billed (with `project`, a capped project's: every assignment of its agents), how
 * many of its own turns asked at its stop (a wake at it, or a turn it ended inside, `stopped_spending`), and the last
 * of those and of his answers (one the stop ended inside answers nothing): his answer to a stop is the assignment's own.
 */
function spentOf(db: Desk["db"], id: string, project?: string) {
  const own = db
    .query<
      {
        answered: number | null;
        asked: number | null;
        stops: number;
        usd: number;
      },
      [string, string]
    >(
      "select coalesce(sum(cost_usd), 0) + coalesce(sum(search_usd), 0) as usd, coalesce(sum(cause = ?1 or stopped_spending is not null), 0) as stops, max(case when cause = ?1 or stopped_spending is not null then id end) as asked, max(case when cause = 'answer' and stopped_spending is null then id end) as answered from turn where assignment_id = ?2"
    )
    .get(SPENDING_STOP, id);
  const pooled =
    project &&
    db
      .query<{ usd: number }, [string]>(
        "select coalesce(sum(cost_usd), 0) + coalesce(sum(search_usd), 0) as usd from turn where assignment_id in (select s.id from assignment s join agent a on a.id = s.agent_id where a.project = ?)"
      )
      .get(project);
  return own && pooled ? { ...own, usd: pooled.usd } : own;
}

/**
 * The `budget` instruction assignment `s`'s work answers to: its agent's project's cap, counted over the project, the
 * ceiling of all its work (a matter's own budget included); else its matter's.
 */
function budgetOf(db: Desk["db"], s: AssignmentRow) {
  const project = agentOf(db, s.agent_id)?.project ?? undefined;
  const cap = project ? projectBudgetOf(project)?.text : undefined;
  if (cap) {
    return { project, text: cap };
  }
  return {
    text: s.matter_id
      ? instructionsFor({ matter: s.matter_id }).find(
          (i) => i.effect === "budget"
        )?.text
      : undefined,
  };
}

/**
 * Where assignment `s` stands against its spending stop (`spendingStopOf`), for a wake that is not his answer: `waits`
 * once it asked him at its stop and he has not answered; a stop to ask at when what its work was billed (a capped
 * project's: all of it, `budgetOf`), and `turnUsd` (a running turn's so far, `spendingStopInTurn`), reached the stop
 * again (each answer to a stop gives it one more); null otherwise.
 */
export async function spendingStopNow(
  db: Desk["db"],
  s: AssignmentRow,
  monthly: number | undefined,
  turnUsd = 0
): Promise<SpendingStop | "waits" | null> {
  const { project, text: budget } = budgetOf(db, s);
  const spent = spentOf(db, s.id, project);
  if (!spent) {
    return null;
  }
  const r = { ...spent, usd: spent.usd + turnUsd };
  if (r.asked !== null && r.asked > (r.answered ?? 0)) {
    return "waits";
  }
  const base = spendingStopOf(monthly, false, budget);
  if (base === undefined || r.usd < base * (r.stops + 1)) {
    return null;
  }
  // Read only at the stop: whether he marked its matter important, which triples it.
  const isImportant =
    !budget &&
    s.matter_id !== null &&
    (await readMatterBook(await readPeople(), dayNow())).some(
      (v) => v.id === s.matter_id && v.important
    );
  const stop =
    (spendingStopOf(monthly, isImportant, budget) ?? base) * (r.stops + 1);
  return r.usd < stop
    ? null
    : {
        line: `This work has been billed ${r.usd.toFixed(2)} dollars, past its spending stop of ${stop.toFixed(2)}. End this turn with what you have and ask one card about the work, not the money ("Finding a clinic is taking longer than usual. Keep going?"), with what was spent as its context's last line. Until it is answered, nothing wakes you but the answer.`,
      };
}

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
  if (!(t && s) || agentOf(db, agent)?.role === "main") {
    return null;
  }
  const stop = await spendingStopNow(db, s, monthBudgetOf()?.monthly, usd);
  if (!stop || stop === "waits") {
    return null;
  }
  db.run("update turn set stopped_spending = 1 where id = ?", [t.id]);
  log("desk.turn", { agent, turn: t.id, what: "spending_stop.in_turn" });
  return stop.line;
}
