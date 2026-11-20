import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { clock } from "../core/clock";
import type { Embedder } from "../core/embedder";
import { DESK_STORE } from "../core/paths";
import { openWritable } from "../core/sqlite";
import type { EventChannel } from "../host/event-channels";
import type { Messaging } from "../host/events";
import type { AgentWait } from "../records/registered-agent";
import type { Runtime } from "./runtimes/contract";

// The desk's store (`LIFE_STATE_DIR/desk/desk.sqlite`, WAL): the one state of the desk. Every rule reads its rows and
// `clock()` (`agent-wait.ts`); nothing about an agent is kept in memory between ticks. Readers are bounded: active
// agents, or one agent's rows.

const SCHEMA = `
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
  wait_events text not null default '[]',
  wait_until text,
  wait_reason text,
  wait_is_default integer not null default 0,
  notes text not null default '',
  created_at text not null,
  ended_at text,
  outcome text,
  why_not_started text,
  stopped_at text,
  is_handed_out integer not null default 0,
  check (status <> 'active' or wait_until is not null)
);
create table if not exists session (
  agent_id text not null,
  runtime text not null,
  ref text not null,
  link text not null,
  started_at text not null,
  ended_at text,
  why_ended text,
  context_at_first_call integer
);
create table if not exists event (
  agent_id text not null,
  event_id text not null,
  name text not null,
  payload text not null,
  received_at text not null,
  handed integer not null default 0,
  consumed_at text,
  dropped_at text,
  unique (agent_id, event_id)
);
create table if not exists turn (
  id integer primary key,
  agent_id text not null,
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
create index if not exists turn_by_ended on turn (ended_at);
create table if not exists cursor (name text primary key, value text not null);
create table if not exists anchor (
  agent_id text not null,
  step text not null,
  added_at text not null,
  primary key (agent_id, step)
);
create index if not exists anchor_by_step on anchor (step);
create index if not exists agent_by_project on agent (project);
create index if not exists agent_by_status on agent (status, ended_at);
create index if not exists event_dropped on event (agent_id, dropped_at) where dropped_at is not null;
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

/** Adds `column` (`ddl` its type and default) to `table` in a store made before it, and `backfill`s its older rows, in one transaction. */
function ensureColumn(
  db: Database,
  table: string,
  column: string,
  ddl: string,
  backfill?: string
) {
  if (
    db
      .query(`select 1 from pragma_table_info('${table}') where name = ?`)
      .get(column)
  ) {
    return;
  }
  db.transaction(() => {
    db.run(`alter table ${table} add column ${column} ${ddl}`);
    if (backfill) {
      db.run(backfill);
    }
  })();
}

/** Opens (and makes) the desk's store. */
export function openDesk(path = DESK_STORE) {
  mkdirSync(dirname(path), { recursive: true });
  const db = openWritable(path, 5000, { strict: true });
  db.run(SCHEMA);
  // Each column a store made before it lacks, with what its older rows hold.
  // `turn.begun_at`: its old turns were under way, so they begin when they started (null means never began).
  ensureColumn(
    db,
    "turn",
    "begun_at",
    "text",
    "update turn set begun_at = started_at"
  );
  // `agent.why_not_started`: an agent never started was its outcome's "not started: " prefix (`glob` keeps case: an
  // agent's own "Not started: …" stays its outcome).
  ensureColumn(
    db,
    "agent",
    "why_not_started",
    "text",
    "update agent set why_not_started = substr(outcome, 14), outcome = null where outcome glob 'not started: *'"
  );
  // `agent.stopped_at`: an agent stopped then has no stop time stored.
  ensureColumn(db, "agent", "stopped_at", "text");
  // `agent.is_handed_out`: every older agent was started on his word.
  ensureColumn(db, "agent", "is_handed_out", "integer not null default 0");
  // The two context columns (`growthOf`): older sessions and turns have none, so they grow 0.
  ensureColumn(db, "session", "context_at_first_call", "integer");
  ensureColumn(db, "turn", "context_used", "integer");
  return db;
}

export const saveCursor = (db: Database, name: string, value: string | null) =>
  value === null
    ? db.run("delete from cursor where name = ?", [name])
    : db.run(
        "insert into cursor (name, value) values (?, ?) on conflict (name) do update set value = excluded.value",
        [name, value]
      );

/** Writes an agent's wait: one an agent set, or the default one. */
export const writeWait = (
  db: Database,
  id: string,
  w: AgentWait,
  isDefault: boolean
) =>
  db.run(
    "update agent set wait_events = ?, wait_until = ?, wait_reason = ?, wait_is_default = ? where id = ?",
    [JSON.stringify(w.events), w.until, w.reason, isDefault ? 1 : 0, id]
  );

/** Posts a line for the report (`life desk report-line`): one per source per day, a second that day replacing it. */
export const postReportLine = (
  db: Database,
  r: { day: string; line: string; link?: string; source: string }
) =>
  db.run(
    "insert into report_line (source, day, line, link, posted_at) values (?, ?, ?, ?, ?) on conflict (source, day) do update set line = excluded.line, link = excluded.link, posted_at = excluded.posted_at",
    [r.source, r.day, r.line, r.link ?? null, clock().toISOString()]
  );
