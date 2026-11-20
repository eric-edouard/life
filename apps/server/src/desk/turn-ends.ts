import { clock, MIN } from "../core/clock";
import { log } from "../core/log";
import {
  type AgentRow,
  type AssignmentRow,
  activeAgents,
  agentOf,
  assignmentOf,
  isWaiting,
  lastTurns,
  modelOf,
  openTurn,
  type TurnRow,
  turnOf,
} from "../host/desk-read";
import type { TurnOutcome } from "../records/registered-agent";
import { commitAgentFiles, keepHanded, stopOpenRun } from "./agent-actions";
import {
  BEGIN_WITHIN_MS,
  defaultWaitOf,
  failuresOf,
  isBeginLate,
  MAX_HANDED,
} from "./agent-wait";
import { doorOf } from "./desk-door";
import { closeAssignmentRow, type Desk, writeWait } from "./desk-store";
import type {
  Run,
  RunEnd,
  Runtime,
  Agent as SessionAgent,
  Usage,
} from "./runtimes/contract";

// How a desk turn ends (the desk spec, section 6): its run watched (`watch`) until it ends (`turnEnded`), by turn id, so
// a late end never closes another turn; the turns lost to a restart or that never began. The clock (`desk-clock.ts`)
// starts them.

const REMINDER =
  "Before you stop, call `set_wait` (what you wait for, until when) or `finish`.";

const now = () => clock().toISOString();

/** What a session of `a` is given: its door, its folder, its title ("Agent: <name>", the name he gave it, else his brief's first line), the model it runs with. */
export const sessionAgentOf = (a: AgentRow): SessionAgent => ({
  ...modelOf(a),
  door: doorOf(a.id),
  folder: a.folder,
  id: a.id,
  title: `Agent: ${a.name ?? (a.brief.trim().split("\n")[0] ?? "").slice(0, 60)}`,
});

/** The turns whose run this process watches end (`Run.ended`): any other open turn was started before a restart. */
const watched = new WeakMap<Desk["db"], Set<number>>();
function watchedIn(db: Desk["db"]) {
  const turns = watched.get(db) ?? new Set<number>();
  watched.set(db, turns);
  return turns;
}

/**
 * Marks turn `turn` under way, once, and counts a try for each event queued before it was written (what it was handed):
 * a turn that never began (offline, out of quota) counts none, so it drops nothing, nor one already ended (a late `begun`).
 */
const markBegun = (db: Desk["db"], turn: number) =>
  db.transaction(() => {
    const t = db
      .query<Pick<TurnRow, "assignment_id" | "started_at">, [number]>(
        "select assignment_id, started_at from turn where id = ? and begun_at is null and ended_at is null"
      )
      .get(turn);
    if (!t) {
      return;
    }
    db.run("update turn set begun_at = ? where id = ?", [now(), turn]);
    db.run(
      "update event set handed = handed + 1 where assignment_id = ? and received_at <= ? and consumed_at is null and dropped_at is null",
      [t.assignment_id, t.started_at]
    );
  })();

/** Ends turn `turn` when `run` does: failed when it did. */
export function watch(desk: Desk, turn: number, run: Run) {
  watchedIn(desk.db).add(turn);
  // A run that ends before it begins is `ended`'s to say; `begun` settles soon after `ended` at the latest, and is waited
  // for, so a turn that began and then failed is retried, never ended as not started.
  const begun = run.begun.then(
    () => markBegun(desk.db, turn),
    () => undefined
  );
  run.ended
    .then(async (end) => {
      await begun;
      return turnEnded(desk, turn, end);
    })
    .catch((error: unknown) =>
      log("desk.runtime", {
        error: String(error),
        ok: false,
        turn,
        what: "end",
      })
    );
}

/**
 * Ends a turn, once (a turn already ended is left as it is): its handed events consumed when it waited or finished,
 * else handed again later, and dropped once handed to `MAX_HANDED` turns that began.
 */
function close(
  desk: Desk,
  t: TurnRow,
  outcome: TurnOutcome,
  usage: Usage | undefined
) {
  const { db } = desk;
  watchedIn(db).delete(t.id);
  const ended = db.run(
    "update turn set ended_at = ?, outcome = ?, tokens_in = ?, tokens_cached = ?, tokens_out = ?, context_used = ? where id = ? and ended_at is null",
    [
      now(),
      outcome,
      usage?.tokensIn ?? null,
      usage?.tokensCached ?? null,
      usage?.tokensOut ?? null,
      usage?.contextLast ?? null,
      t.id,
    ]
  ).changes;
  keepHanded(db, t, ended > 0 && outcome !== "failed");
  if (ended === 0) {
    return false;
  }
  db.run(
    outcome === "waited" || outcome === "finished"
      ? "update event set consumed_at = ? where assignment_id = ? and handed > 0 and consumed_at is null and dropped_at is null"
      : `update event set dropped_at = ? where assignment_id = ? and handed >= ${MAX_HANDED} and consumed_at is null and dropped_at is null`,
    [now(), t.assignment_id]
  );
  return true;
}

/**
 * An assignment whose first turn failed before it began is closed, not retried, with why (`why_not_started`; its agent
 * ended when it has no other open): nothing is left running, its matter is free for a new start. Its only turn is `t`,
 * which never began.
 */
function endNotStarted({ db }: Desk, t: TurnRow, why: string) {
  if (lastTurns(db, t.assignment_id, 2).length !== 1 || t.begun_at) {
    return false;
  }
  closeAssignmentRow(db, t.assignment_id, {
    outcome: null,
    whyNotStarted: why,
  });
  return true;
}

/** After a failed turn of `s`: once its retries are spent, the default wait stands. */
function afterFailure({ db }: Desk, a: AgentRow, s: AssignmentRow) {
  if (isWaiting(a, s) && failuresOf(lastTurns(db, s.id)) >= MAX_HANDED) {
    writeWait(db, s.id, defaultWaitOf(s, clock().getTime()), true);
  }
}

/**
 * The run of desk turn `turn` ended (`failed` when it did); nothing when that turn is already closed, so a late end never
 * touches the turn after it. A turn ends by `set_wait` or `finish`; with neither, the desk reminds it once, then sets
 * the default wait. The turn's tokens are the run's own (`RunEnd.usage`).
 */
export async function turnEnded(desk: Desk, turn: number, end: RunEnd) {
  const { db } = desk;
  const t = turnOf(db, turn);
  const a = t && !t.ended_at && agentOf(db, t.agent_id);
  const s = a && assignmentOf(db, t.assignment_id);
  if (!(t && a && s)) {
    return;
  }
  const { usage } = end;
  // The session's first call, once: from the first run that reports one, whether or not that turn is reminded.
  if (typeof usage?.contextFirst === "number" && t.session) {
    db.run(
      "update session set context_at_first_call = ? where ref = ? and context_at_first_call is null",
      [usage.contextFirst, t.session]
    );
  }
  if (!end.ok) {
    db.transaction(() => {
      if (
        close(desk, t, "failed", usage) &&
        !endNotStarted(
          desk,
          t,
          end.why ?? "its first turn ended before it began"
        )
      ) {
        afterFailure(desk, a, s);
      }
    })();
  } else if (t.outcome === "waited" || t.outcome === "finished") {
    close(desk, t, t.outcome, usage);
  } else if (await isReminded(desk, t, a)) {
    return;
  } else {
    db.transaction(() => {
      if (close(desk, t, "default_wait", usage) && isWaiting(a, s)) {
        writeWait(db, s.id, defaultWaitOf(s, clock().getTime()), true);
      }
    })();
  }
  commitAgentFiles(a, s);
}

/** Reminds turn `t` of `a` once to set a wait or finish, when it ended with neither: whether it was (the turn then runs on). */
async function isReminded(desk: Desk, t: TurnRow, a: AgentRow) {
  const runtime = desk.runtimes[a.runtime];
  // Only an agent still active is reminded: one he stopped mid-turn gets no extra run.
  if (!t.reminded_at && a.status === "active" && a.session && runtime) {
    // Marked before it is sent, so a turn ending at once is never reminded twice.
    desk.db.run("update turn set reminded_at = ? where id = ?", [now(), t.id]);
    try {
      watch(
        desk,
        t.id,
        await runtime.send(sessionAgentOf(a), a.session, REMINDER)
      );
      return true;
    } catch (error) {
      log("desk.runtime", {
        agent: a.id,
        error: String(error),
        ok: false,
        what: "remind",
      });
    }
  }
  return false;
}

/** Runs `f` on each active agent's open desk turn, with its runtime, all at once. */
const eachOpenTurn = (
  desk: Desk,
  f: (a: AgentRow, t: TurnRow, runtime: Runtime | undefined) => Promise<void>
) =>
  Promise.all(
    activeAgents(desk.db).flatMap((a) => {
      const t = openTurn(desk.db, a.id);
      return t ? [f(a, t, desk.runtimes[a.runtime])] : [];
    })
  );

/**
 * Ends the desk turns this process does not watch and whose runtime runs nothing now (started before the helper or the
 * Mac stopped): by its outcome when it set a wait or finished, else failed and retried. One still running (a session of
 * his, or a killed turn's CLI not yet exited) is left to the begin limit; a runtime that can't say now is looked at
 * again at the next poll.
 */
export async function endLostTurns(desk: Desk) {
  const watching = watchedIn(desk.db);
  await eachOpenTurn(desk, async (a, t, runtime) => {
    if (watching.has(t.id)) {
      return;
    }
    const state =
      t.session && runtime
        ? await runtime.state(t.session).catch(() => null)
        : "gone";
    if (state === "idle" || state === "gone") {
      await turnEnded(desk, t.id, { ok: !!t.outcome });
      await stopOpenRun(desk, a.id, t);
    }
  });
}

/**
 * Ends each desk turn launched and not begun within `BEGIN_WITHIN_MS` (`isBeginLate`): a hung launch (a door that never
 * connects, a stuck adapter). The turn is ended first (a first turn: its agent not started, its matter freed; a later
 * one failed, retried), then its run stopped, whose end then finds the turn closed.
 */
export async function endUnbegunTurns(desk: Desk) {
  const at = clock().getTime();
  await eachOpenTurn(desk, async (a, t, runtime) => {
    if (!(runtime && isBeginLate(t, at))) {
      return;
    }
    await turnEnded(desk, t.id, {
      ok: false,
      why: `it did not begin within ${BEGIN_WITHIN_MS / MIN} minutes`,
    });
    await stopOpenRun(desk, a.id, t);
  });
}
