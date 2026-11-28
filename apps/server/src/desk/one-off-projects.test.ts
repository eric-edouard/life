import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { clock } from "../core/clock";
import { BUILT_IN_RUNTIME, DESK_AGENT } from "../core/names";
import { OWNER_DATA_DIR } from "../core/paths";
import { ask } from "../host/asks";
import { changeDirectoryEntry } from "../host/change-directory-entry";
import { assignmentOf, readNotes } from "../host/desk-read";
import { loadTruth } from "../memory/read-truth";
import { openAssignment, register } from "./agent-actions";
import { handedAskOf, recordHandedAsk, recordHandedWork } from "./desk-store";
import { firstTurnOf, shownGoalOf } from "./first-turns";
import {
  openOneOffProject,
  openOneOffProjects,
  promote,
  readHandedConversation,
} from "./one-off-projects";
import { ownAssignmentOf } from "./role-agents";
import { receiveSpokenAsks } from "./spoken-ask-intake";
import { setup } from "./test-desk";

// One-off projects (28 Nov 2026): written with a goal, the desk registers the project's agent once; handed work an
// agent promotes becomes a project from his own words, never the agent's. Made-up data only.

const TRUTH = join(OWNER_DATA_DIR, "truth");
const BACKUP = `${TRUTH}.one-off-backup`;
beforeAll(async () => {
  cpSync(TRUTH, BACKUP, { recursive: true });
  await changeDirectoryEntry({
    action: "add",
    id: "work",
    kind: "area",
    name: "Work",
    said: "Add a Work area",
  });
});
afterAll(() => {
  rmSync(TRUTH, { force: true, recursive: true });
  cpSync(BACKUP, TRUTH, { recursive: true });
  rmSync(BACKUP, { force: true, recursive: true });
  setSystemTime();
});

const desk = () => {
  const t = setup();
  t.desk.runtimes = { [BUILT_IN_RUNTIME]: t.fake.runtime };
  return t;
};
type T = ReturnType<typeof desk>;
const agentsOn = (t: T, project: string) =>
  t.desk.db
    .query<{ brief: string; id: string }, [string]>(
      "select id, brief from agent where project = ?"
    )
    .all(project);
const oneOff = (name: string, goal: string, status?: "dropped") =>
  changeDirectoryEntry({
    action: "add",
    area: "work",
    goal,
    kind: "project",
    name,
    said: goal,
    status,
  });

const handedRows = (t: T) =>
  t.desk.db
    .query<{ assignment_id: string; entry_id: number }, []>(
      "select entry_id, assignment_id from handed_work where kind = 'project'"
    )
    .all();

test("a one-off project gets one agent, never on his words, taking his entry; nothing under way while blocked or dropped; never again once stopped; none when ongoing", async () => {
  const t = desk();
  const goal = "Make a page for the bakery's opening day";
  t.desk.db.run(
    "insert into thread_entry (id, asked_at, words) values (3, ?, ?), (4, ?, 'Sell the old shelf')",
    [clock().toISOString(), goal, clock().toISOString()]
  );
  recordHandedAsk(
    t.desk.db,
    "tell-life:1:change_directory_entry:a",
    3,
    "bakery-page"
  );
  recordHandedAsk(
    t.desk.db,
    "tell-life:2:change_directory_entry:b",
    4,
    "old-shelf"
  );
  await oneOff("Bakery page", goal);
  await changeDirectoryEntry({
    action: "add",
    area: "work",
    kind: "project",
    name: "Garden",
    said: "Add a Garden project",
  });
  t.fake.blocked = "no key";
  await oneOff("Old shelf", "Sell the old shelf");
  await openOneOffProjects(t.desk);
  await changeDirectoryEntry({
    action: "edit",
    id: "old-shelf",
    kind: "project",
    said: "Drop the shelf project",
    status: "dropped",
  });
  expect([agentsOn(t, "bakery-page"), handedRows(t)]).toEqual([[], []]);
  t.fake.blocked = undefined;
  await openOneOffProjects(t.desk);
  await openOneOffProjects(t.desk);
  const [agent] = agentsOn(t, "bakery-page");
  expect(agentsOn(t, "bakery-page")).toHaveLength(1);
  expect(agent?.brief).not.toContain(goal);
  expect([agentsOn(t, "old-shelf"), agentsOn(t, "garden")]).toEqual([[], []]);
  expect(handedRows(t)).toEqual([
    {
      assignment_id: ownAssignmentOf(t.desk.db, agent?.id ?? "") ?? "",
      entry_id: 3,
    },
  ]);
  t.desk.db.run("update agent set status = 'stopped' where id = ?", [
    agent?.id ?? "",
  ]);
  expect(await openOneOffProject(t.desk, "bakery-page")).toMatchObject({
    error: expect.stringContaining("stopped or ended"),
  });
  expect(await openOneOffProject(t.desk, "old-shelf")).toMatchObject({
    error: expect.stringContaining("dropped"),
  });
  expect(agentsOn(t, "bakery-page")).toHaveLength(1);
});

test("a goal whose every entry he deleted is never quoted, and starts no agent; one written elsewhere keeps its goal", async () => {
  const t = desk();
  const goal = "Plan a surprise for the team's offsite";
  t.desk.db.run(
    "insert into thread_entry (id, asked_at, words, deleted_at) values (7, ?, null, ?)",
    [clock().toISOString(), clock().toISOString()]
  );
  recordHandedAsk(
    t.desk.db,
    "tell-life:3:change_directory_entry:c",
    7,
    "offsite"
  );
  await oneOff("Offsite", goal);
  expect(shownGoalOf(t.desk.db, { goal, id: "offsite" })).toBeUndefined();
  expect(shownGoalOf(t.desk.db, { goal, id: "elsewhere" })).toBe(goal);
  expect(await openOneOffProject(t.desk, "offsite")).toMatchObject({
    error: expect.stringContaining("deleted"),
  });
  expect(agentsOn(t, "offsite")).toEqual([]);
});

/** The Personal agent told `quote` from his entry `entry` (words `words`), on main session turn `turn`; its assignment and the ask. */
async function told(
  t: T,
  entry: number,
  turn: number,
  words: string,
  quote: string,
  tag = ""
) {
  const personal =
    t.desk.db
      .query<{ id: string }, []>("select id from agent where role = 'personal'")
      .get()?.id ??
    register(t.desk, {
      brief: "Test: the Personal agent",
      folder: t.dir,
      role: "personal",
      runtime: BUILT_IN_RUNTIME,
    });
  const own =
    ownAssignmentOf(t.desk.db, personal) ??
    openAssignment(t.desk, personal, { openedBy: "owner" });
  t.desk.db.run(
    "insert or ignore into thread_entry (id, asked_at, words, turn_id) values (?, ?, ?, ?)",
    [entry, clock().toISOString(), words, turn]
  );
  const line = ask(
    {
      at: clock().toISOString(),
      quote,
      ref: `tell-life:${turn}:tell_agent:t${entry}${tag}`,
    },
    { agent: DESK_AGENT, to: own },
    "connector",
    "test"
  );
  recordHandedWork(t.desk.db, entry, own, "other", line.at);
  recordHandedAsk(t.desk.db, line.id, entry);
  await receiveSpokenAsks(t.desk);
  const s = assignmentOf(t.desk.db, own);
  if (!s) {
    throw new Error("no assignment");
  }
  return { ask: line.id, s };
}

test("promote writes the project from his entry's words, never the agent's, whatever entry shares its turn id; a retry finishes the same one; two asks of one entry; its agent reads the talk around his ask", async () => {
  const t = desk();
  t.desk.db.run(
    "insert into thread_entry (id, asked_at, words, answer, turn_id) values (4, ?, 'What is in my Downloads?', 'Mostly installers.', 9)",
    [new Date(clock().getTime() - 60_000).toISOString()]
  );
  const words = "Clean up my Downloads folder, it is a mess";
  const { ask: id, s } = await told(
    t,
    5,
    9,
    words,
    "Clean up my Downloads folder"
  );
  const o = {
    ask: id,
    name: "Downloads cleanup",
    notes: "Mostly old installers.",
  };
  expect(await promote(t.desk, s, { ...o, ask: "ask_none" })).toMatchObject({
    error: expect.stringContaining("no spoken ask"),
  });
  const done = await promote(t.desk, s, o);
  expect(done).toMatchObject({
    project: "downloads-cleanup",
    state: "promoted",
  });
  expect(await promote(t.desk, s, o)).toEqual(done);
  const project = (await loadTruth()).projects.find(
    (p) => p.id === "downloads-cleanup"
  );
  expect([project?.goal, project?.area]).toEqual([words, "personal"]);
  const [agent] = agentsOn(t, "downloads-cleanup");
  expect(agentsOn(t, "downloads-cleanup")).toHaveLength(1);
  const taken = assignmentOf(
    t.desk.db,
    ownAssignmentOf(t.desk.db, agent?.id ?? "") ?? ""
  );
  if (!taken) {
    throw new Error("no project assignment");
  }
  expect(readNotes(taken)).toBe("Mostly old installers.");
  expect(firstTurnOf(t.desk.db, { role: null }, taken, words)).toContain(
    "`read_handed_conversation` with `entry: 5`"
  );
  expect(readHandedConversation(t.desk, taken, 5)).toEqual({
    entries: [
      {
        answer: "Mostly installers.",
        at: expect.any(String),
        id: 4,
        words: "What is in my Downloads?",
      },
      { answer: null, at: expect.any(String), id: 5, words },
    ],
  });
  const stranger = register(t.desk, {
    brief: "Test other",
    folder: t.dir,
    runtime: BUILT_IN_RUNTIME,
  });
  expect(
    readHandedConversation(t.desk, { agent_id: stranger }, 5)
  ).toMatchObject({
    error: expect.stringContaining("not handed to you"),
  });
  // A deleted entry leaves the thread for no one: never promoted, never read.
  const gone = await told(
    t,
    6,
    10,
    "Plan the move to the new flat",
    "Plan the move"
  );
  t.desk.db.run(
    "update thread_entry set deleted_at = ?, words = null where id = 6",
    [clock().toISOString()]
  );
  expect(
    await promote(t.desk, gone.s, { ask: gone.ask, name: "Move" })
  ).toMatchObject({
    error: expect.stringContaining("not kept"),
  });
  expect(readHandedConversation(t.desk, gone.s, 6)).toEqual({ entries: [] });
  // A second ask of the same entry: never the first's project; its own id makes its own.
  const again = await told(t, 5, 9, words, "Clean up my Downloads folder", "b");
  expect(
    await promote(t.desk, again.s, {
      ask: again.ask,
      name: "Downloads cleanup",
    })
  ).toMatchObject({ error: expect.stringContaining("another") });
  expect(
    await promote(t.desk, again.s, {
      ask: again.ask,
      name: "Downloads cleanup",
      project: "downloads-photos",
    })
  ).toMatchObject({ project: "downloads-photos", state: "promoted" });
});

test("promote on a blocked runtime keeps the project, his entry and the notes for the agent the tick registers", async () => {
  const t = desk();
  const words = "Sort my receipts into folders by year";
  const { ask: id, s } = await told(t, 8, 11, words, "Sort my receipts");
  t.fake.blocked = "no key";
  expect(
    await promote(t.desk, s, {
      ask: id,
      name: "Receipts",
      notes: "Receipts are in Documents.",
    })
  ).toMatchObject({ error: expect.stringContaining("keeps his ask") });
  expect(handedAskOf(t.desk.db, id)).toMatchObject({
    agent_id: null,
    notes: "Receipts are in Documents.",
    project: "receipts",
  });
  t.fake.blocked = undefined;
  await openOneOffProjects(t.desk);
  const [agent] = agentsOn(t, "receipts");
  const taken = assignmentOf(
    t.desk.db,
    ownAssignmentOf(t.desk.db, agent?.id ?? "") ?? ""
  );
  expect(taken && readNotes(taken)).toBe("Receipts are in Documents.");
  expect(handedAskOf(t.desk.db, id)?.agent_id).toBe(agent?.id ?? "");
});
