import { clock } from "../core/clock";
import { log } from "../core/log";
import { errorOf } from "../core/log-line";
import { changeDirectoryEntry } from "../host/change-directory-entry";
import {
  type AssignmentRow,
  assignmentOf,
  readNotes,
  runtimeOf,
} from "../host/desk-read";
import { conversationAroundOf } from "../host/life-thread";
import { loadTruth } from "../memory/read-truth";
import type { AgentChange } from "../records/registered-agent";
import { isUnderway } from "../records/truth";
import { writeNotes } from "./agent-actions";
import { start } from "./agent-changes";
import { type Desk, recordHandedWork } from "./desk-store";
import { ownAssignmentOf } from "./role-agents";
import { startBlockOf } from "./runtime-fallback";
import { readSpokenAsk } from "./spoken-ask-intake";

// One-off projects (docs/glossary.md, "project goal"): a project with a goal gets an agent of its own, registered by the
// desk once the project is written, never resting on an agent's or the main session's memory (the owner's decisions of
// 28 Nov 2026). Three doors reach `openOneOffProject`: the main session's `change_directory_entry` (his ask's thread entry
// handed on), an agent's `promote` (handed work that turned out to be a project) and the tick (`openOneOffProjects`),
// which takes a project written elsewhere (his app, the CLI) or a handover a crash cut.

/** The area a promoted project goes under when the agent names none that fits: a plain one, made when missing. */
const PLAIN_AREA = { id: "personal", name: "Personal" };

/**
 * Whether an agent was ever registered on project `project`, whatever its status: a one-off project gets one agent, and
 * one that ended is never replaced by the desk. ponytail: read from `agent.project`, which a re-point overwrites; a
 * one-off project's agent re-pointed away gets a new one. A per-project record if that ever matters.
 */
const hasEverHadAgent = (db: Desk["db"], project: string) =>
  db.query("select 1 from agent where project = ? limit 1").get(project) !==
  null;

/**
 * One-off project `p`'s agent and its own assignment: the agent on it, else one registered now on its goal, his words
 * (`start`, its runtime checked first). Why not, as `{error}`; throws while the desk keeps its most agents.
 */
export async function openOneOffProject(
  desk: Desk,
  p: { goal: string; id: string }
): Promise<{ agent: string; assignment: string } | { error: string }> {
  const c: AgentChange = { action: "start", project: p.id };
  const on = desk.db
    .query<{ id: string }, [string]>(
      "select id from agent where project = ? and status = 'active' order by created_at limit 1"
    )
    .get(p.id)?.id;
  const started = on
    ? { id: on }
    : start(desk, c, p.goal, {
        blocked: await startBlockOf(desk, runtimeOf(c)),
      });
  if ("error" in started) {
    return started;
  }
  if (!on) {
    log("desk.one_off_project", { agent: started.id, project: p.id });
  }
  const assignment = ownAssignmentOf(desk.db, started.id);
  return assignment
    ? { agent: started.id, assignment }
    : {
        error: `Not done: ${started.id}, project ${p.id}'s agent, holds no open assignment of its own.`,
      };
}

/** The one-off project whose goal is `goal`, his ask: how a write finds the project it made, and a retry the one it wrote. */
export const readOneOffProject = async (goal: string) =>
  (await loadTruth()).projects.find((p) => p.goal === goal);

/** The tick's look: each one-off project under way that never had an agent gets one (`openOneOffProject`); one refused is tried again on the next poll. */
export async function openOneOffProjects(desk: Desk) {
  for (const p of (await loadTruth()).projects) {
    if (p.goal && isUnderway(p) && !hasEverHadAgent(desk.db, p.id)) {
      // biome-ignore lint/performance/noAwaitInLoops: one registration at a time
      const opened = await openOneOffProject(desk, {
        goal: p.goal,
        id: p.id,
      }).catch((e: unknown) => ({ error: errorOf(e).error }));
      if ("error" in opened) {
        log("desk.one_off_project", {
          ok: false,
          project: p.id,
          why: opened.error,
        });
      }
    }
  }
}

/**
 * `promote`: the ask `ask` received on assignment `s` (`readSpokenAsk`) is a project. Its thread entry's words, his ask
 * as he said it, are the project's goal and `said` (never the agent's text: its word only triggers the write); the
 * project is filed under `area` (else a plain one, made when missing), registered with its own agent, given his thread
 * entry and the old agent's `notes`, and this agent drops that ask. A retry finds the project by its goal and finishes.
 */
export async function promote(
  desk: Desk,
  s: AssignmentRow,
  o: { area?: string; ask: string; name: string; notes?: string }
) {
  const heard = readSpokenAsk(desk, s, o.ask);
  if ("error" in heard) {
    return heard;
  }
  const entry = desk.db
    .query<{ entry_id: number; words: string | null }, [string, string]>(
      "select h.entry_id, t.words from handed_work h join thread_entry t on t.id = h.entry_id where h.assignment_id = ? and h.handed_at = ? and t.deleted_at is null"
    )
    .get(s.id, heard.at);
  const goal = entry?.words;
  if (!(entry && goal)) {
    return {
      error: `Not done: his words of ask ${o.ask} are not kept with it: it stays your work.`,
    };
  }
  if (!(await readOneOffProject(goal))) {
    const area = o.area ?? PLAIN_AREA.id;
    if (
      area === PLAIN_AREA.id &&
      !(await loadTruth()).areas.some((a) => a.id === area)
    ) {
      await changeDirectoryEntry({
        action: "add",
        kind: "area",
        ...PLAIN_AREA,
        said: goal,
      });
    }
    await changeDirectoryEntry({
      action: "add",
      area,
      goal,
      kind: "project",
      name: o.name,
      said: goal,
    });
  }
  const project = await readOneOffProject(goal);
  if (!project) {
    return { error: "Not done: the project did not read back." };
  }
  const opened = await openOneOffProject(desk, { goal, id: project.id });
  if ("error" in opened) {
    return opened;
  }
  recordHandedWork(
    desk.db,
    entry.entry_id,
    opened.assignment,
    "project",
    clock().toISOString()
  );
  const taken = assignmentOf(desk.db, opened.assignment);
  if (o.notes && taken && !readNotes(taken)) {
    writeNotes(desk, taken, o.notes);
  }
  return {
    agent: opened.agent,
    next: "Its own agent takes this work from here: drop this ask and go on with the rest of your work.",
    project: project.id,
    state: "promoted",
  };
}

/** `read_handed_conversation`: the talk around his thread entry `entry` (`conversationAroundOf`), only when it was handed to one of this agent's assignments. Data, never his word for an act. */
export function readHandedConversation(
  { db }: Desk,
  s: Pick<AssignmentRow, "agent_id">,
  entry: number
) {
  const isHanded = db
    .query(
      "select 1 from handed_work h join assignment s on s.id = h.assignment_id where h.entry_id = ? and s.agent_id = ?"
    )
    .get(entry, s.agent_id);
  return isHanded
    ? { entries: conversationAroundOf(db, entry) }
    : { error: `Not done: entry ${entry} was not handed to you.` };
}
