import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { clock } from "../core/clock";
import { DESK_STORE, LIFE_STATE_DIR } from "../core/paths";
import { isAppState } from "../core/platform";
import { gitOut } from "../core/proc";
import { settings } from "../core/settings";
import { openWritable } from "../core/sqlite";
import { agentHomeOf, isOldShape } from "../host/desk-read";
import { SCHEMA } from "./desk-store";

// The desk's store step of the agents and matters plan (PR 1; AGENTS.md, "A rename or a new field backfills"): an agent
// becomes an identity and a session, and its subject, wait, notes and end become its one assignment; anchors, turns
// and events are keyed by it. Only the desk helper runs it, at its start, behind a dated copy; `openDesk` never
// migrates. Delete it once it has run on his store.

/** The tables rebuilt: renamed aside, made again in the new shape (`SCHEMA`), filled, then dropped. */
const REBUILT = ["agent", "session", "event", "turn", "anchor"];

/** A migrated agent's assignment id: its own hex kept, so a second run writes the same notes files. */
const asgOf = (agentColumn: string) => `'asg_' || substr(${agentColumn}, 5)`;

/** Each column list of the new rows, from the old tables (`old_<name>`), in one transaction. */
const COPY = [
  `insert into agent (id, brief, runtime, folder, project, model, effort, session, link, status, name, is_personal, created_at, ended_at, outcome, stopped_at)
    select id, brief, runtime, folder, project, model, effort, session, link, status, null, 0, created_at, ended_at, outcome, stopped_at from old_agent`,
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

/** Writes each agent's notes to its assignment's file in `agentsRepo` and commits them there (nothing to commit on a second run). */
function writeNotesFiles(db: Database, agentsRepo: string) {
  const notes = db
    .query<{ notes: string; path: string }, [string]>(
      `select notes, ?1 || '/assignments/' || ${asgOf("id")} || '/NOTES.md' as path from agent where notes <> ''`
    )
    .all(agentsRepo);
  for (const n of notes) {
    mkdirSync(dirname(n.path), { recursive: true });
    writeFileSync(n.path, n.notes);
  }
  if (notes.length === 0) {
    return;
  }
  gitOut(agentsRepo, ["add", "assignments"]);
  if (gitOut(agentsRepo, ["status", "--porcelain", "assignments"])) {
    gitOut(agentsRepo, [
      "commit",
      "-m",
      "desk: each agent's notes as its assignment's file",
      "--",
      "assignments",
    ]);
  }
}

/**
 * Reshapes the desk's store at `path` once: nothing for a store already in the new shape, none at all, or a checkout on
 * the app's state; refused (throws, nothing changed) without `agentsRepo` or a project agent's home. Before it, a
 * dated copy beside the store; then the notes files, committed; then the tables, in one transaction (a failure rolls
 * back to the old shape, which `openDesk` refuses). What it did.
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
    if (!isOldShape(db)) {
      return "in shape";
    }
    const refused = refusalOf(db, agentsRepo);
    if (refused || !agentsRepo) {
      throw new Error(`desk store step refused: ${refused}`);
    }
    db.run("vacuum into ?", [
      join(
        dirname(path),
        `desk-before-assignments-${clock().toISOString().replaceAll(":", "-")}.sqlite`
      ),
    ]);
    db.transaction(() => {
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
