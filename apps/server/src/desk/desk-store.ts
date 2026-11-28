import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { clock } from "../core/clock";
import type { Embedder } from "../core/embedder";
import { DESK_STORE } from "../core/paths";
import { openWritable } from "../core/sqlite";
import { assignmentOfCard, readCursor } from "../host/desk-read";
import { isOldShape, NOT_MIGRATED } from "../host/desk-shape";
import { HANDED_KINDS, type HandedKind } from "../host/desk-turn-reads";
import type { EventChannel } from "../host/event-channels";
import type { Messaging } from "../host/events";
import { ASK_SPOKEN, COMPLAINT_RECEIVED } from "../host/events";
import type { Decision } from "../memory/decision-lines";
import { askPlaceOf } from "../memory/memory-files";
import type { LedgerEntry } from "../records/ledger-entry";
import type { AgentWait } from "../records/registered-agent";
import type { Runtime } from "./runtimes/contract";

// The desk's store (`LIFE_STATE_DIR/desk/desk.sqlite`, WAL): the one state of the desk. Every rule reads its rows and
// `clock()` (`agent-wait.ts`); nothing about an agent is kept in memory between ticks. Readers are bounded: active
// agents, or one agent's rows. The Life thread's entries are here too (`thread_entry`: one per ask of his to the main
// session, its words and answer blankable in place, the row, its time and `deleted_at` kept), with the work each handed
// on (`handed_work`) and each one-off project's handoff (`project_handoff`: the claim on its id, his entry, the notes, the agent that took it): never `memory/`, since Life's own words are never read back as his life. A new table needs no
// store step: `SCHEMA` makes it on open (as `card` and `handed_step` were, #749).

/** At most one active or stopped agent of each role: the fresh schema's, `stepRoles`' and `stepRoleCheck`'s. */
export const ONE_AGENT_PER_ROLE =
  "create unique index if not exists one_agent_per_role on agent (role) where role is not null and status in ('active', 'stopped')";

/** A move's tables (`desk/agent-moves.ts`, the store step `stepMoves`): its row, and each runtime's last block. */
export const MOVE_TABLES = `
create table if not exists move (
  ask text primary key,
  agent_id text not null,
  assignment_id text,
  to_agent text,
  to_runtime text,
  from_runtime text,
  from_model text,
  from_effort text,
  from_session text,
  from_link text,
  asked_at text not null,
  moved_at text,
  failed_at text,
  failed text
);
create index if not exists move_by_assignment on move (assignment_id);
create index if not exists move_by_agent on move (agent_id);
create table if not exists runtime_block (
  runtime text primary key,
  why text,
  checked_at text not null
);
`;

/** The agents' table: its role is code's one list (`AgentRole`), never a check here, so a new role needs no store step. */
export const AGENT_TABLE = `
create table if not exists agent (
  id text primary key,
  brief text not null,
  runtime text not null,
  folder text not null,
  project text,
  model text,
  effort text,
  session text,
  link text,
  status text not null check (status in ('active', 'stopped', 'handed_over', 'ended')),
  name text,
  role text,
  created_at text not null,
  ended_at text,
  outcome text,
  stopped_at text
);
`;

/** The agents' indexes (`stepRoleCheck` makes them again on the rebuilt table). */
export const AGENT_INDEXES = `
${ONE_AGENT_PER_ROLE};
create index if not exists agent_by_project on agent (project);
create index if not exists agent_by_status on agent (status, ended_at);
`;

export const SCHEMA = `
${AGENT_TABLE}
${AGENT_INDEXES}
create table if not exists assignment (
  id text primary key,
  agent_id text not null,
  opened_at text not null,
  opened_by text not null check (opened_by in ('owner', 'desk')),
  said text,
  wait_events text not null default '[]',
  wait_until text,
  wait_reason text,
  wait_is_default integer not null default 0,
  notes_path text not null,
  plan_done integer,
  plan_total integer,
  plan_now text,
  closed_at text,
  outcome text,
  why_not_started text,
  matter_id text,
  check (closed_at is not null or wait_until is not null)
);
create index if not exists assignment_by_agent on assignment (agent_id, closed_at);
create table if not exists session (
  agent_id text not null,
  runtime text not null,
  ref text not null,
  link text not null,
  started_at text not null,
  ended_at text,
  why_ended text,
  context_at_first_call integer,
  rules_digest text
);
create table if not exists event (
  assignment_id text not null,
  event_id text not null,
  name text not null,
  payload text not null,
  received_at text not null,
  handed integer not null default 0,
  consumed_at text,
  dropped_at text,
  unique (assignment_id, event_id)
);
create table if not exists turn (
  id integer primary key,
  agent_id text not null,
  assignment_id text not null,
  session text,
  cause text not null,
  started_at text not null,
  begun_at text,
  heard_at text,
  reminded_at text,
  ended_at text,
  outcome text,
  tokens_in integer,
  tokens_cached integer,
  tokens_out integer,
  context_used integer,
  model text,
  move text,
  cost_usd real,
  search_usd real,
  stopped_spending integer
);
create index if not exists turn_by_agent on turn (agent_id, id);
create index if not exists turn_by_assignment on turn (assignment_id, id);
create index if not exists turn_by_ended on turn (ended_at);
create table if not exists cursor (name text primary key, value text not null);
create table if not exists anchor (
  assignment_id text not null,
  step text not null,
  added_at text not null,
  primary key (assignment_id, step)
);
create index if not exists anchor_by_step on anchor (step);
create index if not exists event_dropped on event (assignment_id, dropped_at) where dropped_at is not null;
create table if not exists report_line (
  source text not null,
  day text not null,
  line text not null,
  link text,
  posted_at text not null,
  primary key (source, day)
);
create index if not exists report_line_by_posted on report_line (posted_at);
create table if not exists agent_change (
  ask text primary key,
  agent_id text,
  error text,
  applied_at text not null
);
create index if not exists agent_change_by_applied on agent_change (applied_at);
create table if not exists card (
  decision_id text primary key,
  assignment_id text not null
);
create table if not exists main_question (
  id text primary key,
  assignment_id text not null,
  asked_at text not null,
  entry integer,
  words text not null,
  read_at text
);
create table if not exists handed_step (
  assignment_id text not null,
  step text not null,
  primary key (assignment_id, step)
);
create table if not exists thread_entry (
  id integer primary key,
  ask_key text unique,
  asked_at text not null,
  words text,
  screen text,
  turn_id integer,
  answer text,
  error text,
  refs text not null default '[]',
  reactions text not null default '[]',
  answered_at text,
  deleted_at text,
  follows integer
);
create index if not exists thread_entry_by_asked on thread_entry (asked_at);
create table if not exists handed_work (
  entry_id integer not null,
  assignment_id text not null,
  kind text not null,
  handed_at text not null,
  primary key (entry_id, assignment_id)
);
create index if not exists handed_work_by_kind on handed_work (kind, handed_at);
create table if not exists project_handoff (
  project text primary key,
  ask text not null unique,
  entry_id integer not null,
  notes text,
  agent_id text
);
${MOVE_TABLES}`;

/** The desk: its store, the runtimes it drives by name, and the message sources it polls (all that are on, unless a test gives its own). */
export interface Desk {
  /** The event channels the desk reads; none given: `EVENT_CHANNELS`. */
  channels?: EventChannel[];
  db: Database;
  /** The wide net's embedder (`matter-net.ts`); none given: Lifelog Host's (`embedderNow`), null: none. */
  embedder?: Embedder | null;
  runtimes: Record<string, Runtime>;
  sources?: Messaging[];
}

/**
 * Opens (and makes) the desk's store; one of the old shape is refused, never migrated here. Each commit is synced to disk
 * (`synchronous = full`): a card's owner row must survive a crash of the Mac before its card is written.
 */
export function openDesk(path = DESK_STORE) {
  mkdirSync(dirname(path), { recursive: true });
  const db = openWritable(path, 5000, { strict: true });
  db.run("pragma synchronous = full");
  if (isOldShape(db)) {
    db.close();
    throw new Error(NOT_MIGRATED);
  }
  db.run(SCHEMA);
  return db;
}

export const saveCursor = (db: Database, name: string, value: string | null) =>
  value === null
    ? db.run("delete from cursor where name = ?", [name])
    : db.run(
        "insert into cursor (name, value) values (?, ?) on conflict (name) do update set value = excluded.value",
        [name, value]
      );

/** The desk's cursor over the ledger for his complaints (`desk/complaint-intake.ts`): how many lines it has read. */
export const COMPLAINTS_CURSOR = "complaints";

/**
 * The desk's cursor over the ledger for his spoken asks (`desk/spoken-ask-intake.ts`): how many lines it has read, and
 * the asks read that still wait for a place (`waiting`), so one that waits never holds the scan.
 */
const SPOKEN_ASKS_CURSOR = "spoken-asks";
export interface SpokenAsksCursor {
  line: number;
  waiting: string[];
}
export const readSpokenAsksCursor = (db: Database): SpokenAsksCursor =>
  JSON.parse(readCursor(db, SPOKEN_ASKS_CURSOR) ?? '{"line":0,"waiting":[]}');
export const saveSpokenAsksCursor = (db: Database, c: SpokenAsksCursor) =>
  saveCursor(db, SPOKEN_ASKS_CURSOR, JSON.stringify(c));

/**
 * Gives back what assignment `id` received from an intake and never handed to a turn (its agent finished, or its first
 * turn never began, while one came): his complaints and his spoken asks. Their receipts (the event rows) go, and each
 * intake takes them again on its next tick, for an agent that will read them: the complaints' cursor steps back to the
 * first of them, the spoken asks join the asks that wait. In the caller's transaction.
 */
function giveBack(db: Database, id: string) {
  const back = db
    .query<{ event_id: string; name: string }, [string, string, string]>(
      "delete from event where assignment_id = ? and name in (?, ?) and handed = 0 and consumed_at is null and dropped_at is null returning event_id, name"
    )
    .all(id, COMPLAINT_RECEIVED, ASK_SPOKEN);
  const complaints = back.flatMap((e) =>
    e.name === COMPLAINT_RECEIVED ? (askPlaceOf(e.event_id) ?? []) : []
  );
  if (complaints.length > 0) {
    saveCursor(
      db,
      COMPLAINTS_CURSOR,
      String(
        Math.min(Number(readCursor(db, COMPLAINTS_CURSOR) ?? 0), ...complaints)
      )
    );
  }
  const asks = back.flatMap((e) => (e.name === ASK_SPOKEN ? e.event_id : []));
  if (asks.length > 0) {
    const c = readSpokenAsksCursor(db);
    saveSpokenAsksCursor(db, {
      ...c,
      waiting: [...new Set([...c.waiting, ...asks])],
    });
  }
}

/** Writes assignment `id`'s wait: one its agent set, or the default one. */
export const writeWait = (
  db: Database,
  id: string,
  w: AgentWait,
  isDefault: boolean
) =>
  db.run(
    "update assignment set wait_events = ?, wait_until = ?, wait_reason = ?, wait_is_default = ? where id = ?",
    [JSON.stringify(w.events), w.until, w.reason, isDefault ? 1 : 0, id]
  );

/**
 * Ends agent `agent` (`status`, `outcome`) when it holds no open assignment and no matter it gave away by a move that
 * may still roll back to it (committed, not failed, its new holder's first turn not begun: decision 78): the one ending
 * rule, after a close or a move.
 */
export const endWhenIdle = (
  db: Database,
  agent: string,
  status: "ended" | "handed_over",
  outcome: string | null
) =>
  db.run(
    `update agent set status = ?, stopped_at = null, ended_at = ?, outcome = ? where id = ?
      and not exists (select 1 from assignment s where s.agent_id = agent.id and s.closed_at is null)
      and not exists (select 1 from move m join agent_change c on c.ask = m.ask where m.agent_id = agent.id
        and m.assignment_id is not null and m.moved_at is not null and c.error is null and m.failed is null
        and not exists (select 1 from turn t where t.move = m.ask and t.cause <> 'move_notes' and t.begun_at is not null))`,
    [status, clock().toISOString(), outcome, agent]
  );

/** Work handed on from his thread entry `entry` to assignment `assignment` (`handed_work`), its `kind`, at `at`: once per entry and assignment. The one writer of `handed_work`. */
export const recordHandedWork = (
  db: Database,
  entry: number,
  assignment: string,
  kind: HandedKind,
  at: string
) =>
  db.run(
    "insert or ignore into handed_work (entry_id, assignment_id, kind, handed_at) values (?, ?, ?, ?)",
    [entry, assignment, kind, at]
  );

/**
 * The work told ask `a` handed on (`tell_agent`: his thread entry and its kind, `after.entry` and `after.kind`, kept with
 * the ask): written by `tellAgent` at once and again by the intake when it queues the ask, so a crash between the ledger
 * and the store loses nothing. An ask from before they were kept writes nothing.
 */
export function recordToldWork(db: Database, a: LedgerEntry) {
  const { entry, kind, to } = a.after;
  if (typeof entry === "number" && typeof to === "string") {
    const k = HANDED_KINDS.find((x) => x === kind) ?? "other";
    recordHandedWork(db, entry, to, k, a.at);
  }
}

/** One-off project `project`'s handoff (`project_handoff`): made of ask `ask` (an ask of the desk's id, or the main session's act's ref) from his thread entry `entry_id`, the old agent's `notes`, `agent_id` the agent its entry was handed to. The row is the claim on the project's id: one ask per project. */
export interface ProjectHandoff {
  agent_id: string | null;
  ask: string;
  entry_id: number;
  notes: string | null;
  project: string;
}

/**
 * Closes assignment `id` once (`outcome`, or `whyNotStarted` for one whose first turn never began), gives back the
 * complaints and spoken asks it never handed (`giveBack`), and ends its agent when it holds no open assignment after: the one
 * way anything closes, in the caller's transaction. Its agent must be
 * active, or, for a stopped agent he replaced by a new start (`replaced`), stopped: it then ends `handed_over`.
 * Whether it closed.
 */
export function closeAssignmentRow(
  db: Database,
  id: string,
  end: { outcome: string | null; replaced?: true; whyNotStarted?: string }
) {
  const s = db
    .query<{ agent_id: string }, [string, string]>(
      "select agent_id from assignment where id = ? and closed_at is null and (select status from agent where agent.id = assignment.agent_id) = ?"
    )
    .get(id, end.replaced ? "stopped" : "active");
  if (!s) {
    return false;
  }
  db.run(
    "update assignment set closed_at = ?, outcome = ?, why_not_started = ? where id = ?",
    [clock().toISOString(), end.outcome, end.whyNotStarted ?? null, id]
  );
  giveBack(db, id);
  endWhenIdle(
    db,
    s.agent_id,
    end.replaced ? "handed_over" : "ended",
    end.outcome
  );
  return true;
}

/**
 * Moves open assignment `id` to agent `to`, with its anchors, wait, times, events, notes file and cards: both agents'
 * cards asked before the desk kept owners are pinned to their owners first (`assignmentOfCard` over `decisions`), since
 * a move changes which assignment is either agent's first. What the old agent's sessions were shown of it is shown
 * again to the new one (`handed_step`). The agent it leaves is the caller's to end (`endWhenIdle`). In the caller's
 * transaction. The agent it left, or null when nothing moved.
 */
export function moveAssignment(
  db: Database,
  id: string,
  to: string,
  decisions: readonly Pick<Decision, "agent" | "id">[]
) {
  const from = db
    .query<{ agent_id: string }, [string]>(
      "select agent_id from assignment where id = ? and closed_at is null"
    )
    .get(id)?.agent_id;
  if (!from || from === to) {
    return null;
  }
  for (const d of decisions) {
    const owner =
      (d.agent === from || d.agent === to) && assignmentOfCard(db, d);
    if (owner) {
      db.run(
        "insert or ignore into card (decision_id, assignment_id) values (?, ?)",
        [d.id, owner]
      );
    }
  }
  db.run("update assignment set agent_id = ? where id = ?", [to, id]);
  db.run("delete from handed_step where assignment_id = ?", [id]);
  return from;
}

/** Posts a line for the report (`life desk report-line`): one per source per day, a second that day replacing it. */
export const postReportLine = (
  db: Database,
  r: { day: string; line: string; link?: string; source: string }
) =>
  db.run(
    "insert into report_line (source, day, line, link, posted_at) values (?, ?, ?, ?, ?) on conflict (source, day) do update set line = excluded.line, link = excluded.link, posted_at = excluded.posted_at",
    [r.source, r.day, r.line, r.link ?? null, clock().toISOString()]
  );
