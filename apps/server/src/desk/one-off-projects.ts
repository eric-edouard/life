import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clock } from "../core/clock";
import { log } from "../core/log";
import { errorOf } from "../core/log-line";
import { PROJECT_WORK_FOLDERS } from "../core/paths";
import { gitOut } from "../core/proc";
import {
  addedIdOf,
  changeDirectoryEntry,
  type DirectoryEntryChange,
} from "../host/change-directory-entry";
import { type AssignmentRow, runtimeOf } from "../host/desk-read";
import { conversationAroundOf, shownEntryOf } from "../host/life-thread";
import { loadTruth } from "../memory/read-truth";
import type { AgentChange } from "../records/registered-agent";
import { isUnderway, type Project } from "../records/truth";
import { start } from "./agent-changes";
import {
  type Desk,
  handoffOf,
  type ProjectHandoff,
  recordHandedWork,
} from "./desk-store";
import { handedProjectOf } from "./first-turns";
import { ownAssignmentOf } from "./role-agents";
import { startBlockOf } from "./runtime-fallback";
import { readSpokenAsk } from "./spoken-ask-intake";

// One-off projects (docs/glossary.md, "one-off project"): a project with a goal gets an agent of its own, registered by
// the desk once the project is written, never resting on an agent's or the main session's memory (the owner's decisions
// of 28 Nov 2026). Its handoff (`project_handoff`) is one row per project made of an ask, claimed before the project is
// written: its primary key is the claim on the project's id, so no other ask attaches to it, and a refused write gives
// it back. `writeOneOffProject` is the one step for both doors (the main session's `change_directory_entry`, an agent's
// `promote`); `openOneOffProject` registers the agent and hands it his entry in one transaction, so the row says taken
// only once the agent's assignment holds it. Nothing is copied: the goal and the handed notes are read live
// (`handedProjectOf`). Caught up at the desk's start, before any agent wakes (`catchUpHandoffs`), and on each poll.

/** The area a one-off project goes under when none is named: a plain one, made when missing. */
const PLAIN_AREA = { id: "personal", name: "Personal" };

/** What a one-off project's agent is started on: never his words, which its first turn reads live (`handedProjectOf`), so one he deletes or replaces is never quoted. */
const briefOf = (project: string) =>
  `The agent of one-off project ${project}: its goal and your first turn are in your packet.`;

/**
 * Whether an agent was ever registered on project `project`, whatever its status: a one-off project gets one agent, and
 * one stopped or ended is never replaced by the desk. ponytail: an agent re-pointed away from such a project (his word)
 * leaves none; a new one then registers.
 */
const hasEverHadAgent = (db: Desk["db"], project: string) =>
  db.query("select 1 from agent where project = ? limit 1").get(project) !==
  null;

/** Makes one-off project `id`'s work folder (`PROJECT_WORK_FOLDERS`), with its own repo, when missing; never removed, so it is kept after its agent ends. `start` runs its agent there. */
function makeWorkFolder(id: string) {
  const folder = join(PROJECT_WORK_FOLDERS, id);
  if (!existsSync(join(folder, ".git"))) {
    mkdirSync(folder, { recursive: true });
    gitOut(folder, ["init", "-q"]);
    // Never a secret in its history: its backup carries the history, not the secret files.
    writeFileSync(join(folder, ".gitignore"), ".env*\nnode_modules/\n");
  }
}

/** Project `id`'s active agent, if any. */
const activeOf = (db: Desk["db"], id: string) =>
  db
    .query<{ id: string }, [string]>(
      "select id from agent where project = ? and status = 'active' order by created_at limit 1"
    )
    .get(id)?.id;

/** Why one-off project `p` gets no agent now (none: it can), `active` its active agent: the one rule for the door and the poll. */
const refusalOf = (db: Desk["db"], p: Project, active?: string) =>
  active
    ? undefined
    : (!isUnderway(p) && `it is ${p.status}`) ||
      (hasEverHadAgent(db, p.id) &&
        "its agent is stopped or ended: his word resumes it") ||
      undefined;

/** Whether one-off project `p` waits for its agent now: its handoff not taken (or, written elsewhere, no agent yet), and nothing refuses one. */
const isWaitingFor = (db: Desk["db"], p: Project) => {
  const h = handoffOf(db, p.id);
  const active = activeOf(db, p.id);
  return (
    (h ? h.agent_id === null : !active) &&
    refusalOf(db, p, active) === undefined
  );
};

/**
 * One-off project `id`'s active agent and its own assignment, holding his entry (`handed_work`, kind `project`) when the
 * project came from an ask. With none, registers one (`start`, its runtime checked first; in its work folder) while the project is under way,
 * its goal still his words (`handedProjectOf`) and it never had one. The agent, its delivery and the handoff marked
 * taken are one transaction: a crash leaves all or nothing. Why not, as `{error}`; throws while the desk keeps its most
 * agents.
 */
export async function openOneOffProject(
  desk: Desk,
  id: string
): Promise<{ agent: string; assignment: string } | { error: string }> {
  const { db } = desk;
  const c: AgentChange = { action: "start", project: id };
  const blocked = await startBlockOf(desk, runtimeOf(c));
  const p = (await loadTruth()).projects.find((x) => x.id === id);
  // Nothing awaited from here: what was checked is what is written.
  if (!(p && handedProjectOf(db, p))) {
    return {
      error: `Not done: ${id} is not a one-off project, or his words of its goal were deleted.`,
    };
  }
  const active = activeOf(db, id);
  const refused = refusalOf(db, p, active);
  if (refused) {
    return { error: `Not done: project ${id}: ${refused}.` };
  }
  if (!active) {
    makeWorkFolder(id);
  }
  const opened = db.transaction(() => {
    const started = active
      ? { id: active }
      : start(desk, c, briefOf(id), { blocked });
    if ("error" in started) {
      return started;
    }
    const assignment = ownAssignmentOf(db, started.id);
    if (!assignment) {
      // Rolls the registration back: an agent with nowhere to take his entry is not this project's.
      throw new Error(`${started.id} holds no assignment of its own`);
    }
    const h = handoffOf(db, id);
    if (h && h.agent_id === null) {
      recordHandedWork(
        db,
        h.entry_id,
        assignment,
        "project",
        clock().toISOString()
      );
      db.run("update project_handoff set agent_id = ? where project = ?", [
        started.id,
        id,
      ]);
    }
    return { agent: started.id, assignment };
  })();
  if (!("error" in opened || active)) {
    log("desk.one_off_project", { agent: opened.agent, project: id });
  }
  return opened;
}

/** Each poll's look: every one-off project under way still waiting for its agent (`isWaitingFor`) gets it; one refused is tried again on the next. */
export async function openOneOffProjects(desk: Desk) {
  const { projects } = await loadTruth();
  for (const p of projects) {
    if (
      isUnderway(p) &&
      handedProjectOf(desk.db, p) &&
      isWaitingFor(desk.db, p)
    ) {
      // biome-ignore lint/performance/noAwaitInLoops: one registration at a time
      const opened = await openOneOffProject(desk, p.id).catch(
        (e: unknown) => ({ error: errorOf(e).error })
      );
      if ("error" in opened) {
        // Its class only (a blocked runtime, a full desk): the sentence may quote the runtime.
        log("desk.one_off_project", { ok: false, project: p.id });
      }
    }
  }
}

/**
 * At the desk's start, before any agent wakes: a handoff whose project was never written (a crash between its claim and
 * the write: nothing is in flight now) gives its id back, and every one-off project still waiting gets its agent.
 */
export async function catchUpHandoffs(desk: Desk) {
  const written = new Set((await loadTruth()).projects.map((p) => p.id));
  const { db } = desk;
  for (const { project } of db
    .query<{ project: string }, []>(
      "select project from project_handoff where agent_id is null"
    )
    .all()) {
    if (!written.has(project)) {
      db.run("delete from project_handoff where project = ?", [project]);
    }
  }
  await openOneOffProjects(desk);
}

/**
 * Writes one-off project `change` made of ask `ask` from his thread entry `entry`, with the asking agent's `notes`: the
 * one step for both doors. Claims its id first (`project_handoff`; a retry of the same ask finds its claim and finishes),
 * refused when another ask or his directory has it; the area is a plain Personal one when none is named, made when
 * missing; a refused write gives the claim back (and throws). Then its agent (`openOneOffProject`): once written it never
 * fails, `pending` saying why no agent holds it yet (the poll's to retry).
 */
export async function writeOneOffProject(
  desk: Desk,
  ask: string,
  entry: number,
  change: DirectoryEntryChange & { goal: string },
  notes?: string
) {
  const { db } = desk;
  const claimed = db
    .query<ProjectHandoff, [string]>(
      "select * from project_handoff where ask = ?"
    )
    .get(ask);
  const project = claimed?.project ?? addedIdOf(change);
  const truth = await loadTruth();
  const isWritten = truth.projects.some((p) => p.id === project);
  if (claimed) {
    db.run(
      "update project_handoff set notes = coalesce(?, notes) where ask = ? and agent_id is null",
      [notes ?? null, ask]
    );
  } else if (
    isWritten ||
    db.run(
      "insert or ignore into project_handoff (project, ask, entry_id, notes) values (?, ?, ?, ?)",
      [project, ask, entry, notes ?? null]
    ).changes === 0
  ) {
    throw new Error(
      `Not done: project ${project} is another: give it an id of its own.`
    );
  }
  const area = change.area ?? PLAIN_AREA.id;
  const done = isWritten
    ? undefined
    : await (async () => {
        if (area === PLAIN_AREA.id && !truth.areas.some((a) => a.id === area)) {
          await changeDirectoryEntry({
            action: "add",
            kind: "area",
            ...PLAIN_AREA,
            said: change.said,
          });
        }
        return changeDirectoryEntry({ ...change, area, id: project });
      })().catch((e: unknown) => {
        // Only the claim this call made: a retry never gives back another call's.
        if (claimed) {
          throw e;
        }
        db.run(
          "delete from project_handoff where ask = ? and agent_id is null",
          [ask]
        );
        throw e;
      });
  const opened = await openOneOffProject(desk, project).catch((e: unknown) => ({
    error: errorOf(e).error,
  }));
  return {
    done,
    project,
    state: "written" as const,
    ...("error" in opened
      ? { pending: opened.error }
      : { agent: opened.agent }),
  };
}

/**
 * `promote`: the ask `ask` received on assignment `s` is a project. Its goal and `said` are his words the main session
 * told (`readSpokenAsk`, never the agent's text: its word only triggers the write), only while his thread entry they came
 * from still holds them (`shownEntryOf`); the agent's `notes` go with the handoff, read by the project's agent.
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
  if ("error" in heard) {
    return heard;
  }
  const { entry, words } = heard;
  if (
    !(
      entry !== undefined &&
      shownEntryOf(desk.db, entry)?.words?.includes(words)
    )
  ) {
    return {
      error: `Not done: his words of ask ${o.ask} are not kept: it stays your work.`,
    };
  }
  const made = await writeOneOffProject(
    desk,
    o.ask,
    entry,
    {
      action: "add",
      area: o.area,
      goal: words,
      id: o.project,
      kind: "project",
      name: o.name,
      said: words,
    },
    o.notes
  ).catch((e: unknown) => ({ error: errorOf(e).error }));
  return "error" in made
    ? made
    : {
        ...made,
        next: "Its own agent takes this work from here: drop this ask and go on with the rest of your work.",
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
