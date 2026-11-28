import { clock } from "../core/clock";
import { log } from "../core/log";
import { errorOf } from "../core/log-line";
import {
  addedIdOf,
  changeDirectoryEntry,
  type DirectoryEntryChange,
} from "../host/change-directory-entry";
import {
  type AssignmentRow,
  assignmentOf,
  readNotes,
  runtimeOf,
} from "../host/desk-read";
import { conversationAroundOf, shownEntryOf } from "../host/life-thread";
import { loadTruth } from "../memory/read-truth";
import type { AgentChange } from "../records/registered-agent";
import { isUnderway } from "../records/truth";
import { writeNotes } from "./agent-actions";
import { start } from "./agent-changes";
import {
  type Desk,
  type HandedAsk,
  handedAskOf,
  recordHandedAsk,
  recordHandedWork,
} from "./desk-store";
import { shownGoalOf } from "./first-turns";
import { askLifeRefOf, entryOfTurn, eyesOn } from "./main-session";
import { ownAssignmentOf } from "./role-agents";
import { startBlockOf } from "./runtime-fallback";
import { readSpokenAsk } from "./spoken-ask-intake";

// One-off projects (docs/glossary.md, "one-off project"): a project with a goal gets an agent of its own, registered by
// the desk once the project is written, never resting on an agent's or the main session's memory (the owner's decisions
// of 28 Nov 2026). One rule registers it, `openOneOffProject`, reached three ways: the main session's
// `change_directory_entry` (`writeOneOffProject`), an agent's `promote` (an ask it was handed that turned out to be a
// project) and the tick (`openOneOffProjects`: a project written elsewhere, or one whose start was refused or cut). Each
// ask made a project has one handoff (`handed_ask`: the ask, his thread entry, the project, the old agent's notes),
// written before the project; the project's agent takes every handoff of it when it registers (`heldBy`).

/** The area a promoted project goes under when the agent names none that fits: a plain one, made when missing. */
const PLAIN_AREA = { id: "personal", name: "Personal" };

/** What a one-off project's agent is started on: never his words, which its first turn reads live (`shownGoalOf`), so one he deletes or replaces is never quoted. */
const briefOf = (project: string) =>
  `The agent of one-off project ${project}: its goal and your first turn are in your packet.`;

/**
 * Whether an agent was ever registered on project `project`, whatever its status: a one-off project gets one agent, and
 * one stopped or ended is never replaced by the desk. Its handoffs say who took them; a project written elsewhere has
 * none, so `agent.project` too. ponytail: an agent re-pointed away from such a project (his word) leaves none; a new one
 * then registers.
 */
const hasEverHadAgent = (db: Desk["db"], project: string) =>
  db
    .query(
      "select 1 from agent where project = ?1 union all select 1 from handed_ask where project = ?1 and agent_id is not null limit 1"
    )
    .get(project) !== null;

/**
 * Project `project`'s active agent with its own assignment, every handoff of the project it has not taken yet taken
 * there (his entry as handed work, the old agents' notes when it has none); none without both.
 */
function heldBy(desk: Desk, project: string) {
  const { db } = desk;
  const agent = db
    .query<{ id: string }, [string]>(
      "select id from agent where project = ? and status = 'active' order by created_at limit 1"
    )
    .get(project)?.id;
  const assignment = agent ? ownAssignmentOf(db, agent) : undefined;
  const taken = assignment ? assignmentOf(db, assignment) : undefined;
  if (!(agent && taken)) {
    return;
  }
  const handed = db
    .query<HandedAsk, [string]>(
      "select * from handed_ask where project = ? and agent_id is null"
    )
    .all(project);
  const notes = handed.flatMap((h) => h.notes ?? []).join("\n\n");
  if (notes && !readNotes(taken)) {
    writeNotes(desk, taken, notes);
  }
  const at = clock().toISOString();
  db.transaction(() => {
    for (const h of handed) {
      recordHandedWork(db, h.entry_id, taken.id, "project", at);
      db.run("update handed_ask set agent_id = ? where ask = ?", [
        agent,
        h.ask,
      ]);
    }
  })();
  return { agent, assignment: taken.id };
}

/**
 * One-off project `id`'s agent and its own assignment (`heldBy`), registering it (`start`, its runtime checked first)
 * when the project is under way, its goal still his words (`shownGoalOf`) and it never had one. Why not, as `{error}`;
 * throws while the desk keeps its most agents.
 */
export async function openOneOffProject(
  desk: Desk,
  id: string
): Promise<{ agent: string; assignment: string } | { error: string }> {
  const p = (await loadTruth()).projects.find((x) => x.id === id);
  const held = heldBy(desk, id);
  if (held || !p?.goal) {
    return held ?? { error: `Not done: ${id} is not a one-off project.` };
  }
  const refused =
    (!isUnderway(p) && `it is ${p.status}`) ||
    (!shownGoalOf(desk.db, p) && "his words of its goal were deleted") ||
    (hasEverHadAgent(desk.db, id) &&
      "its agent is stopped or ended: his word resumes it");
  if (refused) {
    return { error: `Not done: project ${id}: ${refused}.` };
  }
  const c: AgentChange = { action: "start", project: id };
  const blocked = await startBlockOf(desk, runtimeOf(c));
  // Registered by another door meanwhile: `start`'s repeat answers with it.
  const started = start(desk, c, briefOf(id), { blocked });
  if ("error" in started) {
    return started;
  }
  log("desk.one_off_project", { agent: started.id, project: id });
  return (
    heldBy(desk, id) ?? {
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
 * Writes one-off project `change` (its `id` taken, `addedIdOf`), his words `said` of main session turn `turn`: its
 * handoff first (`recordHandedAsk`, keyed by this act's ref), taken back when the write is refused; then Life's eyes on his
 * words and its agent (`openOneOffProject`; refused, the tick's).
 */
export async function writeOneOffProject(
  desk: Desk,
  turn: number,
  change: DirectoryEntryChange & { id: string }
) {
  const entry = entryOfTurn(desk, turn);
  const ask = askLifeRefOf(turn, "change_directory_entry", {
    project: change.id,
  });
  const isNew =
    entry !== undefined && recordHandedAsk(desk.db, ask, entry, change.id);
  const done = await changeDirectoryEntry(change).catch((e: unknown) => {
    if (isNew) {
      desk.db.run("delete from handed_ask where ask = ?", [ask]);
    }
    throw e;
  });
  eyesOn(desk, turn);
  return { done, ...(await openOneOffProject(desk, change.id)) };
}

/**
 * `promote`: the ask `ask` received on assignment `s` is a project. Its handoff (`handed_ask`, written when it was
 * handed) names his thread entry, whose words, as he still sees them (`shownEntryOf`), are its goal and `said` (never the
 * agent's text: its word only triggers the write). The project and the old agent's `notes` go into the handoff before
 * the project is written, under `area` (else a plain one, made when missing); then its own agent (`openOneOffProject`),
 * which takes them. A retry of the same ask finds its project in its handoff and finishes; a blocked start keeps it all
 * for the tick.
 */
export async function promote(
  desk: Desk,
  s: AssignmentRow,
  o: {
    area?: string;
    ask: string;
    name: string;
    notes?: string;
    project?: string;
  }
) {
  const heard = readSpokenAsk(desk, s, o.ask);
  const h = "error" in heard ? undefined : handedAskOf(desk.db, o.ask);
  const entry = h && shownEntryOf(desk.db, h.entry_id);
  if (!(h && entry?.words)) {
    return "error" in heard
      ? { error: String(heard.error) }
      : {
          error: `Not done: his words of ask ${o.ask} are not kept: it stays your work.`,
        };
  }
  const project = h.project ?? o.project ?? addedIdOf({ name: o.name });
  const truth = await loadTruth();
  const isWritten = truth.projects.some((p) => p.id === project);
  if (isWritten && !h.project) {
    return {
      error: `Not done: project ${project} is another: give a \`project\` id of its own.`,
    };
  }
  desk.db.run(
    "update handed_ask set project = ?, notes = coalesce(?, notes) where ask = ? and agent_id is null",
    [project, o.notes ?? null, o.ask]
  );
  if (!isWritten) {
    const area = o.area ?? PLAIN_AREA.id;
    if (area === PLAIN_AREA.id && !truth.areas.some((a) => a.id === area)) {
      await changeDirectoryEntry({
        action: "add",
        kind: "area",
        ...PLAIN_AREA,
        said: entry.words,
      });
    }
    await changeDirectoryEntry({
      action: "add",
      area,
      goal: entry.words,
      id: project,
      kind: "project",
      name: o.name,
      said: entry.words,
    });
  }
  const opened = await openOneOffProject(desk, project);
  if ("error" in opened) {
    return {
      error: `${opened.error} Project ${project} is written and keeps his ask and your notes for its agent: drop this ask.`,
    };
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
