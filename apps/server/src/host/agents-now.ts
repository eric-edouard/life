import type { Database } from "bun:sqlite";
import { DAY, HOUR, MIN } from "../core/clock";
import type { AgentRole } from "../core/names";
import { isOwnLife } from "../core/platform";
import type { AgentStatus, EventFilter } from "../records/registered-agent";
import { agentHealthOf, type Health, type HealthFacts } from "./agent-health";
import { readClaudeAppListing } from "./claude-app-listing";
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
import { runtimeBlocksOf } from "./move-read";
import {
  OPEN_IN_WORDS,
  type OpenSessionRecord,
  readOpenSessionRecords,
  type SessionOpenIn,
  sessionOpenInOf,
} from "./open-session-records";

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
  w: Pick<
    NonNullable<ReturnType<typeof agentWaitOf>>,
    "isDefault" | "until"
  > | null,
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
    defaultWait: w?.isDefault === true,
    dropped,
    late: !open && w !== null && now - at(w.until) > LATE_AFTER,
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
  /** What shows amber: its session open outside the desk, a default wait, a late deadline, a silent turn, a failed last turn, events dropped in the last day. */
  amber: string[];
  effort: string | null;
  /** Whether it does its job, in plain words (`agentHealthOf`). */
  health: Health;
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
  /** Where its session is open outside the desk while it waits (his Claude app, Claude Code elsewhere): its wakes wait until that lets go (`isSessionOpen`); null when it is not. */
  sessionOpenIn: SessionOpenIn | null;
  /** Since when that process has held it open. */
  sessionOpenSince: string | null;
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
  now: number,
  openIn: SessionOpenIn | null
) {
  const f = flagsOf(agentWaitOf(a, s), open, dropped, now);
  return a.status === "active"
    ? [
        ...(openIn ? [`session open in ${OPEN_IN_WORDS[openIn]}`] : []),
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
    openIn,
    status,
  }: {
    isForWakes: boolean;
    last: TurnRow | undefined;
    now: number;
    openIn: SessionOpenIn | null;
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
    amber: amberOf(a, s, last, open, dropped, now, openIn),
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

/** What every agent's read takes from beyond its rows, read once per call: Claude's live session records, why each runtime can't run (`runtime_block`), and how his Claude app lists sessions. */
interface Around {
  app: ReturnType<typeof readClaudeAppListing>;
  blocks: ReturnType<typeof runtimeBlocksOf>;
  records: Map<string, OpenSessionRecord>;
}
/** `isForWakes` (his apps' reads) also reads his Claude app's listing; the other reads (the snapshot, a project's) leave it unjudged. */
const readAround = (db: Database, isForWakes: boolean): Around => ({
  app: isForWakes ? readClaudeAppListing() : null,
  blocks: runtimeBlocksOf(db),
  records: readOpenSessionRecords(),
});

/** How many of agent `id`'s last turns failed in a row (3 at most: `agentHealthOf`'s broken). */
export const failedInARowOf = (db: Database, id: string) => {
  const outcomes = db
    .query<{ outcome: string | null }, [string]>(
      "select outcome from turn where agent_id = ? and ended_at is not null order by id desc limit 3"
    )
    .all(id);
  const i = outcomes.findIndex((t) => t.outcome !== "failed");
  return i === -1 ? outcomes.length : i;
};

/** When agent `id`'s oldest event not yet handed to a turn came, on any of its open assignments. */
export const waitingSinceOf = (db: Database, id: string) =>
  db
    .query<{ at: string | null }, [string]>(
      "select min(e.received_at) as at from event e join assignment s on s.id = e.assignment_id where s.agent_id = ? and s.closed_at is null and e.handed = 0 and e.consumed_at is null and e.dropped_at is null"
    )
    .get(id)?.at ?? null;

/** Agent `a`'s health (`agentHealthOf`) from its read so far and what the call read around it. */
function healthOf(
  db: Database,
  a: AgentRow,
  around: Around,
  now: number,
  f: Pick<HealthFacts, "amber" | "notStarted" | "sessionOpenIn" | "status"> & {
    record: OpenSessionRecord | undefined;
  }
) {
  const isListed = a.runtime === "claude" && a.session && isOwnLife();
  return agentHealthOf(
    {
      ...f,
      app: isListed ? (around.app?.(a.session ?? "") ?? null) : null,
      failedInARow: failedInARowOf(db, a.id),
      runtime: a.runtime,
      runtimeBlock: around.blocks[a.runtime],
      sessionOpenSince: f.record?.since ?? null,
      waitingSince: waitingSinceOf(db, a.id),
    },
    now
  );
}

/** Agent `a` as read now (`AgentNow`), by the assignment it works on (`on`, else `currentAssignmentOf`; `subjectPartOf`): its last turn, its anchors and its events dropped in the last day. */
function nowOf(
  db: Database,
  a: AgentRow,
  now: number,
  isForWakes: boolean,
  around: Around,
  on?: AssignmentRow
): AgentRead {
  const { records } = around;
  const last =
    db
      .query<TurnRow, [string]>(
        "select * from turn where agent_id = ? order by id desc limit 1"
      )
      .get(a.id) ?? undefined;
  const waiting = last && !last.ended_at ? "running" : "waiting";
  const status = a.status === "active" ? waiting : a.status;
  // Open elsewhere only while it waits: a turn of the desk's own runs it.
  const record =
    status === "waiting" && a.session ? records.get(a.session) : undefined;
  const openIn = record ? sessionOpenInOf(record) : null;
  const subject = subjectPartOf(
    db,
    a,
    on ?? currentAssignmentOf(db, a.id) ?? undefined,
    { isForWakes, last, now, openIn, status }
  );
  return {
    ...subject,
    health: healthOf(db, a, around, now, {
      amber: subject.amber,
      notStarted: subject.notStarted,
      record: openIn ? record : undefined,
      sessionOpenIn: openIn,
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
    sessionOpenIn: openIn,
    sessionOpenSince: openIn ? (record?.since ?? null) : null,
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
  const around = readAround(db, isForWakes);
  return rows.map((a) => nowOf(db, a, now, isForWakes, around));
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
  const around = readAround(db, isForWakes);
  return rows
    .filter((r) => !seen.has(r.id) && seen.add(r.id))
    .slice(0, MAX_ACTIVE + PAST_SHOWN)
    .map((r) =>
      nowOf(
        db,
        r,
        now,
        isForWakes,
        around,
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
  const around = readAround(db, false);
  return db
    .query<AgentRow, (string | number)[]>(
      `select * from agent where status <> 'handed_over' and project in (${projects.map(() => "?").join(",")}) order by status = 'active' desc, created_at desc limit ?`
    )
    .all(...projects, MAX_ACTIVE + PAST_SHOWN)
    .map((a) => nowOf(db, a, now, false, around));
}
