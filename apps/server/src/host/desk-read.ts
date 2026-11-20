import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { clock, DAY, HOUR, MIN } from "../core/clock";
import { off } from "../core/outputs";
import { DESK_STORE } from "../core/paths";
import { settings } from "../core/settings";
import { openReadOnly } from "../core/sqlite";
import type { AgentHold } from "../memory/held-matters";
import type {
  AgentChange,
  AgentKind,
  AgentStatus,
  EventFilter,
} from "../records/registered-agent";
import { CALL_ENDED, MESSAGE_RECEIVED } from "./events";

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
  /** 1 when the desk started it itself on a matter from the top of his ranking (`desk/hand-out.ts`), 0 when he asked. */
  is_handed_out: number;
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
  /** When he stopped it; null unless stopped, and for an agent stopped before the column. */
  stopped_at: string | null;
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
  /** The context of its last call, in tokens (`growthOf`); null when its runtime gave none. */
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
const MAX_ACTIVE = 50;

/** Whether the desk keeps its most agents active: no other is registered then. */
export const isFull = (db: Database) =>
  (db
    .query<{ n: number }, []>(
      "select count(*) as n from agent where status = 'active'"
    )
    .get()?.n ?? 0) >= MAX_ACTIVE;

/** How many agents the desk started itself (`is_handed_out`) from `since` on (an ISO instant). */
export const handedOutSince = (db: Database, since: string) =>
  db
    .query<{ n: number }, [string]>(
      "select count(*) as n from agent where is_handed_out = 1 and created_at >= ?"
    )
    .get(since)?.n ?? 0;

/** The agents the desk started itself from `since` on, as facts: whether it ended, and why its first turn never began. */
export const handedOutAgentsSince = (db: Database, since: string) =>
  db
    .query<Pick<AgentRow, "id" | "status" | "why_not_started">, [string]>(
      "select id, status, why_not_started from agent where is_handed_out = 1 and created_at >= ? order by created_at"
    )
    .all(since);

/** The active agents the desk started itself, each with when its first turn began (`first_begun_at`, null before). */
export const handedOutActive = (db: Database) =>
  db
    .query<AgentRow & { first_begun_at: string | null }, []>(
      "select a.*, (select min(t.begun_at) from turn t where t.agent_id = a.id) as first_begun_at from agent a where a.is_handed_out = 1 and a.status = 'active'"
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
  JSON.parse(a.wait_events) as EventFilter[];

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

/** The active agent on project `project` started on `brief`, else any active agent on it, if one is: who works on it now. */
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

/** Who started agent `a` (`AgentKind`): the one test of it. */
export const agentKindOf = (a: Pick<AgentRow, "is_handed_out">): AgentKind =>
  a.is_handed_out === 1 ? "handed_out" : "asked";

/**
 * How long an ended agent's subject is read for the hold rule: one ended earlier holds nothing, so a try older than this
 * may be repeated once on a matter nobody moved (accepted: the read stays bounded).
 */
export const HOLD_DAYS = 90;

/** Every subject of an agent active, stopped or ended in the last `HOLD_DAYS`: each anchor, and each project's agent's project. */
const HELD_ROWS = `select n.rowid as anchor, a.rowid as agent, a.id as agent_id, a.status, n.step, null as project, a.ended_at, a.is_handed_out, a.outcome, a.why_not_started from anchor n join agent a on a.id = n.agent_id where a.ended_at is null or a.ended_at >= ?1
  union all select null, a.rowid, a.id, a.status, null, a.project, a.ended_at, a.is_handed_out, a.outcome, a.why_not_started from agent a where a.project is not null and (a.ended_at is null or a.ended_at >= ?1)`;
const heldSince = () =>
  new Date(clock().getTime() - HOLD_DAYS * DAY).toISOString();

/** The subjects registered agents hold, as facts (`AgentHold`): what the hold rule (`isHeldOf`) decides "held" from, against the matter book. */
export const heldByAgents = (db: Database): AgentHold[] =>
  db
    .query<
      Pick<
        AgentRow,
        | "ended_at"
        | "is_handed_out"
        | "outcome"
        | "project"
        | "status"
        | "why_not_started"
      > & { agent_id: string; step: string | null },
      [string]
    >(`${HELD_ROWS} order by agent, anchor`)
    .all(heldSince())
    .map((r) => ({
      agent: r.agent_id,
      endedAt: r.ended_at,
      kind: agentKindOf(r),
      outcome: r.outcome,
      project: r.project,
      status: r.status,
      step: r.step,
      whyNotStarted: r.why_not_started,
    }));

/** A stamp of what `heldByAgents` would read, by one cheap query (how many, the newest anchor and agent, the newest end): the inbox's key, never the list. */
export const heldStampOf = (db: Database) =>
  JSON.stringify(
    db
      .query<unknown, [string]>(
        `select count(*), max(anchor), max(agent), max(ended_at), group_concat(project) from (${HELD_ROWS})`
      )
      .values(heldSince())
  );

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

const LATE_AFTER = 10 * MIN;
const SILENT_AFTER = HOUR;
const at = (t: string) => new Date(t).getTime();

/**
 * What shows amber for an agent, worked out when read, never stored: its default wait, a deadline over 10 minutes late
 * with no turn, a turn silent (no door call) for over an hour, and its dropped events.
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
  /** When its current status began: its open turn's start (running), its last turn's end (waiting), its end (ended, handed over), its stop (stopped); null for a stopped agent stopped before its stop time was stored, or one with no turn yet. */
  statusSince: string | null;
  /** The matter steps it was handed (its anchors), when its subject is a matter. */
  steps: string[];
  /** The first line of his brief. */
  title: string;
  wait: { isDefault: boolean; reason: string; until: string } | null;
}

/** What `wakesOn` is made of, beside an agent as read: its wait's filters, and for each chat they name the name and app of the agent's own newest event there (`seenChatsOf`). Not on the wire. */
export type AgentRead = AgentNow & {
  chatsSeen: Record<string, { name: string | null; source: string | null }>;
  filters: EventFilter[];
};

/**
 * For each chat a filter of `a` names: its name and app from the newest event the desk queued for `a` there; none while
 * none of `a`'s newest `SEEN_EVENTS` came from it. Only for the reads of what wakes an agent.
 * ponytail: a chat last heard more than `SEEN_EVENTS` events ago shows no name (nothing deletes from `event`); a chat column on `event` would find it.
 */
const SEEN_EVENTS = 200;
function seenChatsOf(db: Database, a: AgentRow) {
  const chats = new Set(filtersOf(a).flatMap((f) => f.chat ?? []));
  if (chats.size === 0) {
    return {};
  }
  const recent = db
    .query<{ payload: string }, [string, number]>(
      `select payload from event where agent_id = ? and name in ('${MESSAGE_RECEIVED}', '${CALL_ENDED}') order by rowid desc limit ?`
    )
    .all(a.id, SEEN_EVENTS)
    .map(
      (r) =>
        JSON.parse(r.payload) as {
          chat?: string;
          chatName?: string;
          source?: string;
        }
    );
  const seen: AgentRead["chatsSeen"] = {};
  for (const chat of chats) {
    const e = recent.find((x) => x.chat === chat);
    if (e) {
      seen[chat] = { name: e.chatName ?? null, source: e.source ?? null };
    }
  }
  return seen;
}

const headOf = (s: string) => s.split("\n")[0]?.slice(0, 160) ?? "";

/** What shows amber for `a` (`AgentNow.amber`): nothing unless it is active. */
function amberOf(
  a: AgentRow,
  last: TurnRow | undefined,
  open: TurnRow | null,
  dropped: number,
  now: number
) {
  const f = flagsOf(a, open, dropped, now);
  return a.status === "active"
    ? [
        ...(f.defaultWait ? ["default wait"] : []),
        ...(f.late ? ["deadline late"] : []),
        ...(f.silent ? ["turn silent over an hour"] : []),
        ...(last?.outcome === "failed" ? ["last turn failed"] : []),
        ...(f.dropped > 0 ? [`${f.dropped} events dropped`] : []),
      ]
    : [];
}

/** When `a`'s current status began (`AgentNow.statusSince`), from its last turn. */
const statusSinceOf = (
  a: AgentRow,
  status: AgentNow["status"],
  last: TurnRow | undefined
) =>
  ({
    ended: a.ended_at,
    handed_over: a.ended_at,
    running: last?.started_at,
    stopped: a.stopped_at,
    waiting: last?.ended_at,
  })[status] ?? null;

/** Agent `a` as read now (`AgentNow`): its last turn, its anchors and its events dropped in the last day. */
function nowOf(
  db: Database,
  a: AgentRow,
  now: number,
  isForWakes: boolean
): AgentRead {
  const [last] = lastTurns(db, a.id, 1);
  const open = last && !last.ended_at ? last : null;
  const dropped =
    db
      .query<{ n: number }, [string, string]>(
        "select count(*) as n from event where agent_id = ? and dropped_at >= ?"
      )
      .get(a.id, new Date(now - DAY).toISOString())?.n ?? 0;
  const amber = amberOf(a, last, open, dropped, now);
  const isActive = a.status === "active";
  const waiting = open ? "running" : "waiting";
  const status = a.status === "active" ? waiting : a.status;
  return {
    amber,
    ...modelOf(a),
    chatsSeen: isForWakes && status === "waiting" ? seenChatsOf(db, a) : {},
    filters: filtersOf(a),
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
    statusSince: statusSinceOf(a, status, last),
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
 * Every registered agent worth showing: the active ones, the newest stopped ones (50 each at most), and those ended in the
 * last 7 days (a handed-over agent is not listed: its successor is). `isForWakes` also reads what only `wakesOn` needs
 * (the chats a waiting agent has seen).
 */
export function agentsNow(db: Database, now: number, isForWakes = false) {
  const rows = [
    ...activeAgents(db),
    ...db
      .query<AgentRow, [number]>(
        "select * from agent where status = 'stopped' order by created_at desc limit ?"
      )
      .all(MAX_ACTIVE),
    ...db
      .query<AgentRow, [string, number]>(
        "select * from agent where status = 'ended' and ended_at >= ? order by ended_at desc limit ?"
      )
      .all(new Date(now - 7 * DAY).toISOString(), MAX_ACTIVE),
  ];
  return rows.map((a) => nowOf(db, a, now, isForWakes));
}

/** How many past agents a matter's or a project's read lists, after its active ones. */
const PAST_SHOWN = 10;

/** The agents ever on any of `steps` (a matter's; not those handed over), active first, then the newest past ones. */
export function agentsOnSteps(
  db: Database,
  steps: string[],
  now: number,
  projects: string[] = [],
  isForWakes = false
) {
  const rows =
    steps.length === 0
      ? []
      : db
          .query<AgentRow, (string | number)[]>(
            `select distinct a.* from anchor n join agent a on a.id = n.agent_id where a.status <> 'handed_over' and n.step in (${steps.map(() => "?").join(",")}) order by a.status = 'active' desc, a.created_at desc limit ?`
          )
          .all(...steps, MAX_ACTIVE + PAST_SHOWN);
  // After the matter's own agents, the active agent of each of its projects (`projectHolderOf`).
  for (const p of projects) {
    const id = projectHolderOf(db, p);
    const agent = id && !rows.some((a) => a.id === id) ? agentOf(db, id) : null;
    if (agent) {
      rows.push(agent);
    }
  }
  return rows.map((a) => nowOf(db, a, now, isForWakes));
}

/** The agents on any of `projects` (not those handed over), active first, then the newest past ones. */
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
      `select * from agent where status <> 'handed_over' and project in (${projects.map(() => "?").join(",")}) order by status = 'active' desc, created_at desc limit ?`
    )
    .all(...projects, MAX_ACTIVE + PAST_SHOWN)
    .map((a) => nowOf(db, a, now, false));
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
