import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { clock } from "../core/clock";
import type { Embedder } from "../core/embedder";
import { DESK_STORE } from "../core/paths";
import { openWritable } from "../core/sqlite";
import { isOldShape, NOT_MIGRATED, readCursor } from "../host/desk-read";
import type { EventChannel } from "../host/event-channels";
import type { Messaging } from "../host/events";
import { COMPLAINT_RECEIVED } from "../host/events";
import { askPlaceOf } from "../memory/memory-files";
import type { AgentWait } from "../records/registered-agent";
import type { Runtime } from "./runtimes/contract";

// The desk's store (`LIFE_STATE_DIR/desk/desk.sqlite`, WAL): the one state of the desk. Every rule reads its rows and
// `clock()` (`agent-wait.ts`); nothing about an agent is kept in memory between ticks. Readers are bounded: active
// agents, or one agent's rows.

export const SCHEMA = `
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
  role text check (role in ('personal', 'caretaker')),
  created_at text not null,
  ended_at text,
  outcome text,
  stopped_at text
);
create unique index if not exists one_agent_per_role on agent (role) where role is not null and status in ('active', 'stopped');
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
  context_used integer
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
create index if not exists agent_by_project on agent (project);
create index if not exists agent_by_status on agent (status, ended_at);
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
create table if not exists handed_step (
  assignment_id text not null,
  step text not null,
  primary key (assignment_id, step)
);
`;

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
 * Gives back the complaints assignment `id` received and never handed to a turn (the caretaker finished, or its first
 * turn never began, while one came): their receipts go and the intake's cursor steps back to the first of them, so the
 * next tick receives them again, for a caretaker that will read them. In the caller's transaction.
 */
function giveBackComplaints(db: Database, id: string) {
  const back = db
    .query<{ event_id: string }, [string, string]>(
      "delete from event where assignment_id = ? and name = ? and handed = 0 and consumed_at is null and dropped_at is null returning event_id"
    )
    .all(id, COMPLAINT_RECEIVED)
    .flatMap((e) => askPlaceOf(e.event_id) ?? []);
  if (back.length > 0) {
    saveCursor(
      db,
      COMPLAINTS_CURSOR,
      String(Math.min(Number(readCursor(db, COMPLAINTS_CURSOR) ?? 0), ...back))
    );
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
 * Closes assignment `id` once (`outcome`, or `whyNotStarted` for one whose first turn never began), gives back the
 * complaints it never handed (`giveBackComplaints`), and ends its agent when it holds no open assignment after: the one
 * way anything closes, in the caller's transaction. Its agent must be
 * active, or, for a stopped agent he replaced by a new start (`replaced`), stopped: it then ends `handed_over`.
 * Whether it closed.
 */
export function closeAssignmentRow(
  db: Database,
  id: string,
  end: { outcome: string | null; replaced?: true; whyNotStarted?: string }
) {
  const at = clock().toISOString();
  const closed = db.run(
    "update assignment set closed_at = ?, outcome = ?, why_not_started = ? where id = ? and closed_at is null and (select status from agent where agent.id = assignment.agent_id) = ?",
    [
      at,
      end.outcome,
      end.whyNotStarted ?? null,
      id,
      end.replaced ? "stopped" : "active",
    ]
  ).changes;
  if (closed > 0) {
    giveBackComplaints(db, id);
    db.run(
      "update agent set status = ?, stopped_at = null, ended_at = ?, outcome = ? where id = (select agent_id from assignment where id = ?) and not exists (select 1 from assignment s where s.agent_id = agent.id and s.closed_at is null)",
      [end.replaced ? "handed_over" : "ended", at, end.outcome, id]
    );
  }
  return closed > 0;
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
