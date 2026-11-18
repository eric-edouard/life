import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { clock, DAY, HOUR, MIN } from "../core/clock";
import { off } from "../core/outputs";
import { DESK_STORE } from "../core/paths";
import { settings } from "../core/settings";
import { openReadOnly } from "../core/sqlite";
import { NEW_MATTER_DAYS } from "../memory/checks";
import type { AgentStatus, MessageFilter } from "../records/registered-agent";

// Every read of the desk's store (`LIFE_STATE_DIR/desk/desk.sqlite`), its rows' shapes and the rules worked out from
// them: the desk reads through these, and host reads the store read-only (`readDesk`), so the desk off or its store
// unreadable never breaks a read, the report or the status. Only the desk writes it (`desk/desk-store.ts`). Readers are
// bounded: active agents (50 at most), a window of days, or one agent's rows.

/** A registered agent's row. `status` `active` is running while a desk turn is open, else waiting. */
export interface AgentRow {
  brief: string;
  created_at: string;
  effort: string | null;
  ended_at: string | null;
  folder: string;
  id: string;
  link: string | null;
  model: string | null;
  notes: string;
  /** How it ended, in its own words (`finish`), or the desk's ("its matter is done"); null for one never started. */
  outcome: string | null;
  /** Its subject when it is a project of `truth/` (else its anchors are). */
  project: string | null;
  runtime: string;
  session: string | null;
  status: AgentStatus;
  wait_events: string;
  wait_is_default: number;
  wait_reason: string | null;
  wait_until: string | null;
  /** Why its first turn never began (`endNotStarted`): it was ended, and its matter is free for a new start. */
  why_not_started: string | null;
}

/** An agent turn's row; `ended_at` null while it runs. */
export interface TurnRow {
  agent_id: string;
  /** When its runtime reported it under way; null before, and for turns older than the column. */
  begun_at: string | null;
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

/** The most agents the desk keeps active, and of each other kind a read lists: every read of them is bounded by it. */
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
      "select * from turn where agent_id = ? order by id desc limit ?"
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

/** An agent's anchors: the matter steps it was handed, in order. */
export const anchorsOf = (db: Database, id: string) =>
  db
    .query<{ step: string }, [string]>(
      "select step from anchor where agent_id = ? order by rowid"
    )
    .all(id)
    .map((r) => r.step);

/** The active agent holding any of `steps` by an anchor, if one does: a matter has one at most. */
export const holderOf = (db: Database, steps: string[]) =>
  steps.length === 0
    ? null
    : (db
        .query<{ id: string }, string[]>(
          `select a.id from anchor n join agent a on a.id = n.agent_id where a.status = 'active' and n.step in (${steps.map(() => "?").join(",")}) limit 1`
        )
        .get(...steps)?.id ?? null);

/** The active agent on project `project` started on `brief`, else any active agent on it, if one is. */
export const projectHolderOf = (
  db: Database,
  project: string,
  brief?: string
) =>
  db
    .query<{ id: string }, [string, string | null]>(
      "select id from agent where status = 'active' and project = ? order by brief = ? desc limit 1"
    )
    .get(project, brief ?? null)?.id ?? null;

/**
 * Every step an agent is anchored on now (`re_point` drops an agent's old anchors), but one never started (its matter is
 * free for a new start): of every live agent, and of those ended in the last `NEW_MATTER_DAYS` (one ended before holds no
 * matter a new matter check offers: its matter began before it did).
 */
export const anchoredSteps = (db: Database) =>
  db
    .query<{ step: string }, [string]>(
      "select distinct n.step from anchor n join agent a on a.id = n.agent_id where a.why_not_started is null and (a.status <> 'ended' or a.ended_at >= ?)"
    )
    .all(new Date(clock().getTime() - NEW_MATTER_DAYS * DAY).toISOString())
    .map((r) => r.step);

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
 * its newest session, its first turn and its status, each null until written.
 */
export function readStartFacts(db: Database, ask: string) {
  const change = agentChangeOf(db, ask);
  const id = change?.agent_id;
  const one = <T>(sql: string) =>
    (id ? db.query<T, [string]>(sql).get(id) : null) ?? null;
  return {
    agent: id ? agentOf(db, id) : null,
    change,
    session: one<{ link: string; ref: string; started_at: string }>(
      "select ref, link, started_at from session where agent_id = ? order by rowid desc limit 1"
    ),
    turn: one<{ begun_at: string | null }>(
      "select begun_at from turn where agent_id = ? order by id limit 1"
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

const LATE_AFTER = 10 * MIN;
const SILENT_AFTER = HOUR;
const at = (t: string) => new Date(t).getTime();

/**
 * What shows amber for an agent, worked out when read, never stored: its default wait, a deadline over 10 minutes late
 * with no turn, a turn silent (no door call, no hook) for over an hour, and its dropped events.
 */
export function flagsOf(
  a: AgentRow,
  open: TurnRow | null,
  dropped: number,
  now: number
) {
  const heard = open
    ? Math.max(
        ...[open.started_at, open.heard_at, open.reminded_at].map((t) =>
          t ? at(t) : 0
        )
      )
    : 0;
  return {
    defaultWait: a.wait_is_default === 1,
    dropped,
    late: !open && a.wait_until !== null && now - at(a.wait_until) > LATE_AFTER,
    silent: open !== null && now - heard > SILENT_AFTER,
  };
}

/** A registered agent as read now: what it works on, where it stands, what it waits for, its last turn, its link. */
export interface AgentNow {
  /** What shows amber: a default wait, a late deadline, a silent turn, a failed last turn, events dropped in the last day. */
  amber: string[];
  effort: string | null;
  id: string;
  lastTurn: {
    cause: string;
    endedAt: string | null;
    outcome: string | null;
    startedAt: string;
  } | null;
  link: string | null;
  model: string | null;
  /** The first line of its notes: what it took its subject to be. */
  notes: string;
  /** Why its first turn never began, when it did not (it was ended). */
  notStarted: string | null;
  /** How it ended, when it did. */
  outcome: string | null;
  project: string | null;
  runtime: string;
  status: Exclude<AgentStatus, "active"> | "running" | "waiting";
  /** The matter steps it was handed (its anchors), when its subject is a matter. */
  steps: string[];
  /** The first line of his brief. */
  title: string;
  wait: { isDefault: boolean; reason: string; until: string } | null;
}

const headOf = (s: string) => s.split("\n")[0]?.slice(0, 160) ?? "";

/** Agent `a` as read now (`AgentNow`): its last turn, its anchors and its events dropped in the last day. */
function nowOf(db: Database, a: AgentRow, now: number): AgentNow {
  const [last] = lastTurns(db, a.id, 1);
  const open = last && !last.ended_at ? last : null;
  const dropped =
    db
      .query<{ n: number }, [string, string]>(
        "select count(*) as n from event where agent_id = ? and dropped_at >= ?"
      )
      .get(a.id, new Date(now - DAY).toISOString())?.n ?? 0;
  const f = flagsOf(a, open, dropped, now);
  const isActive = a.status === "active";
  const amber = isActive
    ? [
        ...(f.defaultWait ? ["default wait"] : []),
        ...(f.late ? ["deadline late"] : []),
        ...(f.silent ? ["turn silent over an hour"] : []),
        ...(last?.outcome === "failed" ? ["last turn failed"] : []),
        ...(f.dropped > 0 ? [`${f.dropped} events dropped`] : []),
      ]
    : [];
  const waiting = open ? "running" : "waiting";
  const status = a.status === "active" ? waiting : a.status;
  return {
    amber,
    ...modelOf(a),
    id: a.id,
    lastTurn: last
      ? {
          cause: last.cause,
          endedAt: last.ended_at,
          outcome: last.outcome,
          startedAt: last.started_at,
        }
      : null,
    link: a.link,
    notes: headOf(a.notes),
    notStarted: a.why_not_started,
    outcome: a.outcome,
    project: a.project,
    runtime: a.runtime,
    status,
    steps: anchorsOf(db, a.id),
    title: headOf(a.brief),
    wait:
      isActive && a.wait_until
        ? {
            isDefault: a.wait_is_default === 1,
            reason: a.wait_reason ?? "",
            until: a.wait_until,
          }
        : null,
  };
}

/**
 * Every registered agent worth showing: the active ones, the newest stopped ones (50 each at most), and those ended or
 * handed over in the last 7 days.
 */
export function agentsNow(db: Database, now: number) {
  const rows = [
    ...activeAgents(db),
    ...db
      .query<AgentRow, [number]>(
        "select * from agent where status = 'stopped' order by created_at desc limit ?"
      )
      .all(MAX_ACTIVE),
    ...db
      .query<AgentRow, [string, number]>(
        "select * from agent where status in ('ended', 'handed_over') and ended_at >= ? order by ended_at desc limit ?"
      )
      .all(new Date(now - 7 * DAY).toISOString(), MAX_ACTIVE),
  ];
  return rows.map((a) => nowOf(db, a, now));
}

/** How many past agents a matter's or a project's read lists, after its active ones. */
const PAST_SHOWN = 10;

/** The agents ever on any of `steps` (a matter's), active first, then the newest past ones. */
export function agentsOnSteps(db: Database, steps: string[], now: number) {
  if (steps.length === 0) {
    return [];
  }
  const rows = db
    .query<AgentRow, (string | number)[]>(
      `select distinct a.* from anchor n join agent a on a.id = n.agent_id where n.step in (${steps.map(() => "?").join(",")}) order by a.status = 'active' desc, a.created_at desc limit ?`
    )
    .all(...steps, MAX_ACTIVE + PAST_SHOWN);
  return rows.map((a) => nowOf(db, a, now));
}

/** The agents on any of `projects`, active first, then the newest past ones. */
export function agentsOnProjects(
  db: Database,
  projects: string[],
  now: number
) {
  if (projects.length === 0) {
    return [];
  }
  return db
    .query<AgentRow, (string | number)[]>(
      `select * from agent where project in (${projects.map(() => "?").join(",")}) order by status = 'active' desc, created_at desc limit ?`
    )
    .all(...projects, MAX_ACTIVE + PAST_SHOWN)
    .map((a) => nowOf(db, a, now));
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
    return { state: "ok", value: read(db) };
  } catch (e) {
    return { state: "unreadable", why: (e as Error).message };
  } finally {
    db?.close();
  }
}

/** Whether the desk has queued the event `eventId` for `agent` (`queued`) and then started a turn for it (`woken`: a turn of cause `answer` begun after), else `not_yet`. */
export function eventHeard(db: Database, agent: string, eventId: string) {
  const e = db
    .query<{ received_at: string }, [string, string]>(
      "select received_at from event where agent_id = ? and event_id = ?"
    )
    .get(agent, eventId);
  if (!e) {
    return "not_yet";
  }
  return db
    .query<{ n: number }, [string, string]>(
      "select count(*) as n from turn where agent_id = ? and cause = 'answer' and started_at >= ?"
    )
    .get(agent, e.received_at)?.n
    ? "woken"
    : "queued";
}
