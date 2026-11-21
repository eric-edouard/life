import type { Database } from "bun:sqlite";
import { HOUR } from "../core/clock";
import { RUNTIME_WORDS, RuntimeName } from "../core/names";
import { settings } from "../core/settings";
import type { Decision } from "../memory/decision-lines";
import { isAsked } from "../memory/draft-contest";
import {
  type AgentRow,
  type AssignmentRow,
  agentChangeOf,
  agentOf,
  anchorsOf,
  openAssignmentOfMatter,
  openAssignmentsOf,
  type TurnRow,
} from "./desk-read";

// A move's reads of the desk's store (decision 78; its transitions are `desk/agent-moves.ts`'s): its row, where it
// stands (`movePhaseOf`, worked out, never stored), its turns, the sentences the phone shows, and what the fold leaves.
// A part of host's desk reads, as `desk-read.ts`'s.

/**
 * A move (decision 78, `desk/agent-moves.ts`): his `hand_over` ask, the agent it moves from (a matter move) or switches
 * (a runtime switch), the matter's assignment (none: a switch), where to (a runtime, or the agent he named; a made
 * agent's id once committed), what a switch's rollback restores, when it was asked and committed, and why it failed
 * after apply (`MoveFailure`). Its phase is worked out when read (`movePhaseOf`).
 */
export interface MoveRow {
  agent_id: string;
  ask: string;
  asked_at: string;
  assignment_id: string | null;
  failed: MoveFailure | null;
  failed_at: string | null;
  from_effort: string | null;
  from_link: string | null;
  from_model: string | null;
  from_runtime: string | null;
  from_session: string | null;
  moved_at: string | null;
  to_agent: string | null;
  to_runtime: string | null;
}

/** The cause of a move's notes turn: the old agent writes its notes, then the move commits. */
export const MOVE_NOTES = "move_notes";

/** Why a move failed after apply: its first turn never began, its holder was stopped, the matter closed, the agent he named ended, the runtime could not run, the desk was full. */
export type MoveFailure =
  | "not_started"
  | "stopped"
  | "matter_closed"
  | "target_ended"
  | "target_blocked"
  | "desk_full";

/** An agent as he reads it: the name he gave it, else its brief's first line. */
export const shortNameOf = (a: Pick<AgentRow, "brief" | "name">) =>
  a.name ?? (a.brief.trim().split("\n")[0] ?? "").slice(0, 60);

/** A runtime as he reads it (`RUNTIME_WORDS`), or its name when the desk drives another. */
export const runtimeWordOf = (runtime: string) =>
  RUNTIME_WORDS[runtime as RuntimeName] ?? runtime;

/** A move's sentences, the phone shows them verbatim: the desk's refusals at apply and its failures after (`MoveFailure`). */
export const MOVE_REASONS = {
  agentEnded: (name: string) => `The ${name} agent has ended.`,
  already: (runtime: string) => `It is already on ${runtimeWordOf(runtime)}.`,
  blocked: (runtime: string) =>
    `${runtimeWordOf(runtime)} can't run on your Mac right now.`,
  closed: "The matter closed before it moved.",
  fixedSubject: (name: string) => `The ${name} agent takes no other matter.`,
  full: "Too many agents are at work.",
  noHolder: "No agent holds this matter.",
  notStarted: (to: string) => `${to} did not start.`,
  shape:
    "Name a matter with a runtime or an agent, or an agent with a runtime.",
  stopped: "The agent is stopped.",
  underWay: "A move is already under way.",
  withAgent: (name: string) => `It is already with the ${name} agent.`,
} as const;

export const moveOf = (db: Database, ask: string) =>
  db.query<MoveRow, [string]>("select * from move where ask = ?").get(ask);

/** The moves not over, oldest first: applied (its ask not refused), not failed, its first turn not begun. A move is serialized per agent and assignment, so they are few. */
export const unfinishedMoves = (db: Database) =>
  db
    .query<MoveRow, []>(
      `select m.* from move m join agent_change c on c.ask = m.ask where c.error is null and m.failed is null and not exists (select 1 from turn t where t.agent_id = coalesce(m.to_agent, m.agent_id) and t.move = m.ask and t.cause <> '${MOVE_NOTES}' and t.begun_at is not null) order by m.asked_at`
    )
    .all();

/** The unfinished move on open assignment `s` (its own, or its agent's switch), if one is: at most one (`MOVE_REASONS.underWay`). */
export const moveOn = (
  db: Database,
  s: Pick<AssignmentRow, "agent_id" | "id">
) =>
  unfinishedMoves(db).find((m) =>
    m.assignment_id ? m.assignment_id === s.id : m.agent_id === s.agent_id
  );

/** The assignments a move covers: the matter's, or each open one of the agent it switches. */
export const moveScopeOf = (db: Database, m: MoveRow) =>
  m.assignment_id
    ? [m.assignment_id]
    : openAssignmentsOf(db, m.agent_id).map((r) => r.id);

/** A move's notes turns (cause `move_notes`, the old agent's, one per assignment). */
export const notesTurnsOf = (db: Database, m: MoveRow) =>
  db
    .query<TurnRow, [string, string]>(
      `select * from turn where agent_id = ? and move = ? and cause = '${MOVE_NOTES}' order by id`
    )
    .all(m.agent_id, m.ask);

/** A move's first turn after its commit (its holder's, on the matter or, for a switch, on any assignment), if written. */
export const moveFirstTurnOf = (db: Database, m: MoveRow) =>
  db
    .query<TurnRow, [string, string]>(
      `select * from turn where agent_id = ? and move = ? and cause <> '${MOVE_NOTES}' order by id limit 1`
    )
    .get(m.to_agent ?? m.agent_id, m.ask) ?? null;

/** The words of why move `m` failed after apply (`MoveFailure`). */
function failureWordsOf(db: Database, m: MoveRow) {
  const to = m.to_agent ? agentOf(db, m.to_agent) : null;
  const toName = to ? `The ${shortNameOf(to)} agent` : "The new agent";
  switch (m.failed) {
    case "not_started":
      return MOVE_REASONS.notStarted(
        m.to_runtime ? runtimeWordOf(m.to_runtime) : toName
      );
    case "stopped":
      return MOVE_REASONS.stopped;
    case "matter_closed":
      return MOVE_REASONS.closed;
    case "target_ended":
      return MOVE_REASONS.agentEnded(to ? shortNameOf(to) : "other");
    case "target_blocked":
      return MOVE_REASONS.blocked(m.to_runtime ?? "");
    default:
      return MOVE_REASONS.full;
  }
}

/**
 * Where move `m` stands, worked out from its row, its ask's `agent_change` and its turns: `failed` (refused at apply, or
 * failed after, with its sentence), `done` (its first turn began), `starting` (committed), or `notes` (how many of its
 * assignments' notes turns ended, of how many); with when it ended, for a read that shows it an hour after.
 */
export function movePhaseOf(db: Database, m: MoveRow) {
  const refused = agentChangeOf(db, m.ask);
  if (refused?.error) {
    return {
      at: refused.applied_at,
      phase: "failed" as const,
      reason: refused.error,
    };
  }
  if (m.failed) {
    return {
      at: m.failed_at,
      phase: "failed" as const,
      reason: failureWordsOf(db, m),
    };
  }
  const first = moveFirstTurnOf(db, m);
  if (first?.begun_at) {
    return { at: first.begun_at, phase: "done" as const };
  }
  if (m.moved_at) {
    return { at: null, phase: "starting" as const };
  }
  const written = new Set(
    notesTurnsOf(db, m).flatMap((t) => (t.ended_at ? [t.assignment_id] : []))
  );
  const scope = moveScopeOf(db, m);
  return {
    at: null,
    done: scope.filter((id) => written.has(id)).length,
    phase: "notes" as const,
    total: scope.length,
  };
}

/** The newest move on assignment `id` (a matter move), or of agent `agent` (a runtime switch). */
export const latestMoveOf = (
  db: Database,
  on: { agent: string } | { assignment: string }
) =>
  "assignment" in on
    ? db
        .query<MoveRow, [string]>(
          "select * from move where assignment_id = ? order by asked_at desc limit 1"
        )
        .get(on.assignment)
    : db
        .query<MoveRow, [string]>(
          "select * from move where agent_id = ? and assignment_id is null order by asked_at desc limit 1"
        )
        .get(on.agent);

/** How open assignment `s`'s holder got it, when by his move (not failed): the agent it came from, and when it moved. */
export const movedInOf = (
  db: Database,
  s: Pick<AssignmentRow, "agent_id" | "id">
) => {
  const m = db
    .query<{ agent_id: string; moved_at: string }, [string, string]>(
      "select agent_id, moved_at from move where assignment_id = ? and to_agent = ? and moved_at is not null and failed is null order by moved_at desc limit 1"
    )
    .get(s.id, s.agent_id);
  const from = m && agentOf(db, m.agent_id);
  return m && from ? { at: m.moved_at, from } : null;
};

/**
 * Which of assignment `s`'s cards count as asked (`isAsked`): for a holder that got it by his move (`movedInOf`), only a
 * card still open at the move or asked after, so its first card is the open one it inherited, else its own plan. The one
 * rule for the door's `hasAsked` and the inbox's `planCardsOf`.
 */
export function countsAsAskedOf(
  db: Database,
  s: Pick<AssignmentRow, "agent_id" | "id">
) {
  const since = movedInOf(db, s)?.at;
  return (d: Decision) =>
    isAsked(d) && (!since || d.at >= since || (endedAtOf(d) ?? since) >= since);
}

/** When card `d` stopped waiting on him: his answer, its withdrawal, its step seen done (`doneSeen`), its lapse (its deadline); none while open. */
const endedAtOf = (d: Decision) =>
  d.answer?.at ??
  d.withdrawn?.at ??
  (d.doneSeen?.state === "seen" ? d.doneSeen.at : undefined) ??
  (d.state === "lapsed" ? d.deadline : undefined);

/** The assignments a matter move holds with their new agent (not failed): the fold leaves them (his answer 3 of decision 78). */
export const pinnedAssignmentsOf = (db: Database) =>
  new Set(
    db
      .query<{ id: string }, []>(
        "select m.assignment_id as id from move m join agent_change c on c.ask = m.ask where c.error is null and m.failed is null and m.assignment_id is not null"
      )
      .all()
      .map((r) => r.id)
  );

/** Why each runtime could not run at the desk's last look (`runtime_block`, null: it ran), by name; none it never looked at. */
export const runtimeBlocksOf = (db: Database): Record<string, string | null> =>
  Object.fromEntries(
    db
      .query<{ runtime: string; why: string | null }, []>(
        "select runtime, why from runtime_block"
      )
      .all()
      .map((r) => [r.runtime, r.why])
  );

/** Which matter some refs find, the assignment's chosen matter taking a tie (`matterFinderOf` over the open matters). */
export type MatterOfRefs = (
  refs: readonly string[],
  prefer?: string
) => string | undefined;

/**
 * The open assignment on matter `id`: the one he chose it for (`openAssignmentOfMatter`), else one anchored on any of its
 * `steps` whose anchors find that matter (`matterOf`, its own chosen matter taking a tie), so an assignment on another
 * matter sharing a step is never taken; its agent active or stopped. No `id`: the first anchored on its steps.
 */
export function assignmentOnMatter(
  db: Database,
  { id, steps }: { id?: string; steps: string[] },
  matterOf: MatterOfRefs
) {
  const chosen = id ? openAssignmentOfMatter(db, id) : null;
  if (chosen || steps.length === 0) {
    return chosen;
  }
  return (
    db
      .query<AssignmentRow, [string]>(
        "select s.* from assignment s join agent a on a.id = s.agent_id where s.closed_at is null and a.status in ('active', 'stopped') and s.id in (select assignment_id from anchor where step in (select value from json_each(?))) order by a.status = 'active' desc, s.opened_at desc"
      )
      .all(JSON.stringify(steps))
      .find(
        (s) =>
          !id || matterOf(anchorsOf(db, s.id), s.matter_id ?? undefined) === id
      ) ?? null
  );
}

/** An agent's names on the wire: `short` (its name, or its brief's first line) and `name` (`short` + " agent"). */
const namesOf = (a: Pick<AgentRow, "brief" | "name">) => {
  const short = shortNameOf(a);
  return { name: `${short} agent`, short };
};

/**
 * Where an agent on `runtime` can move (`moveTo`), or why not now (`moveBlocked`, from the desk's last look): the desk's
 * default runtime, or from it the first other (one move offered: the phone's menu shows one).
 */
export function moveTargetOf(
  runtime: string,
  defaultRuntime = settings().desk?.defaultRuntime ?? "claude"
) {
  return runtime === defaultRuntime
    ? RuntimeName.options.find((r) => r !== runtime)
    : defaultRuntime;
}

function moveToOf(db: Database, runtime: string) {
  const to = moveTargetOf(runtime);
  if (!to) {
    return {};
  }
  return runtimeBlocksOf(db)[to]
    ? { moveBlocked: { reason: MOVE_REASONS.blocked(to), runtime: to } }
    : { moveTo: to };
}

/** Move `m` as a read shows it: while unfinished and for an hour after it ended (`movePhaseOf`); none past that. */
function shownMoveOf(db: Database, m: MoveRow | null | undefined, now: number) {
  if (!m) {
    return null;
  }
  const { at, phase, ...rest } = movePhaseOf(db, m);
  return at && now - Date.parse(at) > HOUR
    ? null
    : {
        id: m.ask,
        phase,
        ...("reason" in rest ? { reason: rest.reason } : {}),
      };
}

/**
 * What a matter's read shows of who holds it and of its move (decision 78): `holder` (the agent of its open
 * assignment, with `movedFrom` when he moved it there), the runtime it can move to (`moveTo`) or why not (`moveBlocked`),
 * and its newest `move`. No assignment holds it: `holder` null.
 */
export function matterMoveReadOf(
  db: Database,
  matter: { id?: string; steps: string[] },
  now: number,
  matterOf: MatterOfRefs
) {
  const s = assignmentOnMatter(db, matter, matterOf);
  const a = s && agentOf(db, s.agent_id);
  if (!(s && a)) {
    return { holder: null, move: undefined };
  }
  const from = movedInOf(db, s)?.from;
  const move = shownMoveOf(db, latestMoveOf(db, { assignment: s.id }), now);
  return {
    holder: {
      id: a.id,
      ...namesOf(a),
      runtime: a.runtime,
      ...(from
        ? {
            movedFrom: { id: from.id, ...namesOf(from), runtime: from.runtime },
          }
        : {}),
    },
    ...moveToOf(db, a.runtime),
    ...(move ? { move } : {}),
  };
}

/** What an agent's read shows of its names and its runtime switch (decision 78): `name`, `short`, `moveTo` or `moveBlocked`, and its newest `switch` (with how many notes are written while in `notes`). */
export function agentMoveReadOf(db: Database, id: string, now: number) {
  const a = agentOf(db, id);
  if (!a) {
    return {};
  }
  const m = latestMoveOf(db, { agent: id });
  const shown = shownMoveOf(db, m, now);
  const phase = m && shown ? movePhaseOf(db, m) : null;
  return {
    ...namesOf(a),
    ...moveToOf(db, a.runtime),
    ...(shown
      ? {
          switch: {
            ...shown,
            ...(phase?.phase === "notes"
              ? { done: phase.done, total: phase.total }
              : {}),
          },
        }
      : {}),
  };
}
