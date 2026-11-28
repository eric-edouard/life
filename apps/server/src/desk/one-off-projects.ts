import { clock } from "../core/clock";
import { log } from "../core/log";
import { errorOf } from "../core/log-line";
import {
  addedIdOf,
  changeDirectoryEntry,
} from "../host/change-directory-entry";
import {
  type AssignmentRow,
  assignmentOf,
  readNotes,
  runtimeOf,
} from "../host/desk-read";
import { conversationAroundOf, shownEntryOf } from "../host/life-thread";
import { askOf } from "../memory/memory-files";
import { loadTruth } from "../memory/read-truth";
import type { AgentChange } from "../records/registered-agent";
import { isUnderway } from "../records/truth";
import { writeNotes } from "./agent-actions";
import { start } from "./agent-changes";
import { type Desk, recordHandedWork } from "./desk-store";
import { ownAssignmentOf } from "./role-agents";
import { startBlockOf } from "./runtime-fallback";
import { readSpokenAsk } from "./spoken-ask-intake";

// One-off projects (docs/glossary.md, "one-off project"): a project with a goal gets an agent of its own, registered by
// the desk once the project is written, never resting on an agent's or the main session's memory (the owner's decisions
// of 28 Nov 2026). One rule registers it, `openOneOffProject`, reached three ways: the main session's
// `change_directory_entry`, an agent's `promote` (handed work that turned out to be a project) and the tick
// (`openOneOffProjects`: a project written elsewhere, or one whose start was refused or cut). His thread entry waits for
// the agent as handed work on the project's pending place (`pendingPlaceOf`), moved to its assignment when it registers.

/** The area a promoted project goes under when the agent names none that fits: a plain one, made when missing. */
const PLAIN_AREA = { id: "personal", name: "Personal" };

/** Where handed work for project `id` waits until its agent registers: a `handed_work` place no assignment takes. */
export const pendingPlaceOf = (id: string) => `project:${id}`;

/**
 * Whether an agent was ever registered on project `project`, whatever its status: a one-off project gets one agent, and
 * one stopped or ended is never replaced by the desk. ponytail: read from `agent.project`, which a re-point overwrites;
 * a one-off project's agent re-pointed away (his word) gets a new one. A per-project record if that ever matters.
 */
const hasEverHadAgent = (db: Desk["db"], project: string) =>
  db.query("select 1 from agent where project = ? limit 1").get(project) !==
  null;

/** Project `project`'s active agent with its own assignment, his entries waiting for it moved there; none without both. */
function heldBy(db: Desk["db"], project: string) {
  const agent = db
    .query<{ id: string }, [string]>(
      "select id from agent where project = ? and status = 'active' order by created_at limit 1"
    )
    .get(project)?.id;
  const assignment = agent ? ownAssignmentOf(db, agent) : undefined;
  if (!(agent && assignment)) {
    return;
  }
  db.run("update handed_work set assignment_id = ? where assignment_id = ?", [
    assignment,
    pendingPlaceOf(project),
  ]);
  return { agent, assignment };
}

/**
 * One-off project `id`'s agent and its own assignment (`heldBy`), registering it on its goal, his words (`start`, its
 * runtime checked first), when the project is under way and never had one. Why not, as `{error}`; throws while the desk
 * keeps its most agents.
 */
export async function openOneOffProject(
  desk: Desk,
  id: string
): Promise<{ agent: string; assignment: string } | { error: string }> {
  const p = (await loadTruth()).projects.find((x) => x.id === id);
  const held = heldBy(desk.db, id);
  if (held || !p?.goal) {
    return held ?? { error: `Not done: ${id} is not a one-off project.` };
  }
  const refused = isUnderway(p)
    ? hasEverHadAgent(desk.db, id) &&
      "its agent is stopped or ended: his word resumes it"
    : `it is ${p.status}`;
  if (refused) {
    return { error: `Not done: project ${id}: ${refused}.` };
  }
  const c: AgentChange = { action: "start", project: id };
  const blocked = await startBlockOf(desk, runtimeOf(c));
  // Registered by another door meanwhile: `start`'s repeat answers with it.
  const started = start(desk, c, p.goal, { blocked });
  if ("error" in started) {
    return started;
  }
  log("desk.one_off_project", { agent: started.id, project: id });
  return (
    heldBy(desk.db, id) ?? {
      error: `Not done: ${started.id} holds no assignment of its own.`,
    }
  );
}

/** The tick's look: each one-off project under way that never had an agent gets one; one refused is tried again on the next poll. */
export async function openOneOffProjects(desk: Desk) {
  const { projects } = await loadTruth();
  for (const p of projects) {
    if (p.goal && isUnderway(p) && !hasEverHadAgent(desk.db, p.id)) {
      // biome-ignore lint/performance/noAwaitInLoops: one registration at a time
      const opened = await openOneOffProject(desk, p.id).catch(
        (e: unknown) => ({ error: errorOf(e).error })
      );
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
 * His thread entry an ask told on assignment `s` came from: received there (`readSpokenAsk`), its main session turn read
 * from the ask's own ref (`askLifeRefOf`), still shown to him (`shownEntryOf`); or why not.
 */
function entryOfAsk(desk: Desk, s: Pick<AssignmentRow, "id">, ask: string) {
  const heard = readSpokenAsk(desk, s, ask);
  if ("error" in heard) {
    return { error: String(heard.error) };
  }
  const turn = askOf(ask)?.instruction?.ref.match(TELL_LIFE_TURN)?.[1];
  const id = turn
    ? desk.db
        .query<{ id: number }, [number]>(
          "select id from thread_entry where turn_id = ?"
        )
        .get(Number(turn))?.id
    : undefined;
  const entry = id === undefined ? undefined : shownEntryOf(desk.db, id);
  return entry?.words
    ? { id: entry.id, words: entry.words }
    : {
        error: `Not done: his words of ask ${ask} are not kept: it stays your work.`,
      };
}
const TELL_LIFE_TURN = /^tell-life:(\d+):/;

/** The project his entry `entry` was already made into (its pending place, or the project of the agent it was handed to). */
const projectOfEntry = (db: Desk["db"], entry: number) =>
  db
    .query<{ project: string | null }, [number]>(
      "select coalesce(a.project, substr(h.assignment_id, 9)) as project from handed_work h left join assignment s on s.id = h.assignment_id left join agent a on a.id = s.agent_id where h.entry_id = ? and h.kind = 'project' limit 1"
    )
    .get(entry)?.project ?? undefined;

/**
 * `promote`: the ask `ask` received on assignment `s` is a project. His thread entry's words (`entryOfAsk`), his ask as
 * he said it, are its goal and `said` (never the agent's text: its word only triggers the write); filed under `area`
 * (else a plain one, made when missing), his entry handed on, then its own agent (`openOneOffProject`) with the old
 * agent's `notes`. A retry of the same ask finds its project by his entry and finishes.
 */
export async function promote(
  desk: Desk,
  s: AssignmentRow,
  o: { area?: string; ask: string; name: string; notes?: string }
) {
  const entry = entryOfAsk(desk, s, o.ask);
  if ("error" in entry) {
    return entry;
  }
  let project = projectOfEntry(desk.db, entry.id);
  if (!project) {
    const area = o.area ?? PLAIN_AREA.id;
    if (
      area === PLAIN_AREA.id &&
      !(await loadTruth()).areas.some((a) => a.id === area)
    ) {
      await changeDirectoryEntry({
        action: "add",
        kind: "area",
        ...PLAIN_AREA,
        said: entry.words,
      });
    }
    project = addedIdOf({ name: o.name });
    await changeDirectoryEntry({
      action: "add",
      area,
      goal: entry.words,
      id: project,
      kind: "project",
      name: o.name,
      said: entry.words,
    });
    recordHandedWork(
      desk.db,
      entry.id,
      pendingPlaceOf(project),
      "project",
      clock().toISOString()
    );
  }
  const opened = await openOneOffProject(desk, project);
  if ("error" in opened) {
    return {
      error: `${opened.error} Project ${project} is written, his ask waits for its agent: promote again later to hand over your notes.`,
    };
  }
  const taken = assignmentOf(desk.db, opened.assignment);
  if (o.notes && taken && !readNotes(taken)) {
    writeNotes(desk, taken, o.notes);
  }
  return {
    agent: opened.agent,
    next: "Its own agent takes this work from here: drop this ask and go on with the rest of your work.",
    project,
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
