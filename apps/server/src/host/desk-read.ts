import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clock, DAY } from "../core/clock";
import { type AgentRole, BUILT_IN_RUNTIME } from "../core/names";
import { off } from "../core/outputs";
import { DESK_STORE } from "../core/paths";
import { pathInside } from "../core/platform";
import { settings } from "../core/settings";
import { openReadOnly } from "../core/sqlite";
import type { Decision } from "../memory/decision-lines";
import type { AgentHold, StandingAgent } from "../memory/held-matters";
import type { BeingFixed } from "../memory/life-checks";
import { deletionsNow } from "../memory/memory-files";
import {
  type AgentChange,
  type AgentStatus,
  type EventFilter,
  isWokenOnlyByHisWords,
  type OpenedBy,
} from "../records/registered-agent";
import { isBeforeAssignments, isOldShape, NOT_MIGRATED } from "./desk-shape";
import { COMPLAINT_RECEIVED } from "./events";

// Every read of the desk's store (`LIFE_STATE_DIR/desk/desk.sqlite`), its rows' shapes and the rules worked out from
// them: the desk reads through these, and host reads the store read-only (`readDesk`), so the desk off or its store
// unreadable never breaks a read, the report or the status. Only the desk writes it (`desk/desk-store.ts`). Readers are
// bounded: active agents (50 at most), a window of days, or one agent's rows.

/** A registered agent's row: an identity and a session. `status` `active` is running while a desk turn is open, else waiting. */
export interface AgentRow {
  brief: string;
  created_at: string;
  effort: string | null;
  ended_at: string | null;
  folder: string;
  id: string;
  link: string | null;
  model: string | null;
  /** The name he gave it; null until set. */
  name: string | null;
  /** How it ended: its last assignment's close; null for one never started. */
  outcome: string | null;
  /** Its project of `truth/`, when its own assignment listens to one. */
  project: string | null;
  /** Its standing role, one active or stopped at most of each; null for every other agent. */
  role: AgentRole | null;
  runtime: string;
  session: string | null;
  status: AgentStatus;
  /** When he stopped it; null unless stopped, and for an agent stopped before the column. */
  stopped_at: string | null;
}

/**
 * One subject given to one agent: its anchors (none: the agent's own, its listening), its wait, its notes file, who
 * opened it and how it closed. Open while `closed_at` is null.
 */
export interface AssignmentRow {
  agent_id: string;
  closed_at: string | null;
  id: string;
  /** The matter he (or the hand-out) chose, by its id when it was opened or re-pointed: the finder's tie-breaker between matters sharing its anchors (`matterFinderOf`'s `prefer`). Null: none chosen (an agent's own, or opened before 21 Nov 2026), or an id a re-group has since replaced. */
  matter_id: string | null;
  /** Where its notes are: a file in his agents repo (`desk.agentsRepo`), else under the desk's folders. */
  notes_path: string;
  opened_at: string;
  opened_by: OpenedBy;
  /** How it closed, in the agent's words (`finish`) or the desk's ("its matter is done"); null for one never started. */
  outcome: string | null;
  plan_done: number | null;
  plan_total: number | null;
  /** His words when he gave it, when he did. */
  said: string | null;
  wait_events: string;
  wait_is_default: number;
  wait_reason: string | null;
  wait_until: string | null;
  /** Why its first turn never began (`endNotStarted`): it was closed, and its matter is free for a new start. */
  why_not_started: string | null;
}

/** An agent turn's row; `ended_at` null while it runs. A turn works on one assignment; an agent runs one turn at a time. */
export interface TurnRow {
  agent_id: string;
  assignment_id: string;
  /** When its runtime reported it under way; null before, and for turns older than the column. */
  begun_at: string | null;
  cause: string;
  /** The context of its last call, in tokens, kept as a record (no decision reads it); null when its runtime gave none. */
  context_used: number | null;
  ended_at: string | null;
  heard_at: string | null;
  id: number;
  /** The model it ran on, as `<runtime>:<model>` (`default`: the runtime's own), snapshotted at its start; null before the column. */
  model: string | null;
  /** The move it belongs to: a move's notes turn, or its first turn after the commit; null for every other. */
  move: string | null;
  outcome: string | null;
  reminded_at: string | null;
  session: string | null;
  started_at: string;
  /** 1 when the spending stop ended it inside (it asked him at its stop); null otherwise. */
  stopped_spending: number | null;
}

/** A queued event's row: not yet consumed or dropped. */
export interface EventRow {
  event_id: string;
  handed: number;
  name: string;
  payload: string;
  received_at: string;
}

/** The most agents the desk keeps active, and of each other kind a read lists: every read of them is bounded by it. */
export const MAX_ACTIVE = 50;

/** Whether the desk keeps its most agents active: no other is registered then. */
export const isFull = (db: Database) =>
  (db
    .query<{ n: number }, []>(
      "select count(*) as n from agent where status = 'active'"
    )
    .get()?.n ?? 0) >= MAX_ACTIVE;

/** How many assignments the desk opened itself (the hand-out) from `since` on (an ISO instant). */
export const handedOutSince = (db: Database, since: string) =>
  db
    .query<{ n: number }, [string]>(
      "select count(*) as n from assignment where opened_by = 'desk' and opened_at >= ?"
    )
    .get(since)?.n ?? 0;

/** The assignments the desk opened itself from `since` on: when each closed, and why its first turn never began. */
export const handOutsSince = (db: Database, since: string) =>
  db
    .query<
      Pick<AssignmentRow, "closed_at" | "id" | "matter_id" | "why_not_started">,
      [string]
    >(
      "select id, closed_at, matter_id, why_not_started from assignment where opened_by = 'desk' and opened_at >= ? order by opened_at"
    )
    .all(since);

/** The open assignments the desk opened itself, of active agents, each with when its holder's first turn on it began (`first_begun_at`: after the last turn another agent ran on it, so a moved one counts from its new holder; null before). Its limit: moved away and back before the other agent ran a turn, it counts from its first holder's old turn again. */
export const handedOutActive = (db: Database) =>
  db
    .query<AssignmentRow & { first_begun_at: string | null }, []>(
      "select s.*, (select min(t.begun_at) from turn t where t.assignment_id = s.id and t.id > (select coalesce(max(o.id), 0) from turn o where o.assignment_id = s.id and o.agent_id <> s.agent_id)) as first_begun_at from assignment s join agent a on a.id = s.agent_id where s.opened_by = 'desk' and s.closed_at is null and a.status = 'active'"
    )
    .all();

export const activeAgents = (db: Database) =>
  db
    .query<AgentRow, [number]>(
      "select * from agent where status = 'active' order by created_at limit ?"
    )
    .all(MAX_ACTIVE);

export const agentOf = (db: Database, id: string) =>
  db.query<AgentRow, [string]>("select * from agent where id = ?").get(id);

export const assignmentOf = (db: Database, id: string) =>
  db
    .query<AssignmentRow, [string]>("select * from assignment where id = ?")
    .get(id);

/** The open assignments of the active agents, oldest first: what the clock wakes and the polls queue for. */
export const openAssignments = (db: Database) =>
  db
    .query<AssignmentRow, [number]>(
      "select s.* from assignment s where s.closed_at is null and s.agent_id in (select id from agent where status = 'active' order by created_at limit ?) order by s.opened_at, s.rowid"
    )
    .all(MAX_ACTIVE);

/**
 * The assignment agent `id` works on now: its open turn's, else its first open one, else its newest. Each agent has one
 * until the fold (the agents and matters plan, PR 3): the door's tools and the agent-level reads take it.
 */
export const currentAssignmentOf = (db: Database, id: string) =>
  db
    .query<AssignmentRow, [string]>(
      "select s.* from assignment s where s.agent_id = ?1 order by s.id = (select assignment_id from turn where agent_id = ?1 and ended_at is null) desc, s.closed_at is not null, case when s.closed_at is null then s.opened_at end, s.opened_at desc limit 1"
    )
    .get(id);

/** The open assignments of agent `id`, oldest first. */
export const openAssignmentsOf = (db: Database, id: string) =>
  db
    .query<AssignmentRow, [string]>(
      "select * from assignment where agent_id = ? and closed_at is null order by opened_at, rowid"
    )
    .all(id);

/** The agent whose session `ref` is (any of its sessions, an old one too), if any. */
export const agentOfSession = (db: Database, ref: string) =>
  db
    .query<{ agent_id: string }, [string]>(
      "select agent_id from session where ref = ?1 union select id from agent where session = ?1 limit 1"
    )
    .get(ref)?.agent_id;

/** An assignment's last turns, newest first: enough for its last one and a run of failures. */
export const lastTurns = (db: Database, id: string, n = 4) =>
  db
    .query<TurnRow, [string, number]>(
      "select * from turn where assignment_id = ? order by id desc limit ?"
    )
    .all(id, n);

export const turnOf = (db: Database, id: number) =>
  db.query<TurnRow, [number]>("select * from turn where id = ?").get(id);

/** The desk turn running now for an agent, if any: its session takes one turn at a time. */
export const openTurn = (db: Database, id: string) =>
  db
    .query<TurnRow, [string]>(
      "select * from turn where agent_id = ? and ended_at is null"
    )
    .get(id);

/** An assignment's queued events, oldest first. */
export const queuedEvents = (db: Database, id: string) =>
  db
    .query<EventRow, [string]>(
      "select event_id, handed, name, payload, received_at from event where assignment_id = ? and consumed_at is null and dropped_at is null order by rowid"
    )
    .all(id);

/** Whether `a` is active and its assignment `s` open: only then does a wait of `s` stand. */
export const isWaiting = (a: AgentRow, s: AssignmentRow) =>
  a.status === "active" && s.closed_at === null;

export const filtersOf = (s: Pick<AssignmentRow, "wait_events">) =>
  JSON.parse(s.wait_events) as EventFilter[];

/** The agent wait an active agent still holds for this assignment, flagged when it is the default; none for an agent woken only by his words. */
export const agentWaitOf = (a: AgentRow, s: AssignmentRow) =>
  isWaiting(a, s) && s.wait_until && !isWokenOnlyByHisWords(a.role)
    ? {
        events: filtersOf(s),
        isDefault: s.wait_is_default === 1,
        reason: s.wait_reason ?? "(the reason was not recorded)",
        until: s.wait_until,
      }
    : null;

/** An assignment's notes, as its file holds them; none before the agent wrote any. */
export const readNotes = (s: Pick<AssignmentRow, "notes_path">) =>
  existsSync(s.notes_path) ? readFileSync(s.notes_path, "utf8") : "";

/**
 * Agent `a`'s home in his agents repo (`agentsRepo`): its folder when that sits in the repo (the Personal agent's
 * `personal/`), else `project-<its project>`; none for an agent with no project. Its rules and know-how live there.
 */
export function agentHomeOf(
  agentsRepo: string,
  a: Pick<AgentRow, "folder" | "project">
) {
  if (pathInside(agentsRepo, a.folder)) {
    return a.folder;
  }
  return a.project ? join(agentsRepo, `project-${a.project}`) : null;
}

/** Which assignment owns card `d`: the one that asked it, written once when asked (`card`, `askDecision`), never worked out from anchors that move; with no row (the desk stopped before it committed), the assignment its line names; one asked before the desk kept owners (20 Nov 2026), its asker's first assignment (its one then); none for a card no registered agent asked. */
export const assignmentOfCard = (
  db: Database,
  d: { agent?: string; assignment?: string; id: string }
) =>
  d.agent
    ? (db
        .query<{ id: string }, [string]>(
          "select assignment_id as id from card where decision_id = ?"
        )
        .get(d.id)?.id ??
      d.assignment ??
      db
        .query<{ id: string }, [string]>(
          "select id from assignment where agent_id = ? order by opened_at, rowid limit 1"
        )
        .get(d.agent)?.id ??
      null)
    : null;

/**
 * Where each of `cards` (his open ones) stands with the desk, by its id: the open assignment that owns it
 * (`assignmentOfCard`, legacy cards included) and that assignment's agent, its holder, whoever asked it; none for a card
 * no open assignment owns. The one read of a card's holder: the inbox shows it, and an agent's read finds its open card
 * by its assignment. One lookup per card, by its key.
 */
export const cardOwnersOf = (
  db: Database,
  cards: readonly { agent?: string; id: string }[]
): Record<string, { assignment: string; holder: string }> =>
  Object.fromEntries(
    cards.flatMap((d) => {
      const id = assignmentOfCard(db, d);
      const s = id ? assignmentOf(db, id) : null;
      return s && s.closed_at === null
        ? [[d.id, { assignment: s.id, holder: s.agent_id }]]
        : [];
    })
  );

/** Another open assignment of `s`'s agent anchored on `step`, if one is: a card on that step is that one's to ask (`askDecision`). */
export const siblingOn = (
  db: Database,
  s: Pick<AssignmentRow, "agent_id" | "id">,
  step: string
) =>
  db
    .query<{ id: string }, [string, string, string]>(
      "select n.assignment_id as id from anchor n join assignment s on s.id = n.assignment_id where s.agent_id = ? and s.closed_at is null and n.step = ? and n.assignment_id <> ? limit 1"
    )
    .get(s.agent_id, step, s.id)?.id ?? null;

/** The matter steps assignment `id` was shown, by records and packets of turns that ended unfailed (`keepHanded`). */
export const handedSteps = (db: Database, id: string) =>
  new Set(
    db
      .query<{ step: string }, [string]>(
        "select step from handed_step where assignment_id = ?"
      )
      .all(id)
      .map((r) => r.step)
  );

export const readCursor = (db: Database, name: string) =>
  db
    .query<{ value: string }, [string]>(
      "select value from cursor where name = ?"
    )
    .get(name)?.value ?? null;

/** An assignment's anchors: the matter steps it was handed, in order; none for an agent's own. */
export const anchorsOf = (db: Database, id: string) =>
  db
    .query<{ step: string }, [string]>(
      "select step from anchor where assignment_id = ? order by rowid"
    )
    .all(id)
    .map((r) => r.step);

/** The active agent holding any of `steps` by an open assignment's anchor, if one does: a matter has one at most. */
export const holderOf = (db: Database, steps: string[]) =>
  steps.length === 0
    ? null
    : (db
        .query<{ id: string }, string[]>(
          `select a.id from anchor n join assignment s on s.id = n.assignment_id join agent a on a.id = s.agent_id where a.status = 'active' and s.closed_at is null and n.step in (${steps.map(() => "?").join(",")}) limit 1`
        )
        .get(...steps)?.id ?? null);

/** The open assignment on the matter he chose, by its id (`matter_id`), if one is. */
export const openAssignmentOfMatter = (db: Database, matter: string) =>
  db
    .query<AssignmentRow, [string]>(
      "select * from assignment where matter_id = ? and closed_at is null order by opened_at desc limit 1"
    )
    .get(matter);

/** The active agents that take matters (`agentForOf`): a project's or the Personal agent, oldest first. */
export const standingAgents = (db: Database): StandingAgent[] =>
  db
    .query<StandingAgent, [number]>(
      "select id, name, project, role from agent where status = 'active' and (role = 'personal' or project is not null) order by created_at limit ?"
    )
    .all(MAX_ACTIVE);

/**
 * How long an ended agent's subject is read for the hold rule: one ended earlier holds nothing, so a try older than this
 * may be repeated once on a matter nobody moved (accepted: the read stays bounded).
 */
export const HOLD_DAYS = 90;

/** Every anchor of an assignment open, or closed in the last `HOLD_DAYS`, of an agent active, stopped or ended. */
const HELD_ROWS =
  "select n.rowid as anchor, a.rowid as agent, a.id as agent_id, a.status, n.step, s.closed_at, s.opened_by, s.outcome, s.why_not_started from anchor n join assignment s on s.id = n.assignment_id join agent a on a.id = s.agent_id where s.closed_at is null or s.closed_at >= ?1";
const heldSince = () =>
  new Date(clock().getTime() - HOLD_DAYS * DAY).toISOString();

/** The steps registered agents hold, as facts (`AgentHold`): what the hold rule (`isHeldOf`) decides "held" from, against the matter book. */
export const heldByAgents = (db: Database): AgentHold[] =>
  db
    .query<
      Pick<AgentRow, "status"> &
        Pick<
          AssignmentRow,
          "closed_at" | "opened_by" | "outcome" | "why_not_started"
        > & { agent_id: string; step: string },
      [string]
    >(`${HELD_ROWS} order by agent, anchor`)
    .all(heldSince())
    .map((r) => ({
      agent: r.agent_id,
      closedAt: r.closed_at,
      openedBy: r.opened_by,
      outcome: r.outcome,
      status: r.status,
      step: r.step,
      whyNotStarted: r.why_not_started,
    }));

/** A stamp of what `heldByAgents` would read, by one cheap query (how many, the newest anchor and agent, the newest close): the inbox's key, never the list. */
export const heldStampOf = (db: Database) =>
  JSON.stringify(
    db
      .query<unknown, [string]>(
        `select count(*), max(anchor), max(agent), max(closed_at) from (${HELD_ROWS})`
      )
      .values(heldSince())
  );

/**
 * The agent in standing role `role`: its one active or stopped, else its newest that ended (`ended_at`); with why its
 * newest assignment's first turn never began (`why_not_started`), if it did not. None ever: null.
 */
export const agentInRole = (db: Database, role: AgentRole) =>
  db
    .query<AgentRow & Pick<AssignmentRow, "why_not_started">, [string]>(
      "select a.*, s.why_not_started from agent a left join assignment s on s.agent_id = a.id where a.role = ? order by a.status in ('active', 'stopped') desc, a.created_at desc, s.opened_at desc limit 1"
    )
    .get(role);

/** The caretaker's assignments, of every caretaker it ever had: a complaint received by one is received for good. */
const CARETAKER_EVENTS = `select e.*, s.closed_at, s.id as assignment from event e join assignment s on s.id = e.assignment_id join agent a on a.id = s.agent_id where a.role = 'caretaker' and e.name = '${COMPLAINT_RECEIVED}'`;

/** Where complaint `ask` was received (its receipt: the event row the desk queued for a caretaker's assignment), or null before. */
export const complaintReceiptOf = (db: Database, ask: string) =>
  db
    .query<{ assignment: string; received_at: string }, [string]>(
      `${CARETAKER_EVENTS} and e.event_id = ?`
    )
    .get(ask);

/**
 * His complaints the caretaker is at work on, in the order received: each received for an assignment still open, its
 * event not dropped, with that assignment and whether it is all that assignment holds. Bounded: the caretaker's open
 * assignments. A few rows: the inbox's key holds them.
 */
export const complaintsAtWork = (db: Database) =>
  db
    .query<
      { alone: number; ask: string; assignment: string; since: string },
      []
    >(
      `select e.event_id as ask, e.received_at as since, e.assignment, (select count(*) from event x where x.assignment_id = e.assignment and x.name = '${COMPLAINT_RECEIVED}') = 1 as alone from (${CARETAKER_EVENTS} and s.closed_at is null and e.dropped_at is null) e order by e.received_at, e.event_id`
    )
    .all();

/**
 * His complaints at work (`complaintsAtWork`) as cards show them (`BeingFixed`): each with the newest open card of
 * `cards` its assignment owns (`cardOwnersOf`), its question as the line and its `context`, only when the complaint is
 * all that assignment holds, so a card is never shown on a complaint it may not be about; else both null. The rows and
 * the owners are read in one transaction: one moment of the desk.
 */
export function beingFixedOf(
  db: Database,
  cards: readonly Pick<
    Decision,
    "agent" | "assignment" | "context" | "id" | "question" | "state"
  >[]
): BeingFixed[] {
  const open = cards.filter((d) => d.state === "open");
  const [atWork, owners] = db.transaction(() => {
    const rows = complaintsAtWork(db);
    return [
      rows,
      rows.some((w) => w.alone) ? cardOwnersOf(db, open) : {},
    ] as const;
  })();
  return atWork.map(({ alone, ask, assignment, since }) => {
    const card = alone
      ? open.findLast((d) => owners[d.id]?.assignment === assignment)
      : undefined;
    return {
      ask,
      context: card?.context || null,
      line: card?.question ?? null,
      since,
    };
  });
}

/** What the desk did with an ask of his (`change_registered_agent`): the agent it touched, or why it refused; null until applied. */
export const agentChangeOf = (db: Database, ask: string) =>
  db
    .query<
      { agent_id: string | null; applied_at: string; error: string | null },
      [string]
    >("select agent_id, applied_at, error from agent_change where ask = ?")
    .get(ask);

/**
 * What the desk did with a start (`change_registered_agent`), as facts: the ask's `agent_change` row and, for its agent,
 * the assignment it opened or found (on a matter, its agent's newest anchored on any of its `steps`; else the agent's own), its agent's
 * newest session and that assignment's first turn, each null until written.
 */
export function readStartFacts(
  db: Database,
  ask: string,
  { matter, steps }: { matter?: string; steps?: string[] } = {}
) {
  const change = agentChangeOf(db, ask);
  const id = change?.agent_id;
  // On a matter, its agent's assignment anchored on any of `steps` (an open one first, as Start found it, then the one
  // on the matter he chose, then newest): a closed one's past never answers today's Start; else its own.
  const assignment =
    (id &&
      db
        .query<AssignmentRow, [string, string | null, string | null]>(
          "select * from assignment s where agent_id = ?1 and iif(?2 is null, id not in (select assignment_id from anchor), id in (select assignment_id from anchor where step in (select value from json_each(?2)))) order by closed_at is not null, matter_id is not ?3, opened_at desc limit 1"
        )
        .get(id, steps ? JSON.stringify(steps) : null, matter ?? null)) ||
    null;
  const one = <T>(sql: string, key?: string | null) =>
    (key ? db.query<T, [string]>(sql).get(key) : null) ?? null;
  return {
    agent: id ? agentOf(db, id) : null,
    assignment,
    change,
    session: one<{ link: string; ref: string; started_at: string }>(
      "select ref, link, started_at from session where agent_id = ? order by rowid desc limit 1",
      id
    ),
    turn: one<{ begun_at: string | null }>(
      "select begun_at from turn where assignment_id = ? order by id limit 1",
      assignment?.id
    ),
  };
}

/** His changes the desk refused since `since` (`change_registered_agent`), newest first: one past the connector's wait shows here. */
export const refusedSince = (db: Database, since: string) =>
  db
    .query<
      { agent: string | null; applied_at: string; ask: string; error: string },
      [string, number]
    >(
      "select ask, agent_id as agent, error, applied_at from agent_change where error is not null and applied_at >= ? order by applied_at desc limit ?"
    )
    .all(since, MAX_ACTIVE);

/** The runtime a start names, else its role's in the desk's settings (`roleRuntimes`), else the desk's default, else pi (`BUILT_IN_RUNTIME`). */
export const runtimeOf = (
  c: Pick<AgentChange, "runtime"> & { role?: AgentRole | null }
) =>
  c.runtime ??
  (c.role ? settings().desk?.roleRuntimes?.[c.role] : undefined) ??
  settings().desk?.defaultRuntime ??
  BUILT_IN_RUNTIME;

/** The model and effort agent `a` runs with: its own, else its runtime's in the desk's settings, else the runtime's default (none). */
export function modelOf(a: Pick<AgentRow, "effort" | "model" | "runtime">) {
  const runtimes: Partial<Record<string, { effort?: string; model?: string }>> =
    settings().desk?.runtimes ?? {};
  const set = runtimes[a.runtime];
  return {
    effort: a.effort ?? set?.effort ?? null,
    model: a.model ?? set?.model ?? null,
  };
}

/** What a turn of agent `a` runs on, as the price table names it (`core/prices.ts`): `<runtime>:<model>`, `default` for the runtime's own. */
export const turnModelOf = (
  a: Pick<AgentRow, "effort" | "model" | "runtime">
) => `${a.runtime}:${modelOf(a).model ?? "default"}`;

/** A line a scheduled task or a session posted for the report (`bun life desk report-line`): one per source per day. */
export interface ReportLine {
  day: string;
  line: string;
  link: string | null;
  source: string;
}

/** The report lines posted since `since` (the last report), by day. */
export const reportLinesSince = (db: Database, since: string) =>
  db
    .query<ReportLine, [string]>(
      "select source, day, line, link from report_line where posted_at > ? order by day, source"
    )
    .all(since);

/**
 * Each assignment's notes file kept outside `state` (his agents repo, `desk.agentsRepo`), read from the store at `path`
 * of the new shape: what an export carries beside Life's state and a restore puts back (`stage`, `restore`). None for a
 * store of the old shape.
 */
export function notesOutsideOf(path: string, state: string) {
  const db = openReadOnly(path);
  try {
    return isBeforeAssignments(db)
      ? []
      : db
          .query<Pick<AssignmentRow, "id" | "notes_path">, []>(
            "select id, notes_path from assignment"
          )
          .all()
          .filter((s) => pathInside(state, s.notes_path) === null);
  } finally {
    db.close();
  }
}

/** What reading the desk's store gave: nothing while the desk is off, why when it could not be read. */
export type DeskRead<T> =
  | { state: "off" }
  | { state: "unreadable"; why: string }
  | { state: "ok"; value: T };

/**
 * Reads the desk's store read-only with `read`; `empty` when the desk has made none yet. Never throws: the desk off or
 * its store unreadable is a state its reader shows.
 */
export function readDesk<T>(
  read: (db: Database) => T,
  empty: T,
  // A history read (spending) reads the store even while the desk is off.
  isEvenOff = false
): DeskRead<T> {
  if (off("desk") && !isEvenOff) {
    return { state: "off" };
  }
  if (!existsSync(DESK_STORE)) {
    return { state: "ok", value: empty };
  }
  let db: Database | undefined;
  try {
    db = openReadOnly(DESK_STORE);
    if (isOldShape(db)) {
      return { state: "unreadable", why: NOT_MIGRATED };
    }
    return { state: "ok", value: read(db) };
  } catch (e) {
    return { state: "unreadable", why: (e as Error).message };
  } finally {
    db?.close();
  }
}

/** Whether the desk has queued the event `eventId` for assignment `id` (`queued`) and then started a turn for it (`woken`, with `by` the agent of the first turn of cause `answer` begun after), else `not_yet`. */
export function eventHeard(
  db: Database,
  id: string,
  eventId: string
): { by?: string; told: "not_yet" | "queued" | "woken" } {
  const e = db
    .query<{ received_at: string }, [string, string]>(
      "select received_at from event where assignment_id = ? and event_id = ?"
    )
    .get(id, eventId);
  if (!e) {
    return { told: "not_yet" };
  }
  const t = db
    .query<{ agent_id: string }, [string, string]>(
      "select agent_id from turn where assignment_id = ? and cause = 'answer' and started_at >= ? order by started_at limit 1"
    )
    .get(id, e.received_at);
  return t ? { by: t.agent_id, told: "woken" } : { told: "queued" };
}

/** Assignment `id`'s quiet line's ref, as a deletion names it (`threadEntriesHolding`); the desk deletes the line on its tick. */
export const quietLineRefOf = (id: string) => `quiet:${id}`;

/** Assignment `id`'s quiet line (docs/glossary.md): what its agent last said it does now and when it expects the work done; none before it gave one, or once a deletion named it. */
export const quietLineOf = (db: Database, id: string) =>
  deletionsNow().refs.has(quietLineRefOf(id))
    ? undefined
    : (db
        .query<{ doing: string; eta: string | null }, [string]>(
          "select doing, eta from quiet_line where assignment_id = ?"
        )
        .get(id) ?? undefined);
