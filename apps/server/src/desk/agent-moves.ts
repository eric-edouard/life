import { clock, MIN } from "../core/clock";
import { log } from "../core/log";
import { errorOf } from "../core/log-line";
import {
  type AgentRow,
  type AssignmentRow,
  agentOf,
  anchorsOf,
  assignmentOf,
  currentAssignmentOf,
  isFull,
  openTurn,
} from "../host/desk-read";
import {
  assignmentOnMatter,
  type MatterOfRefs,
  MOVE_REASONS,
  type MoveFailure,
  type MoveRow,
  moveFirstTurnOf,
  moveOf,
  moveScopeOf,
  notesTurnsOf,
  runtimeBlocksOf,
  runtimeWordOf,
  shortNameOf,
  unfinishedMoves,
} from "../host/move-read";
import { decisionsNow } from "../memory/decisions";
import { readMatterBook } from "../memory/matters";
import { oneMatter } from "../memory/read-matters";
import { readPeople } from "../memory/who";
import { dayNow } from "../memory/zones";
import { type AgentChange, hasFixedSubject } from "../records/registered-agent";
import { insertAgent, stopOpenRun } from "./agent-actions";
import { type Desk, endWhenIdle, moveAssignment } from "./desk-store";
import { turnEnded } from "./turn-ends";

// A move (decision 78, his `hand_over`): a matter's assignment to a new agent on another runtime or to the agent he
// names (a matter move), or a whole agent to another runtime (a runtime switch). Every transition is here: apply, the
// old agent's notes turn, the commit, done, the rollback. Its phase is read, never stored (`movePhaseOf`). The holder
// changes only in a transaction (`moveAssignment`), so nothing is ever half-moved.

/** How long the old agent's notes turns may take, from his ask: then the move commits on the notes it has (his answer 1, best effort). */
const NOTES_WITHIN = 10 * MIN;
/** How long the new holder's first turn may take to begin, from the commit: then the move rolls back. */
const STARTING_WITHIN = 30 * MIN;

const now = () => clock().toISOString();

/** What the notes turn of move `ask` on assignment `assignment` is told, resuming the old agent's session: which work, where it goes, write the notes, then stop. */
export function notesMessageOf(
  db: Desk["db"],
  ask: string,
  assignment: string
) {
  const steps = anchorsOf(db, assignment);
  const which = steps.length
    ? `the matter of ${steps.join(", ")}`
    : "your own work (no matter)";
  const m = moveOf(db, ask);
  const to = m?.to_agent ? agentOf(db, m.to_agent) : null;
  const where = to
    ? `the ${shortNameOf(to)} agent`
    : `a new agent on ${runtimeWordOf(m?.to_runtime ?? "")}`;
  return `Woken by the desk: his word moves your work to ${where}. This turn's notes are for ${which} (assignment ${assignment}). Write them now with \`write_notes\`: where it stands, what you did, what you wait on and what comes next, so the next agent carries on from them. Then stop: this turn does nothing else.`;
}

/** What a move reads before apply's transaction: why its target runtime can't run now (`Runtime.block`). */
export interface HandOverFacts {
  blocked?: string;
  /** The matter its `steps` find (his `matter`, else the finder's), read before the transaction. */
  matter?: string;
  /** Which open matter an assignment's anchors find (`assignmentOnMatter`), read before the transaction. */
  matterOf?: MatterOfRefs;
}

/** Why his move is refused, from the desk's facts (its sentence, `MOVE_REASONS`); null when it may go. */
function refusalOf(
  desk: Desk,
  m: Pick<MoveRow, "assignment_id" | "to_agent" | "to_runtime">,
  from: AgentRow,
  facts: HandOverFacts
) {
  const { db } = desk;
  const busy = unfinishedMoves(db).some(
    (x) =>
      (m.assignment_id && x.assignment_id === m.assignment_id) ||
      [x.agent_id, x.to_agent].some(
        (id) => id && (id === from.id || id === m.to_agent)
      )
  );
  if (busy) {
    return MOVE_REASONS.underWay;
  }
  return m.to_agent
    ? toAgentRefusalOf(agentOf(db, m.to_agent), from)
    : toRuntimeRefusalOf(desk, m, from, facts);
}

/** Why a matter can't move to the agent he named (`to`): stopped, gone, one that takes no other subject (`hasFixedSubject`), or the one holding it. */
function toAgentRefusalOf(to: AgentRow | null, from: AgentRow) {
  if (to?.status === "stopped") {
    return MOVE_REASONS.stopped;
  }
  if (to?.status !== "active") {
    return MOVE_REASONS.agentEnded(to ? shortNameOf(to) : "other");
  }
  if (hasFixedSubject(to.role)) {
    return MOVE_REASONS.fixedSubject(shortNameOf(to));
  }
  return to.id === from.id ? MOVE_REASONS.withAgent(shortNameOf(to)) : null;
}

/** Why a matter or an agent can't move to runtime `m.to_runtime`: not the desk's, already on it, blocked; a switch of an agent not active; a new agent past the desk's cap. */
function toRuntimeRefusalOf(
  desk: Desk,
  m: Pick<MoveRow, "assignment_id" | "to_runtime">,
  from: AgentRow,
  facts: HandOverFacts
) {
  const runtime = m.to_runtime ?? "";
  if (!desk.runtimes[runtime]) {
    return `name a runtime: ${Object.keys(desk.runtimes).join(", ")}`;
  }
  if (runtime === from.runtime) {
    return MOVE_REASONS.already(runtime);
  }
  if (facts.blocked) {
    return MOVE_REASONS.blocked(runtime);
  }
  if (!m.assignment_id && from.status !== "active") {
    return from.status === "stopped"
      ? MOVE_REASONS.stopped
      : MOVE_REASONS.agentEnded(shortNameOf(from));
  }
  // A matter move to a runtime makes an agent; a switch takes no place.
  return m.assignment_id && isFull(desk.db) ? MOVE_REASONS.full : null;
}

/** What his `hand_over` moves: a matter's assignment (`steps` with a `runtime` or an `agent`), none for a switch (`agent` with a `runtime`), or why not. */
function movedAssignmentOf(
  db: Desk["db"],
  c: AgentChange,
  facts: HandOverFacts
): { error: string } | { assignment: AssignmentRow | null } {
  const isMatter = Boolean(c.steps) && Boolean(c.runtime) !== Boolean(c.agent);
  const isSwitch = !c.steps && Boolean(c.agent && c.runtime);
  if (!(isMatter || isSwitch)) {
    return { error: MOVE_REASONS.shape };
  }
  if (!c.steps) {
    return { assignment: null };
  }
  const assignment = assignmentOnMatter(
    db,
    { id: facts.matter, steps: c.steps },
    facts.matterOf ?? (() => undefined)
  );
  return assignment ? { assignment } : { error: MOVE_REASONS.noHolder };
}

/**
 * Applies his `hand_over` (`ask`), in apply's transaction: a matter's `steps` to a `runtime` or to the `agent` he names,
 * or an `agent` to a `runtime`. The move's row is written whether or not it is refused (reads find it by its matter or
 * agent); a refusal is the ask's `agent_change` error, as every ask's. The agent it moves from, or why not.
 */
export function applyHandOver(
  desk: Desk,
  ask: string,
  c: AgentChange,
  facts: HandOverFacts
): { error: string } | { id: string } {
  const { db } = desk;
  const found = movedAssignmentOf(db, c, facts);
  if ("error" in found) {
    return found;
  }
  const s = found.assignment;
  const from = agentOf(db, s?.agent_id ?? c.agent ?? "");
  if (!from) {
    return { error: `no registered agent ${c.agent ?? "named"}` };
  }
  const m = {
    assignment_id: s?.id ?? null,
    to_agent: s && c.agent ? c.agent : null,
    to_runtime: c.runtime ?? null,
  };
  db.run(
    "insert into move (ask, agent_id, assignment_id, to_agent, to_runtime, asked_at) values (?, ?, ?, ?, ?, ?)",
    [ask, from.id, m.assignment_id, m.to_agent, m.to_runtime, now()]
  );
  const refused = refusalOf(desk, m, from, facts);
  return refused ? { error: refused } : { id: from.id };
}

/** Assignment `id` due now, with why: its holder's next turn starts at the next wake. */
const dueNow = (db: Desk["db"], id: string, reason: string) =>
  db.run(
    "update assignment set wait_until = ?, wait_reason = ?, wait_is_default = 0 where id = ?",
    [now(), reason, id]
  );

/** Move `m` failed before its commit, or rolled back: why (`MoveFailure`). */
function fail(db: Desk["db"], m: MoveRow, failure: MoveFailure) {
  db.run("update move set failed = ?, failed_at = ? where ask = ?", [
    failure,
    now(),
    m.ask,
  ]);
  log("desk.move", { ask: m.ask, failure, ok: false });
}

/** The fence before a commit or a rollback: the run of `agent`'s open turn on what moves (`isMoving`) is stopped and its turn closed, so nothing runs beside the move. */
async function fenceOpenTurn(
  desk: Desk,
  agent: string,
  isMoving: (assignment: string) => boolean,
  why: string
) {
  const open = openTurn(desk.db, agent);
  if (open && isMoving(open.assignment_id)) {
    await stopOpenRun(desk, agent, open);
    await turnEnded(desk, open.id, { ok: false, why });
  }
}

/**
 * Whether agent `a`'s session is seen stopped (its runtime says idle or gone; none at all is), so a switch of its
 * runtime, either way, never leaves two sessions on one agent's door. Anything else, a failed look included, waits.
 */
async function isSessionDone(desk: Desk, a: AgentRow) {
  if (!a.session) {
    return true;
  }
  const state = await desk.runtimes[a.runtime]
    ?.state(a.session)
    .catch(() => null);
  return state === "idle" || state === "gone";
}

/** A matter move's commit: the agent he named, or a new one on its runtime in the old agent's folder, named after the matter (`name`); the matter's assignment moved to it and due now. */
function commitMatterMove(
  desk: Desk,
  m: MoveRow,
  from: AgentRow,
  name: string
) {
  const { db } = desk;
  if (m.to_agent && agentOf(db, m.to_agent)?.status !== "active") {
    return fail(db, m, "target_ended");
  }
  if (!m.to_agent && isFull(db)) {
    return fail(db, m, "desk_full");
  }
  if (!m.to_agent && runtimeBlocksOf(db)[m.to_runtime ?? ""]) {
    return fail(db, m, "target_blocked");
  }
  const decisions = decisionsNow();
  db.transaction(() => {
    const to =
      m.to_agent ??
      insertAgent(db, {
        brief: `The matter "${name}", moved to you at his word from the ${shortNameOf(from)} agent.`,
        folder: from.folder,
        name,
        runtime: m.to_runtime ?? "",
      }).id;
    moveAssignment(db, m.assignment_id ?? "", to, decisions);
    dueNow(db, m.assignment_id ?? "", "moved to you");
    db.run("update move set moved_at = ?, to_agent = ? where ask = ?", [
      now(),
      to,
      m.ask,
    ]);
  })();
}

/** A runtime switch's commit: what a rollback restores kept, its runtime set, its model, effort and session cleared (the next turn starts fresh from its packet), its current assignment due now. */
function commitSwitch(desk: Desk, m: MoveRow, a: AgentRow) {
  const { db } = desk;
  if (runtimeBlocksOf(db)[m.to_runtime ?? ""]) {
    return fail(db, m, "target_blocked");
  }
  db.transaction(() => {
    db.run(
      "update move set from_runtime = ?, from_model = ?, from_effort = ?, from_session = ?, from_link = ?, moved_at = ? where ask = ?",
      [a.runtime, a.model, a.effort, a.session, a.link, now(), m.ask]
    );
    db.run(
      "update agent set runtime = ?, model = null, effort = null, session = null, link = null where id = ?",
      [m.to_runtime, a.id]
    );
    db.run(
      "update session set ended_at = ?, why_ended = 'runtime' where agent_id = ? and ended_at is null",
      [now(), a.id]
    );
    db.run(
      "delete from handed_step where assignment_id in (select id from assignment where agent_id = ?)",
      [a.id]
    );
    dueNow(db, currentAssignmentOf(db, a.id)?.id ?? "", "its runtime changed");
  })();
}

/** The matter's name, for its new agent: the open matter its anchors find (the one he chose taking a tie), else its first step. */
async function matterNameOf(db: Desk["db"], assignment: string) {
  const steps = anchorsOf(db, assignment);
  const prefer = assignmentOf(db, assignment)?.matter_id ?? undefined;
  // The open matters, as the move found its assignment (`assignmentOnMatter`).
  const book = (await readMatterBook(await readPeople(), dayNow())).filter(
    (m) => m.open
  );
  return (
    (await oneMatter(steps, { book, prefer }))?.name ??
    steps[0] ??
    "moved matter"
  );
}

/**
 * The notes phase of move `m`: once every assignment it covers has its notes turn ended, or the old agent can't take one
 * (not active, no session, its runtime blocked), or `NOTES_WITHIN` passed, the turn still running on what moves is
 * fenced, then the commit. A matter that closed meanwhile fails the move; nothing moved.
 */
async function advanceNotes(desk: Desk, m: MoveRow) {
  const { db } = desk;
  if (m.assignment_id && assignmentOf(db, m.assignment_id)?.closed_at) {
    return fail(db, m, "matter_closed");
  }
  const a = agentOf(db, m.agent_id);
  if (!a) {
    return;
  }
  const written = new Set(
    notesTurnsOf(db, m).flatMap((t) => (t.ended_at ? [t.assignment_id] : []))
  );
  const isWritten = moveScopeOf(db, m).every((id) => written.has(id));
  const isLate = clock().getTime() - Date.parse(m.asked_at) > NOTES_WITHIN;
  const isSkipped =
    a.status !== "active" ||
    !a.session ||
    Boolean(runtimeBlocksOf(db)[a.runtime]);
  if (!(isWritten || isLate || isSkipped)) {
    return;
  }
  await fenceOpenTurn(
    desk,
    a.id,
    (id) => !m.assignment_id || id === m.assignment_id,
    "the move went on without it"
  );
  if (m.assignment_id) {
    return commitMatterMove(
      desk,
      m,
      a,
      await matterNameOf(db, m.assignment_id)
    );
  }
  // A switch keeps its agent's id and door: its old session must be seen stopped first.
  if (await isSessionDone(desk, a)) {
    commitSwitch(desk, m, a);
  }
}

/** Moves `m` back, in one transaction: the matter to its old holder (an agent made for the move ended), or the agent's old runtime, model, effort and session; due now for the old holder. */
function rollback(desk: Desk, m: MoveRow, failure: MoveFailure) {
  const { db } = desk;
  const decisions = decisionsNow();
  db.transaction(() => {
    if (m.assignment_id) {
      moveAssignment(db, m.assignment_id, m.agent_id, decisions);
      dueNow(db, m.assignment_id, "his move did not go");
      if (m.to_runtime && m.to_agent) {
        endWhenIdle(db, m.to_agent, "ended", "its move did not start");
      }
    } else {
      db.run(
        "update agent set runtime = ?, model = ?, effort = ?, session = ?, link = ? where id = ?",
        [
          m.from_runtime,
          m.from_model,
          m.from_effort,
          m.from_session,
          m.from_link,
          m.agent_id,
        ]
      );
      db.run(
        "update session set ended_at = ?, why_ended = 'rolled back' where agent_id = ? and ended_at is null",
        [now(), m.agent_id]
      );
      db.run(
        "update session set ended_at = null, why_ended = null where agent_id = ? and ref = ? and why_ended = 'runtime'",
        [m.agent_id, m.from_session]
      );
      dueNow(
        db,
        currentAssignmentOf(db, m.agent_id)?.id ?? "",
        "his move did not go"
      );
    }
    fail(db, m, failure);
  })();
}

/**
 * The starting phase of committed move `m`: its first turn ended without beginning, its holder stopped, or none began
 * within `STARTING_WITHIN` rolls it back (the turn fenced first). One that began is done (`unfinishedMoves` leaves it).
 */
async function advanceStarting(desk: Desk, m: MoveRow) {
  const { db } = desk;
  const holder = m.to_agent ?? m.agent_id;
  const first = moveFirstTurnOf(db, m);
  const isLate =
    clock().getTime() - Date.parse(m.moved_at ?? "") > STARTING_WITHIN;
  let failure: MoveFailure | null = null;
  if (first?.ended_at) {
    failure = "not_started";
  } else if (agentOf(db, holder)?.status !== "active") {
    failure = "stopped";
  } else if (isLate) {
    failure = "not_started";
  }
  if (!failure) {
    return;
  }
  await fenceOpenTurn(
    desk,
    holder,
    (id) => !m.assignment_id || id === m.assignment_id,
    "its move rolled back"
  );
  // A switch's new session is stopped (again each tick) until seen stopped: only then does the old one take its door back.
  const switched = m.assignment_id ? null : agentOf(db, holder);
  if (switched?.session) {
    await desk.runtimes[switched.runtime]
      ?.stop(switched.session)
      .catch((e: Error) =>
        log("desk.move", { ask: m.ask, ...errorOf(e), ok: false, what: "stop" })
      );
    if (!(await isSessionDone(desk, switched))) {
      return;
    }
  }
  rollback(desk, m, failure);
}

/** Ends each old holder (active or stopped) a done matter move left holding nothing (his answer 3: the matter stays with its new agent), "moved to the <name> agent", once no move of its is under way. */
function endLeftHolders({ db }: Desk) {
  const busy = new Set(
    unfinishedMoves(db).flatMap((m) => [m.agent_id, m.to_agent ?? ""])
  );
  const left = db
    .query<{ agent_id: string; to_agent: string }, []>(
      "select m.agent_id, m.to_agent from move m join agent a on a.id = m.agent_id where a.status in ('active', 'stopped') and m.assignment_id is not null and m.moved_at is not null and m.failed is null and not exists (select 1 from assignment s where s.agent_id = a.id and s.closed_at is null)"
    )
    .all();
  for (const { agent_id, to_agent } of left) {
    if (!busy.has(agent_id)) {
      const to = agentOf(db, to_agent);
      endWhenIdle(
        db,
        agent_id,
        "ended",
        `moved to the ${to ? shortNameOf(to) : "new"} agent`
      );
    }
  }
}

/** Each tick, after his asks and before the turns due: every unfinished move one step on, in the order he asked; then the old holders a done move left idle are ended. */
export async function advanceMoves(desk: Desk) {
  for (const m of unfinishedMoves(desk.db)) {
    // biome-ignore lint/performance/noAwaitInLoops: one move at a time, in his order
    await (m.moved_at ? advanceStarting(desk, m) : advanceNotes(desk, m));
  }
  endLeftHolders(desk);
}

/** Writes why each runtime can't run now (`Runtime.block`, null: it can), once a poll: the host's reads offer a move only to one that runs. */
export async function writeRuntimeBlocks(desk: Desk) {
  const blocks = await Promise.all(
    Object.entries(desk.runtimes).map(
      async ([runtime, r]) =>
        [
          runtime,
          (await r.block().catch((e: Error) => e.message)) ?? null,
        ] as const
    )
  );
  for (const [runtime, why] of blocks) {
    desk.db.run(
      "insert into runtime_block (runtime, why, checked_at) values (?, ?, ?) on conflict (runtime) do update set why = excluded.why, checked_at = excluded.checked_at",
      [runtime, why, now()]
    );
  }
}

/** What the new holder's first turn is told of move `ask`: from whom, from which runtime, the old session's link. */
export function movedLineOf(db: Desk["db"], ask: string) {
  const m = unfinishedMoves(db).find((x) => x.ask === ask);
  const from = m && agentOf(db, m.agent_id);
  if (!(m && from)) {
    return [];
  }
  return m.assignment_id
    ? [
        `This matter was moved to you at his word from the ${shortNameOf(from)} agent (${runtimeWordOf(from.runtime)}): its notes above are its handover${from.link ? `, its session ${from.link}` : ""}. If it has an open card, that card stands: wait for his answer. Else ask your plan first.`,
      ]
    : [
        `At his word you now run on ${runtimeWordOf(m.to_runtime ?? "")}, no longer ${runtimeWordOf(m.from_runtime ?? "")}: your notes above carry where you stood${m.from_link ? `; your last session: ${m.from_link}` : ""}.`,
      ];
}
