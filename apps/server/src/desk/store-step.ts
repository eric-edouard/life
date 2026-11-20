import type { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { clock } from "../core/clock";
import { DESK_STORE, LIFE_STATE_DIR } from "../core/paths";
import { isAppState } from "../core/platform";
import { commitPaths } from "../core/proc";
import { settings } from "../core/settings";
import { openWritable } from "../core/sqlite";
import { agentHomeOf } from "../host/desk-read";
import {
  hasColumn,
  isBeforeAssignments,
  isBeforeMatterIds,
  isBeforeRoles,
} from "../host/desk-shape";
import { copyDb } from "../host/export";
import { SCHEMA } from "./desk-store";

// The desk's store steps (AGENTS.md, "A rename or a new field backfills"), each with its own check and its own dated
// copy. `stepStore`, of the agents and matters plan (PR 1): an agent becomes an identity and a session, and its subject,
// wait, notes and end become its one assignment; anchors, turns and events are keyed by it. `stepRoles`, of the
// caretaker: the Personal agent's flag becomes a role (`personal`, `caretaker`). `stepMatterIds` (life#826): an
// assignment keeps the matter he chose. Only the desk helper runs them, at its start, in that order; `openDesk` never
// migrates. Delete each once it has run on his store.

/** The tables rebuilt: renamed aside, made again in the new shape (`SCHEMA`), filled, then dropped. */
const REBUILT = ["agent", "session", "event", "turn", "anchor"];

/** A migrated agent's assignment id: its own hex kept, so a second run writes the same notes files. */
const asgOf = (agentColumn: string) => `'asg_' || substr(${agentColumn}, 5)`;

/** Each column list of the new rows, from the old tables (`old_<name>`), in one transaction. */
const COPY = [
  `insert into agent (id, brief, runtime, folder, project, model, effort, session, link, status, name, role, created_at, ended_at, outcome, stopped_at)
    select id, brief, runtime, folder, project, model, effort, session, link, status, null, null, created_at, ended_at, outcome, stopped_at from old_agent`,
  // An agent's wait was due at `created_at` with none set (`nextWakeOf`'s fallback): an open assignment holds it as its deadline.
  `insert into assignment (id, agent_id, opened_at, opened_by, said, wait_events, wait_until, wait_reason, wait_is_default, notes_path, closed_at, outcome, why_not_started)
    select ${asgOf("id")}, id, created_at, case when is_handed_out = 1 then 'desk' else 'owner' end, null, wait_events,
      case when status in ('ended', 'handed_over') then wait_until else coalesce(wait_until, created_at) end,
      wait_reason, wait_is_default, ?1 || '/assignments/' || ${asgOf("id")} || '/NOTES.md',
      case when status in ('ended', 'handed_over') then coalesce(ended_at, created_at) end,
      case when status in ('ended', 'handed_over') then outcome end, why_not_started from old_agent`,
  `insert into session (agent_id, runtime, ref, link, started_at, ended_at, why_ended, context_at_first_call)
    select agent_id, runtime, ref, link, started_at, ended_at, why_ended, context_at_first_call from old_session`,
  `insert into event (assignment_id, event_id, name, payload, received_at, handed, consumed_at, dropped_at)
    select ${asgOf("agent_id")}, event_id, name, payload, received_at, handed, consumed_at, dropped_at from old_event order by rowid`,
  `insert into turn (id, agent_id, assignment_id, session, cause, started_at, begun_at, heard_at, reminded_at, ended_at, outcome, tokens_in, tokens_cached, tokens_out, context_used)
    select id, agent_id, ${asgOf("agent_id")}, session, cause, started_at, begun_at, heard_at, reminded_at, ended_at, outcome, tokens_in, tokens_cached, tokens_out, context_used from old_turn`,
  `insert into anchor (assignment_id, step, added_at)
    select ${asgOf("agent_id")}, step, added_at from old_anchor order by rowid`,
];

/** Why the step can't run on `db`, naming what is missing: no agents repo, or an active or stopped project agent's home missing in it. */
function refusalOf(db: Database, agentsRepo: string | undefined) {
  if (!agentsRepo) {
    return "desk.agentsRepo is not set";
  }
  const missing = db
    .query<{ folder: string; id: string; project: string | null }, []>(
      "select id, folder, project from agent where project is not null and status in ('active', 'stopped')"
    )
    .all()
    .flatMap((a) => {
      const home = agentHomeOf(agentsRepo, a);
      return home && existsSync(home) ? [] : [`${a.id}'s home ${home}`];
    });
  return missing.length > 0 ? `missing: ${missing.join(", ")}` : null;
}

/**
 * The columns a store made before them lacks, each with what its older rows held (the old `ensureColumn` steps, carried
 * here once): an older store migrates like a newer one.
 */
const LATE_COLUMNS = [
  ["turn", "begun_at", "text", "update turn set begun_at = started_at"],
  // An agent never started was its outcome's "not started: " prefix (`glob` keeps case: its own words stay its outcome).
  [
    "agent",
    "why_not_started",
    "text",
    "update agent set why_not_started = substr(outcome, 14), outcome = null where outcome glob 'not started: *'",
  ],
  ["agent", "stopped_at", "text"],
  ["agent", "is_handed_out", "integer not null default 0"],
  ["session", "context_at_first_call", "integer"],
  ["turn", "context_used", "integer"],
] as const;

function addLateColumns(db: Database) {
  for (const [table, column, ddl, backfill] of LATE_COLUMNS) {
    if (!hasColumn(db, table, column)) {
      db.run(`alter table ${table} add column ${column} ${ddl}`);
      if (backfill) {
        db.run(backfill);
      }
    }
  }
}

/** Writes each agent's notes to its assignment's file in `agentsRepo` and commits those files alone there (nothing to commit on a second run). */
function writeNotesFiles(db: Database, agentsRepo: string) {
  const notes = db
    .query<{ notes: string; path: string }, []>(
      `select notes, 'assignments/' || ${asgOf("id")} || '/NOTES.md' as path from agent where notes <> ''`
    )
    .all();
  for (const n of notes) {
    mkdirSync(dirname(join(agentsRepo, n.path)), { recursive: true });
    writeFileSync(join(agentsRepo, n.path), n.notes);
  }
  commitPaths(
    agentsRepo,
    notes.map((n) => n.path),
    "desk: each agent's notes as its assignment's file"
  );
}

/**
 * The store's copy before the step, beside it: one per step, dated, published only once whole (written under one stable
 * partial name per step, which an interrupted try leaves for the next to replace, then renamed), and reused by every
 * later try. `VACUUM INTO` (`copyDb`, as the export copies every store) is one consistent read of the store, its WAL
 * included: the same rows as `sqlite3 .backup`, as one file, with no sqlite3 program (Windows has none), while the
 * desk's lock keeps any other writer out.
 */
function backUp(path: string, prefix: string) {
  const dir = dirname(path);
  const done = readdirSync(dir).find(
    (f) => f.startsWith(prefix) && f.endsWith(".sqlite")
  );
  if (done) {
    return join(dir, done);
  }
  const partial = join(dir, `${prefix}partial`);
  const to = join(
    dir,
    `${prefix}${clock().toISOString().replaceAll(":", "-")}.sqlite`
  );
  rmSync(partial, { force: true });
  copyDb(path, partial);
  renameSync(partial, to);
  return to;
}

/**
 * Reshapes the desk's store at `path` once: nothing for a store already in the new shape, none at all, or a checkout on
 * the app's state; refused (throws, nothing changed) without `agentsRepo` or a project agent's home. Before it, the
 * dated copy (`backUp`, one per step); then, in one transaction, its late columns, the notes files (committed), then the
 * tables (a failure rolls back to the old shape, which `openDesk` refuses). What it did.
 */
export function stepStore(
  path = DESK_STORE,
  state = LIFE_STATE_DIR,
  agentsRepo = settings().desk?.agentsRepo
) {
  if (!existsSync(path) || isAppState(state)) {
    return "skipped";
  }
  const db = openWritable(path, 5000, { strict: true });
  try {
    if (!isBeforeAssignments(db)) {
      return "in shape";
    }
    const refused = refusalOf(db, agentsRepo);
    if (refused || !agentsRepo) {
      throw new Error(`desk store step refused: ${refused}`);
    }
    backUp(path, "desk-before-assignments-");
    db.transaction(() => {
      addLateColumns(db);
      writeNotesFiles(db, agentsRepo);
      for (const t of REBUILT) {
        db.run(`alter table ${t} rename to old_${t}`);
      }
      db.run(SCHEMA);
      for (const sql of COPY) {
        db.run(sql, sql.includes("?1") ? [agentsRepo] : []);
      }
      for (const t of REBUILT) {
        db.run(`drop table old_${t}`);
      }
      // Its indexes, whose names the old tables held until dropped.
      db.run(SCHEMA);
    })();
    return "migrated";
  } finally {
    db.close();
  }
}

/**
 * Runs one later store step on the store at `path`, once: nothing for a store past it (`isBefore` false), none at all,
 * or a checkout on the app's state. Behind its own dated copy (`backUp`, `prefix`), then `change` and the schema's
 * indexes (`SCHEMA`) in one transaction. What it did.
 */
function stepOnce(
  path: string,
  state: string,
  isBefore: (db: Database) => boolean,
  prefix: string,
  change: (db: Database) => void
) {
  if (!existsSync(path) || isAppState(state)) {
    return "skipped";
  }
  const db = openWritable(path, 5000, { strict: true });
  try {
    if (!isBefore(db)) {
      return "in shape";
    }
    backUp(path, prefix);
    db.transaction(() => {
      change(db);
      db.run(SCHEMA);
    })();
    return "migrated";
  } finally {
    db.close();
  }
}

/** Gives the store's agents their roles (`stepOnce`): `role` added, the Personal agent's flag carried into it, the flag and its index dropped. */
export const stepRoles = (path = DESK_STORE, state = LIFE_STATE_DIR) =>
  stepOnce(path, state, isBeforeRoles, "desk-before-roles-", (db) => {
    db.run("drop index if exists one_personal_agent");
    db.run(
      "alter table agent add column role text check (role in ('personal', 'caretaker'))"
    );
    db.run("update agent set role = 'personal' where is_personal = 1");
    db.run("alter table agent drop column is_personal");
  });

/**
 * Gives the store's assignments the matter he chose (`stepOnce`): `matter_id` added, null on every older row (no choice
 * was kept; the finder's own pick would add nothing).
 */
export const stepMatterIds = (path = DESK_STORE, state = LIFE_STATE_DIR) =>
  stepOnce(path, state, isBeforeMatterIds, "desk-before-matter-ids-", (db) =>
    db.run("alter table assignment add column matter_id text")
  );
