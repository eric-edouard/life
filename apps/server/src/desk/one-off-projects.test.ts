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
import { recordHandedWork } from "./desk-store";
import { firstTurnOf } from "./first-turns";
import {
  openOneOffProject,
  openOneOffProjects,
  pendingPlaceOf,
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

test("a one-off project gets one agent, on his ask, his waiting entry moved to it; never again once stopped; none when dropped or ongoing", async () => {
  const t = desk();
  const goal = "Make a page for the bakery's opening day";
  await oneOff("Bakery page", goal);
  await oneOff("Old shelf", "Sell the old shelf", "dropped");
  await changeDirectoryEntry({
    action: "add",
    area: "work",
    kind: "project",
    name: "Garden",
    said: "Add a Garden project",
  });
  t.desk.db.run(
    "insert into thread_entry (id, asked_at, words) values (3, ?, ?)",
    [clock().toISOString(), goal]
  );
  recordHandedWork(
    t.desk.db,
    3,
    pendingPlaceOf("bakery-page"),
    "project",
    clock().toISOString()
  );
  await openOneOffProjects(t.desk);
  await openOneOffProjects(t.desk);
  const [agent] = agentsOn(t, "bakery-page");
  expect(agentsOn(t, "bakery-page")).toEqual([
    { brief: goal, id: expect.any(String) },
  ]);
  expect([agentsOn(t, "old-shelf"), agentsOn(t, "garden")]).toEqual([[], []]);
  expect(
    t.desk.db
      .query("select assignment_id from handed_work where entry_id = 3")
      .get()
  ).toEqual({
    assignment_id: ownAssignmentOf(t.desk.db, agent?.id ?? "") ?? "",
  });
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

/** The Personal agent told `quote` from his entry `entry` (words `words`), on main session turn `turn`; its assignment and the ask. */
async function told(
  t: T,
  entry: number,
  turn: number,
  words: string,
  quote: string
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
    "insert into thread_entry (id, asked_at, words, turn_id) values (?, ?, ?, ?)",
    [entry, clock().toISOString(), words, turn]
  );
  const line = ask(
    {
      at: clock().toISOString(),
      quote,
      ref: `tell-life:${turn}:tell_agent:t${entry}`,
    },
    { agent: DESK_AGENT, to: own },
    "connector",
    "test"
  );
  recordHandedWork(t.desk.db, entry, own, "other", line.at);
  await receiveSpokenAsks(t.desk);
  const s = assignmentOf(t.desk.db, own);
  if (!s) {
    throw new Error("no assignment");
  }
  return { ask: line.id, s };
}

test("promote writes the project from his entry's words, never the agent's; a retry finishes the same one; two asks of one entry; its agent reads the talk around his ask", async () => {
  const t = desk();
  t.desk.db.run(
    "insert into thread_entry (id, asked_at, words, answer) values (4, ?, 'What is in my Downloads?', 'Mostly installers.')",
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
});
