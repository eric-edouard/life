import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DESK_STORE } from "../core/paths";
import type { Messaging } from "../host/events";
import type {
  AgentStatus,
  AgentWait,
  MessageFilter,
} from "../records/registered-agent";
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
  check (status <> 'active' or wait_until is not null)
);
create table if not exists session (
  agent_id text not null,
  runtime text not null,
  ref text not null,
  link text not null,
  started_at text not null,
  ended_at text,
  why_ended text
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
  heard_at text,
  reminded_at text,
  ended_at text,
  outcome text,
  tokens_in integer,
  tokens_cached integer,
  tokens_out integer
);
create index if not exists turn_by_agent on turn (agent_id, id);
create table if not exists cursor (name text primary key, value text not null);
`;

/** The desk: its store, the runtimes it drives by name, and the message sources it polls (all that are on, unless a test gives its own). */
export interface Desk {
  db: Database;
  runtimes: Record<string, Runtime>;
  sources?: Messaging[];
}

/** Opens (and makes) the desk's store. */
export function openDesk(path = DESK_STORE) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { strict: true });
  db.run("pragma journal_mode = wal");
  db.run("pragma busy_timeout = 5000");
  db.run(SCHEMA);
  return db;
}

/** A registered agent's row. `status` `active` is running while a desk turn is open, else waiting. */
export interface AgentRow {
  brief: string;
  created_at: string;
  folder: string;
  id: string;
  link: string | null;
  notes: string;
  runtime: string;
  session: string | null;
  status: AgentStatus;
  wait_events: string;
  wait_is_default: number;
  wait_reason: string | null;
  wait_until: string | null;
}

/** An agent turn's row; `ended_at` null while it runs. */
export interface TurnRow {
  agent_id: string;
  cause: string;
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

/** The most agents the desk keeps active: every read of them is bounded by it. */
const MAX_ACTIVE = 50;

/** Whether the desk keeps its most agents active: no other is registered then. */
export const isFull = (db: Database) =>
  (db
    .query<{ n: number }, []>(
      "select count(*) as n from agent where status = 'active'"
    )
    .get()?.n ?? 0) >= MAX_ACTIVE;

export const activeAgents = (db: Database) =>
  db
    .query<AgentRow, [number]>(
      "select * from agent where status = 'active' order by created_at limit ?"
    )
    .all(MAX_ACTIVE);

export const agentOf = (db: Database, id: string) =>
  db.query<AgentRow, [string]>("select * from agent where id = ?").get(id);

/** An agent's last turns, newest first: enough for its open turn, its last one and a run of failures. */
export const lastTurns = (db: Database, id: string, n = 4) =>
  db
    .query<TurnRow, [string, number]>(
      "select * from turn where agent_id = ? and outcome is not 'his_own' order by id desc limit ?"
    )
    .all(id, n);

/** The desk turn running now for an agent, if any. */
export const openTurn = (db: Database, id: string) =>
  db
    .query<TurnRow, [string]>(
      "select * from turn where agent_id = ? and ended_at is null"
    )
    .get(id);

/** An agent's queued events, oldest first. */
export const queuedEvents = (db: Database, id: string) =>
  db
    .query<EventRow, [string]>(
      "select event_id, handed, name, payload, received_at from event where agent_id = ? and consumed_at is null and dropped_at is null order by rowid"
    )
    .all(id);

export const filtersOf = (a: AgentRow) =>
  JSON.parse(a.wait_events) as MessageFilter[];

export const readCursor = (db: Database, name: string) =>
  db
    .query<{ value: string }, [string]>(
      "select value from cursor where name = ?"
    )
    .get(name)?.value ?? null;

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
