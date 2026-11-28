import { clock } from "../core/clock";
import { log } from "../core/log";
import {
  type AssignmentRow,
  agentOf,
  assignmentOf,
  openTurn,
} from "../host/desk-read";
import { turnsSpentOn } from "../host/desk-turn-reads";
import { DECISION_ANSWERED } from "../host/events";
import {
  matterBudgetOf,
  monthBudgetOf,
  projectBudgetOf,
  spendingStopOf,
} from "../host/spending";
import type { Decision } from "../memory/decision-lines";
import { readMatterBook } from "../memory/matters";
import { spendsOfTurn } from "../memory/spends";
import { readPeople } from "../memory/who";
import { dayNow } from "../memory/zones";
import type { Desk } from "./desk-store";
import { liveUsageOf, turnWithUsageOf } from "./turn-usage";

// The spending stop (the v4 plan, bundle E; its rework, the owner's "Re-plan, then rebuild" of 28 Nov 2026): where a
// piece of work stops and asks him. A stop is a row of `spending_stop` on its scope, a one-off project with a cap (a
// `budget` instruction scoped to it: all its agents' work) or one assignment; at most one open per scope (a unique
// index). It is claimed in the transaction that writes the turn told to ask (`claimSpendingStop`: the clock's wake, or
// inside a pi turn, the door's `/spending`), bound to the one card that turn asks with a `raises` option (the door's
// `request_decision`), and closed by his answer to that card alone (`settleSpendingStops`): only his pick of `raises`,
// alone, in his own app, gives the scope one more stop; a lapse or a withdrawal leaves it open to be asked again; his
// other answers ("Stop here") leave the work stopped until his word.

/** A wake that asks him about a piece of work at its spending stop. */
export const SPENDING_STOP = "spending_stop";

/** A wake at the spending stop, with what the desk tells the agent. */
export interface SpendingStop {
  line: string;
}

/** A scope whose work a stop counts (`project:<id>` or `assignment:<id>`), and its stop in billed dollars before his raises. */
export interface StopScope {
  scope: string;
  usd: number;
}

interface StopRow {
  answered_at: string | null;
  assignment_id: string;
  decision_id: string | null;
  raised: number;
  turn_id: number | null;
}

/** What `scope`'s work was billed (`spendsOfTurn`, billed and reported), a running turn's run so far included (`liveUsageOf`). */
function spentOf(desk: Desk, scope: string) {
  const at = clock().toISOString();
  return turnsSpentOn(desk.db, scope).reduce((usd, t) => {
    const live = t.ended_at ? undefined : liveUsageOf(desk, t.id);
    const row = live ? turnWithUsageOf(t, live) : t;
    return spendsOfTurn({ ...row, ended_at: row.ended_at ?? at }).reduce(
      (n, s) => n + (s.basis === "billed" ? (s.usd ?? 0) : 0),
      usd
    );
  }, 0);
}

const stopsOf = (db: Desk["db"], scope: string) =>
  db
    .query<StopRow, [string]>(
      "select assignment_id, turn_id, decision_id, answered_at, raised from spending_stop where scope = ? order by id"
    )
    .all(scope);

/** Its stop now: each raise of his gives one more. */
const stopOf = (x: StopScope, rows: StopRow[]) =>
  x.usd * (rows.filter((r) => r.raised).length + 1);

/**
 * The scopes assignment `s`'s work answers to, in the order they are claimed (the owner's decision of 28 Nov 2026:
 * both, the lower stops it): its agent's project's cap, over the project; its matter's own budget, or with no cap the
 * default, over the assignment. Whether its matter is important (which triples the default) is read only past the stop.
 */
export async function readStopScopes(
  desk: Desk,
  s: AssignmentRow,
  monthly: number | undefined
): Promise<StopScope[]> {
  const project = agentOf(desk.db, s.agent_id)?.project ?? undefined;
  const cap = project ? projectBudgetOf(project)?.text : undefined;
  const own = s.matter_id ? matterBudgetOf(s.matter_id)?.text : undefined;
  const scopes = [
    ...(project && cap ? [{ budget: cap, scope: `project:${project}` }] : []),
    ...(cap && !own ? [] : [{ budget: own, scope: `assignment:${s.id}` }]),
  ];
  const out: StopScope[] = [];
  for (const { budget, scope } of scopes) {
    const usd = spendingStopOf(monthly, false, budget);
    if (usd === undefined) {
      continue;
    }
    const isPast =
      !budget &&
      s.matter_id !== null &&
      spentOf(desk, scope) >= stopOf({ scope, usd }, stopsOf(desk.db, scope));
    const isImportant =
      isPast &&
      // biome-ignore lint/performance/noAwaitInLoops: at most two scopes, read only past a stop
      (await readMatterBook(await readPeople(), dayNow())).some(
        (v) => v.id === s.matter_id && v.important
      );
    out.push({
      scope,
      usd: isImportant ? (spendingStopOf(monthly, true) ?? usd) : usd,
    });
  }
  return out;
}

const lineOf = (spent: number, stop: number) =>
  `This work has been billed ${spent.toFixed(2)} dollars, past its spending stop of ${stop.toFixed(2)}. End this turn with what you have and ask one card about the work, not the money ("Finding a clinic is taking longer than usual. Keep going?"), with what was spent as its context's last line, and the option that goes on marked \`raises: true\`. Until it is answered, nothing wakes you but the answer.`;

const isRunning = (db: Desk["db"], turn: number) =>
  Boolean(
    db.query("select 1 from turn where id = ? and ended_at is null").get(turn)
  );

/**
 * Claims the stop of the first of `scopes` past it for turn `turn` of assignment `s`, synchronously (run inside the
 * transaction that writes the turn): the line telling the turn to ask, when it holds the scope's open stop (one it
 * opened now, one it already holds, or one whose turn ended or went without its card); `waits` when another turn holds
 * that open stop, its card is asked, or he answered the scope's last stop without a raise ("Stop here": stopped until
 * his word); null when under every stop.
 */
export function claimSpendingStop(
  desk: Desk,
  s: AssignmentRow,
  turn: number,
  scopes: readonly StopScope[]
): SpendingStop | "waits" | null {
  const { db } = desk;
  const now = clock().toISOString();
  for (const x of scopes) {
    const rows = stopsOf(db, x.scope);
    const open = rows.find((r) => r.answered_at === null);
    const spent = () => spentOf(desk, x.scope);
    if (open) {
      const isMine = open.turn_id === turn && open.assignment_id === s.id;
      if (
        !isMine &&
        (open.decision_id !== null ||
          (open.turn_id !== null && isRunning(db, open.turn_id)))
      ) {
        return "waits";
      }
      db.run(
        "update spending_stop set assignment_id = ?, turn_id = ?, stopped_at = ? where scope = ? and answered_at is null",
        [s.id, turn, now, x.scope]
      );
      return { line: lineOf(spent(), stopOf(x, rows)) };
    }
    const stop = stopOf(x, rows);
    const usd = spent();
    if (usd < stop) {
      continue;
    }
    if (rows.at(-1)?.raised === 0) {
      return "waits";
    }
    db.run(
      "insert into spending_stop (scope, assignment_id, turn_id, stopped_at) values (?, ?, ?, ?)",
      [x.scope, s.id, turn, now]
    );
    return { line: lineOf(usd, stop) };
  }
  return null;
}

/** Whether his answer to `d` raises the stop it was asked at: its `raises` option picked alone, with no words, in his own app (`via` connector). */
const isRaiseOf = (d: Pick<Decision, "answer" | "options">) =>
  d.answer?.via === "connector" &&
  !d.answer.note &&
  d.answer.options.length === 1 &&
  d.options.some((o) => o.raises && o.id === d.answer?.options[0]);

/**
 * His answer to card `d`, or its lapse or withdrawal (`name`, the decision event), on the stop it was asked at, if any:
 * answered, it closes the stop, raised only by his `raises` pick (`isRaiseOf`; a later answer after his Undo writes
 * again; his Undo takes the raise back, `stopWithdrawn`); lapsed or withdrawn, the stop stays open with no card and no turn, so it is asked again.
 */
export function settleSpendingStops(
  db: Desk["db"],
  name: string,
  d: Pick<Decision, "answer" | "id" | "options">
) {
  if (name === DECISION_ANSWERED) {
    db.run(
      "update spending_stop set answered_at = ?, raised = ? where decision_id = ?",
      [d.answer?.at ?? clock().toISOString(), isRaiseOf(d) ? 1 : 0, d.id]
    );
    return;
  }
  db.run(
    "update spending_stop set decision_id = null, turn_id = null where decision_id = ? and answered_at is null",
    [d.id]
  );
}

/**
 * Binds card `decision`, when it has a `raises` option, to the open stop its agent's running turn holds on assignment
 * `home`: in the card's own write. Throws when there is none: `raises` is only for the card a stop asks for.
 */
export function bindSpendingStopCard(
  db: Desk["db"],
  decision: string,
  options: readonly { [mark: string]: unknown }[] | undefined,
  home: AssignmentRow
) {
  if (!options?.some((o) => o.raises === true)) {
    return;
  }
  const turn = openTurn(db, home.agent_id)?.id;
  const bound =
    turn !== undefined &&
    db.run(
      "update spending_stop set decision_id = ? where turn_id = ? and assignment_id = ? and decision_id is null and answered_at is null",
      [decision, turn, home.id]
    ).changes > 0;
  if (!bound) {
    throw new Error(
      "Not done: a `raises` option is only for the card this turn asks at its work's spending stop."
    );
  }
}

/** What a running turn is told when its work waits at its stop (another turn asks, or he said to stop): end, ask nothing. */
const WAITS_LINE =
  "This work is at its spending stop and waits for his word. End this turn now with your notes; ask no card.";

/**
 * The spending stop inside agent `agent`'s running turn (pi's extension asks before each tool call: `/spending`): the
 * line that ends the turn (the extension then runs only the door's tools, for its notes and its card) when its work is
 * past its stop or waits at it; null otherwise, for the main session, a turn woken at the stop (it goes on to its card)
 * or no turn.
 */
export async function spendingStopInTurn(desk: Desk, agent: string) {
  const { db } = desk;
  const t = openTurn(db, agent);
  const s = t && assignmentOf(db, t.assignment_id);
  if (
    !(t && s) ||
    agentOf(db, agent)?.role === "main" ||
    t.cause === SPENDING_STOP
  ) {
    return null;
  }
  const scopes = await readStopScopes(desk, s, monthBudgetOf()?.monthly);
  const stop = db.transaction(() => claimSpendingStop(desk, s, t.id, scopes))();
  if (!stop) {
    return null;
  }
  log("desk.turn", {
    agent,
    turn: t.id,
    what: stop === "waits" ? "spending_stop.waits" : "spending_stop.in_turn",
  });
  return stop === "waits" ? WAITS_LINE : stop.line;
}
