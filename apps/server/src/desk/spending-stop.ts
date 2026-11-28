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

/** What a stop counts: one assignment's turns, or a capped project's (every assignment of its agents). */
type Spender = { assignment: string } | { project: string };

/**
 * What `of`'s turns were billed, how many asked at its stop (a wake at it, or a turn it ended inside,
 * `stopped_spending`), and the last of those and of his answers (one the stop ended inside answers nothing).
 */
const spentOf = (db: Desk["db"], of: Spender) =>
  db
    .query<
      {
        answered: number | null;
        asked: number | null;
        stops: number;
        usd: number;
      },
      [string, string]
    >(
      `select coalesce(sum(cost_usd), 0) + coalesce(sum(search_usd), 0) as usd, coalesce(sum(cause = ?1 or stopped_spending is not null), 0) as stops, max(case when cause = ?1 or stopped_spending is not null then id end) as asked, max(case when cause = 'answer' and stopped_spending is null then id end) as answered from turn where ${"project" in of ? "assignment_id in (select s.id from assignment s join agent a on a.id = s.agent_id where a.project = ?2)" : "assignment_id = ?2"}`
    )
    .get(SPENDING_STOP, "project" in of ? of.project : of.assignment);

/** The `budget` instruction assignment `s`'s work answers to: its matter's, else, on no matter, its agent's project's cap; who it counts over. */
function budgetOf(db: Desk["db"], s: AssignmentRow) {
  if (s.matter_id) {
    const text = instructionsFor({ matter: s.matter_id }).find(
      (i) => i.effect === "budget"
    )?.text;
    return { of: { assignment: s.id }, text };
  }
  const project = agentOf(db, s.agent_id)?.project;
  const cap = project ? projectBudgetOf(project) : undefined;
  return cap && project
    ? { of: { project }, text: cap.text }
    : { of: { assignment: s.id }, text: undefined };
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
  const { of, text: budget } = budgetOf(db, s);
  const spent = spentOf(db, of);
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
