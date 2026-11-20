import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { clock, DAY } from "../core/clock";
import { off } from "../core/outputs";
import { DESK_STORE } from "../core/paths";
import { settings } from "../core/settings";
import { openReadOnly } from "../core/sqlite";
import type { AgentHold, StandingAgent } from "../memory/held-matters";
import type {
  AgentChange,
  AgentRole,
  AgentStatus,
  EventFilter,
  OpenedBy,
} from "../records/registered-agent";
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
  /** Where its notes are: a file in his agents repo (`desk.agentsRepo`), else under the desk's folders. */
  notes_path: string;
  opened_at: string;
  opened_by: OpenedBy;
  /** How it closed, in the agent's words (`finish`) or the desk's ("its matter is done"); null for one never started. */
  outcome: string | null;
  plan_done: number | null;
  plan_now: string | null;
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
  outcome: string | null;
  reminded_at: string | null;
  session: string | null;
  started_at: string;
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
      Pick<AssignmentRow, "closed_at" | "id" | "why_not_started">,
      [string]
    >(
      "select id, closed_at, why_not_started from assignment where opened_by = 'desk' and opened_at >= ? order by opened_at"
    )
    .all(since);

/** The open assignments the desk opened itself, of active agents, each with when its holder's first turn on it began (`first_begun_at`: after the last turn another agent ran on it, so a moved one counts from its new holder; null before). */
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

/** The agent wait an active agent still holds for this assignment, flagged when it is the default. */
export const agentWaitOf = (a: AgentRow, s: AssignmentRow) =>
  isWaiting(a, s) && s.wait_until
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
  const inRepo = relative(agentsRepo, a.folder);
  if (inRepo && !inRepo.startsWith("..") && !inRepo.startsWith("/")) {
    return a.folder;
  }
  return a.project ? join(agentsRepo, `project-${a.project}`) : null;
}

/** Which assignment owns card `d`: the one that asked it, written once when asked (`card`, `askDecision`), never worked out from anchors that move; one asked before the desk kept owners (20 Nov 2026), its asker's first assignment (its one then); none for a card no registered agent asked. */
export const assignmentOfCard = (
  db: Database,
  d: { agent?: string; id: string }
) =>
  d.agent
    ? (db
        .query<{ id: string }, [string]>(
          "select assignment_id as id from card where decision_id = ?"
        )
        .get(d.id)?.id ??
      db
        .query<{ id: string }, [string]>(
          "select id from assignment where agent_id = ? order by opened_at, rowid limit 1"
        )
        .get(d.agent)?.id ??
      null)
    : null;

/** Who holds each card of an open assignment now: that assignment's agent (`assignmentOfCard`'s row), by the card's id: the agent a card is shown as asked by, whoever asked it. Bounded: the open assignments' cards. */
export const cardHoldersOf = (db: Database): Record<string, string> =>
  Object.fromEntries(
    db
      .query<{ agent_id: string; decision_id: string }, []>(
        "select c.decision_id, s.agent_id from card c join assignment s on s.id = c.assignment_id where s.closed_at is null"
      )
      .all()
      .map((r) => [r.decision_id, r.agent_id])
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
const CARETAKER_EVENTS = `select e.*, s.closed_at, s.plan_now, s.id as assignment from event e join assignment s on s.id = e.assignment_id join agent a on a.id = s.agent_id where a.role = 'caretaker' and e.name = '${COMPLAINT_RECEIVED}'`;

/** Where complaint `ask` was received (its receipt: the event row the desk queued for a caretaker's assignment), or null before. */
export const complaintReceiptOf = (db: Database, ask: string) =>
  db
    .query<{ assignment: string; received_at: string }, [string]>(
      `${CARETAKER_EVENTS} and e.event_id = ?`
    )
    .get(ask);

/**
 * His complaints the caretaker is at work on, in the order received: each received for an assignment still open, its
 * event not dropped; with its assignment's line (`plan_now`) only when this complaint is all that assignment holds, so
 * a line is never shown on a complaint it is not about. Bounded: the caretaker's open assignments.
 */
export const complaintsAtWork = (db: Database) =>
  db
    .query<{ ask: string; line: string | null; since: string }, []>(
      `select e.event_id as ask, e.received_at as since, case when (select count(*) from event x where x.assignment_id = e.assignment and x.name = '${COMPLAINT_RECEIVED}') = 1 then e.plan_now end as line from (${CARETAKER_EVENTS} and s.closed_at is null and e.dropped_at is null) e order by e.received_at, e.event_id`
    )
    .all();

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
export function readStartFacts(db: Database, ask: string, steps?: string[]) {
  const change = agentChangeOf(db, ask);
  const id = change?.agent_id;
  // On a matter, its agent's assignment anchored on any of `steps` (open first, as Start found it, then newest); else its own.
  const assignment =
    (id &&
      db
        .query<AssignmentRow, [string, string | null]>(
          "select * from assignment s where agent_id = ?1 and iif(?2 is null, id not in (select assignment_id from anchor), id in (select assignment_id from anchor where step in (select value from json_each(?2)))) order by closed_at is not null, opened_at desc limit 1"
        )
        .get(id, steps ? JSON.stringify(steps) : null)) ||
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

/** The runtime a start names, else the desk's default. */
export const runtimeOf = (c: Pick<AgentChange, "runtime">) =>
  c.runtime ?? settings().desk?.defaultRuntime;

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

/** One ended turn's tokens, written when it ended (`close()`). */
export interface TurnTokens {
  agent_id: string;
  ended_at: string;
  tokens_cached: number;
  tokens_in: number;
  tokens_out: number;
}

/** The turns that ended since `since` (the last report), by `turn_by_ended`: a turn running across a report shows in the next. */
export const tokensSince = (db: Database, since: string) =>
  db
    .query<TurnTokens, [string]>(
      "select agent_id, ended_at, coalesce(tokens_in, 0) as tokens_in, coalesce(tokens_cached, 0) as tokens_cached, coalesce(tokens_out, 0) as tokens_out from turn where ended_at > ? order by ended_at"
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
          .filter((s) => relative(state, s.notes_path).startsWith(".."));
  } finally {
    db.close();
  }
}

const hasColumn = (db: Database, table: string, column: string) =>
  db
    .query(`select 1 from pragma_table_info('${table}') where name = ?`)
    .get(column) !== null;

/** Whether the store predates assignments (`desk/store-step.ts`'s `stepStore` reshapes it). */
export const isBeforeAssignments = (db: Database) =>
  hasColumn(db, "agent", "wait_events");

/** Whether the store's agents predate roles (`stepRoles` reshapes it): a store that has agents and no `role`. */
export const isBeforeRoles = (db: Database) =>
  hasColumn(db, "agent", "id") && !hasColumn(db, "agent", "role");

/** Whether the store at `db` is of an old shape: only the desk helper's store steps (`desk/store-step.ts`) change it. */
export const isOldShape = (db: Database) =>
  isBeforeAssignments(db) || isBeforeRoles(db);

/** Why a store of the old shape is not read: the desk helper's store step has not run on it (its log says why). */
export const NOT_MIGRATED =
  "not migrated: the desk helper's store step has not run on it (its log says why)";

/** What reading the desk's store gave: nothing while the desk is off, why when it could not be read. */
export type DeskRead<T> =
  | { state: "off" }
  | { state: "unreadable"; why: string }
  | { state: "ok"; value: T };

/**
 * Reads the desk's store read-only with `read`; `empty` when the desk has made none yet. Never throws: the desk off or
 * its store unreadable is a state its reader shows.
 */
export function readDesk<T>(read: (db: Database) => T, empty: T): DeskRead<T> {
  if (off("desk")) {
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

/** Whether the desk has queued the event `eventId` for assignment `id` (`queued`) and then started a turn for it (`woken`: a turn of cause `answer` begun after), else `not_yet`. */
export function eventHeard(db: Database, id: string, eventId: string) {
  const e = db
    .query<{ received_at: string }, [string, string]>(
      "select received_at from event where assignment_id = ? and event_id = ?"
    )
    .get(id, eventId);
  if (!e) {
    return "not_yet";
  }
  return db
    .query<{ n: number }, [string, string]>(
      "select count(*) as n from turn where assignment_id = ? and cause = 'answer' and started_at >= ?"
    )
    .get(id, e.received_at)?.n
    ? "woken"
    : "queued";
}
