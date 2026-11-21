import type { Database } from "bun:sqlite";
import { DAY, HOUR, MIN } from "../core/clock";
import type {
  AgentRole,
  AgentStatus,
  EventFilter,
} from "../records/registered-agent";
import {
  type AgentRow,
  type AssignmentRow,
  activeAgents,
  agentWaitOf,
  anchorsOf,
  assignmentOf,
  currentAssignmentOf,
  filtersOf,
  MAX_ACTIVE,
  modelOf,
  readNotes,
  type TurnRow,
} from "./desk-read";
import { CALL_ENDED, MESSAGE_RECEIVED } from "./events";

// A registered agent as read now (`AgentNow`), from the desk's store: what it works on, where it stands, what it waits
// for, its last turn and what shows amber; for every reader of agents (the connector, the report, the status). Bounded
// as `desk-read.ts`'s reads are.

const LATE_AFTER = 10 * MIN;
const SILENT_AFTER = HOUR;
const at = (t: string) => new Date(t).getTime();

/**
 * What shows amber for an agent, worked out when read, never stored: its default wait, a deadline over 10 minutes late
 * with no turn, a turn silent (no door call) for over an hour, and its dropped events.
 */
export function flagsOf(
  a: Pick<AssignmentRow, "wait_is_default" | "wait_until">,
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

/** The wait as the connector shows it: its deadline and reason, never its filters (a chat id in them stays in the agent's packet). */
const waitOf = (a: AgentRow, s: AssignmentRow) => {
  const w = agentWaitOf(a, s);
  return w && { isDefault: w.isDefault, reason: w.reason, until: w.until };
};

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
  /** The matter he chose for its current assignment (`matter_id`), which the finder takes on a tie among its steps' matters; null: none chosen. */
  matterId: string | null;
  model: string | null;
  /** The first line of its notes: what it took its subject to be; none for the caretaker (its notes are about his complaints). */
  notes: string;
  /** Why its first turn never began, when it did not (it was ended). */
  notStarted: string | null;
  /** How it ended, when it did. */
  outcome: string | null;
  project: string | null;
  /** Its standing role (`personal`, `caretaker`): what the app calls it ("the Personal agent"); null for any other. */
  role: AgentRole | null;
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
  /** The assignment it is read by (`currentAssignmentOf`); null when it holds none. */
  assignment: string | null;
  chatsSeen: Record<string, { name: string | null; source: string | null }>;
  filters: EventFilter[];
};

/**
 * For each chat a filter of `s` names: its name and app from the newest event the desk queued for `s` there; none while
 * none of `s`'s newest `SEEN_EVENTS` came from it. Only for the reads of what wakes an agent.
 * ponytail: a chat last heard more than `SEEN_EVENTS` events ago shows no name (nothing deletes from `event`); a chat column on `event` would find it.
 */
const SEEN_EVENTS = 200;
function seenChatsOf(db: Database, s: AssignmentRow) {
  const chats = new Set(filtersOf(s).flatMap((f) => f.chat ?? []));
  if (chats.size === 0) {
    return {};
  }
  const recent = db
    .query<{ payload: string }, [string, number]>(
      `select payload from event where assignment_id = ? and name in ('${MESSAGE_RECEIVED}', '${CALL_ENDED}') order by rowid desc limit ?`
    )
    .all(s.id, SEEN_EVENTS)
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

/** What shows amber for `a` on its assignment `s` (`AgentNow.amber`): nothing unless it is active. */
function amberOf(
  a: AgentRow,
  s: AssignmentRow,
  last: TurnRow | undefined,
  open: TurnRow | null,
  dropped: number,
  now: number
) {
  const f = flagsOf(s, open, dropped, now);
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

/** What agent `a`'s assignment `s` adds to its read (its last turn `last`, open or not): none when it holds none (the fold moved its last away). */
function subjectPartOf(
  db: Database,
  a: AgentRow,
  s: AssignmentRow | undefined,
  {
    isForWakes,
    last,
    now,
    status,
  }: {
    isForWakes: boolean;
    last: TurnRow | undefined;
    now: number;
    status: AgentNow["status"];
  }
) {
  if (!s) {
    return {
      amber: [],
      assignment: null,
      chatsSeen: {},
      filters: [],
      matterId: null,
      notes: "",
      notStarted: null,
      steps: [],
      wait: null,
    };
  }
  const dropped =
    db
      .query<{ n: number }, [string, string]>(
        "select count(*) as n from event where assignment_id = ? and dropped_at >= ?"
      )
      .get(s.id, new Date(now - DAY).toISOString())?.n ?? 0;
  const open = last && !last.ended_at ? last : null;
  return {
    amber: amberOf(a, s, last, open, dropped, now),
    assignment: s.id,
    chatsSeen: isForWakes && status === "waiting" ? seenChatsOf(db, s) : {},
    filters: filtersOf(s),
    matterId: s.matter_id,
    // The caretaker's notes are about his complaints: they stay with it, never in a read or the nightly.
    notes: a.role === "caretaker" ? "" : headOf(readNotes(s)),
    notStarted: s.why_not_started,
    steps: anchorsOf(db, s.id),
    wait: waitOf(a, s),
  };
}

/** Agent `a` as read now (`AgentNow`), by the assignment it works on (`on`, else `currentAssignmentOf`; `subjectPartOf`): its last turn, its anchors and its events dropped in the last day. */
function nowOf(
  db: Database,
  a: AgentRow,
  now: number,
  isForWakes: boolean,
  on?: AssignmentRow
): AgentRead {
  const last =
    db
      .query<TurnRow, [string]>(
        "select * from turn where agent_id = ? order by id desc limit 1"
      )
      .get(a.id) ?? undefined;
  const waiting = last && !last.ended_at ? "running" : "waiting";
  const status = a.status === "active" ? waiting : a.status;
  return {
    ...subjectPartOf(db, a, on ?? currentAssignmentOf(db, a.id) ?? undefined, {
      isForWakes,
      last,
      now,
      status,
    }),
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
    outcome: a.outcome,
    project: a.project,
    role: a.role,
    runtime: a.runtime,
    status,
    statusSince: statusSinceOf(a, status, last),
    title: headOf(a.brief),
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

/** The agents ever on any of `steps` (a matter's; not those handed over), active first, then the newest past ones; each read by its assignment on those steps (an open one first), never another it holds. */
export function agentsOnSteps(
  db: Database,
  steps: string[],
  now: number,
  isForWakes = false
) {
  if (steps.length === 0) {
    return [];
  }
  const rows = db
    .query<AgentRow & { on_assignment: string }, string[]>(
      `select distinct s.id as on_assignment, a.* from anchor n join assignment s on s.id = n.assignment_id join agent a on a.id = s.agent_id where a.status <> 'handed_over' and n.step in (${steps.map(() => "?").join(",")}) order by a.status = 'active' desc, a.created_at desc, s.closed_at is null desc, s.opened_at desc`
    )
    .all(...steps);
  const seen = new Set<string>();
  return rows
    .filter((r) => !seen.has(r.id) && seen.add(r.id))
    .slice(0, MAX_ACTIVE + PAST_SHOWN)
    .map((r) =>
      nowOf(
        db,
        r,
        now,
        isForWakes,
        assignmentOf(db, r.on_assignment) ?? undefined
      )
    );
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
