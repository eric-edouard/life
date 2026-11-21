import { clock, MIN } from "../core/clock";
import { log } from "../core/log";
import { errorOf } from "../core/log-line";
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
import { ASK_SPOKEN } from "../host/events";
import { MOVE_NOTES } from "../host/move-read";
import type { TurnOutcome } from "../records/registered-agent";
import { notifyPhone } from "../sources/lifelog-push";
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
import {
  type Run,
  type RunEnd,
  type Runtime,
  type Agent as SessionAgent,
  SessionLive,
  type Usage,
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
 * The spoken asks it handed for the first time (`ask.spoken` never handed before), with its agent: one push each is due.
 */
const markBegun = (db: Desk["db"], turn: number) =>
  db.transaction(() => {
    const t = db
      .query<
        Pick<TurnRow, "agent_id" | "assignment_id" | "cause" | "started_at">,
        [number]
      >(
        "select agent_id, assignment_id, cause, started_at from turn where id = ? and begun_at is null and ended_at is null"
      )
      .get(turn);
    if (!t) {
      return;
    }
    db.run("update turn set begun_at = ? where id = ?", [now(), turn]);
    log("desk.turn", { assignment: t.assignment_id, phase: "begun", turn });
    // A move's notes turn is handed no event: they wait for the holder after the move.
    if (t.cause === MOVE_NOTES) {
      return;
    }
    const { asks } = db
      .query<{ asks: number }, [string, string, string]>(
        "select count(*) as asks from event where assignment_id = ? and name = ? and handed = 0 and received_at <= ? and consumed_at is null and dropped_at is null"
      )
      .get(t.assignment_id, ASK_SPOKEN, t.started_at) ?? { asks: 0 };
    db.run(
      "update event set handed = handed + 1 where assignment_id = ? and received_at <= ? and consumed_at is null and dropped_at is null",
      [t.assignment_id, t.started_at]
    );
    const agent = asks > 0 ? agentOf(db, t.agent_id) : undefined;
    return agent && { agent, asks };
  })();

/**
 * Tells him his spoken ask reached agent `a`, once its turn on it began (never while it is only queued): "<name> heard
 * you", its name, else "Personal" for that role, else "Your agent"; never his words or its brief (the push goes
 * through Apple).
 */
const pushHeard = (a: AgentRow) =>
  notifyPhone({
    body: "Your ask reached it.",
    title: `${a.name ?? (a.role === "personal" ? "Personal" : "Your agent")} heard you`,
  });

/** Ends turn `turn` when `run` does: failed when it did. */
export function watch(desk: Desk, turn: number, run: Run) {
  watchedIn(desk.db).add(turn);
  // A run that ends before it begins is `ended`'s to say; `begun` settles soon after `ended` at the latest, and is waited
  // for, so a turn that began and then failed is retried, never ended as not started.
  const begun = run.begun.then(
    () => {
      const heard = markBegun(desk.db, turn);
      // Not waited for: the turn's end never waits on the phone.
      for (let i = 0; heard && i < heard.asks; i += 1) {
        pushHeard(heard.agent);
      }
    },
    () => undefined
  );
  run.ended
    .then(async (end) => {
      await begun;
      return turnEnded(desk, turn, end);
    })
    .catch((error: unknown) =>
      log("desk.runtime", {
        ...errorOf(error),
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
    "update turn set ended_at = ?, outcome = ? where id = ? and ended_at is null",
    [now(), outcome, t.id]
  ).changes;
  keepHanded(db, t, ended > 0 && outcome !== "failed");
  if (ended === 0 || outcome === "notes") {
    return ended > 0;
  }
  log("desk.turn", {
    assignment: t.assignment_id,
    ok: outcome !== "failed",
    outcome,
    phase: "ended",
    tokensOut: usage?.tokensOut,
    turn: t.id,
  });
  db.run(
    outcome === "waited" || outcome === "finished"
      ? "update event set consumed_at = ? where assignment_id = ? and handed > 0 and consumed_at is null and dropped_at is null"
      : `update event set dropped_at = ? where assignment_id = ? and handed >= ${MAX_HANDED} and consumed_at is null and dropped_at is null`,
    [now(), t.assignment_id]
  );
  return true;
}

/** Adds a run's tokens to open turn `turn`'s (a reminded turn runs twice); its context is its last run's. */
function addUsage(db: Desk["db"], turn: number, usage: Usage | undefined) {
  if (usage) {
    db.run(
      "update turn set tokens_in = coalesce(tokens_in, 0) + ?, tokens_cached = coalesce(tokens_cached, 0) + ?, tokens_out = coalesce(tokens_out, 0) + ?, context_used = coalesce(?, context_used) where id = ? and ended_at is null",
      [
        usage.tokensIn,
        usage.tokensCached,
        usage.tokensOut,
        usage.contextLast,
        turn,
      ]
    );
  }
}

/**
 * An assignment whose first turn failed before it began is closed, not retried, with why (`why_not_started`; its agent
 * ended when it has no other open): nothing is left running, its matter is free for a new start. Its only turn is `t`,
 * which never began.
 */
function endNotStarted({ db }: Desk, t: TurnRow, why: string) {
  // A move's first turn that never began rolls the move back instead (`agent-moves.ts`).
  if (lastTurns(db, t.assignment_id, 2).length !== 1 || t.begun_at || t.move) {
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
 * the default wait. The turn's tokens are its runs' (`RunEnd.usage`).
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
  addUsage(db, t.id, usage);
  // A move's notes turn ends as written, however its run ended: no reminder, no default wait, no retry.
  if (t.cause === MOVE_NOTES) {
    close(desk, t, "notes", usage);
    commitAgentFiles(a, s);
    return;
  }
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

/**
 * Reminds turn `t` of `a` once to set a wait or finish, when it ended with neither: whether it was (the turn then runs
 * on). While his app holds the session the turn stays open, its outcome `default_wait` until the reminder is sent, so a
 * hold never closes it: `endLostTurns` sends it once the session is idle, after a restart too.
 */
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
      if (error instanceof SessionLive) {
        desk.db.run(
          "update turn set reminded_at = null, outcome = coalesce(outcome, 'default_wait') where id = ?",
          [t.id]
        );
        watchedIn(desk.db).delete(t.id);
        return true;
      }
      log("desk.runtime", {
        agent: a.id,
        ...errorOf(error),
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
 * Mac stopped): by its outcome when it set a wait or finished, else failed and retried; one whose reminder waits for his
 * app's hold (`isReminded`) is reminded. One still running (a session of his, or a killed turn's CLI not yet exited) is
 * left to the begin limit; a runtime that can't say now is looked at again at the next poll. A reminder that waits on an
 * agent stopped or ended since is dropped: its turn ends by its outcome (a wait or `finish` his app's session gave it,
 * else the default wait).
 */
export async function endLostTurns(desk: Desk) {
  const watching = watchedIn(desk.db);
  await Promise.all(
    desk.db
      .query<{ id: number }, []>(
        "select t.id from turn t join agent a on a.id = t.agent_id where t.ended_at is null and t.outcome is not null and a.status <> 'active'"
      )
      .all()
      .filter(({ id }) => !watching.has(id))
      .map(({ id }) => turnEnded(desk, id, { ok: true }))
  );
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
      // A reminder sent just now runs on: it is watched again.
      if (!watching.has(t.id)) {
        await stopOpenRun(desk, a.id, t);
      }
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
