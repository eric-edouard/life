import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { clock } from "../core/clock";
import { BUILT_IN_RUNTIME, DESK_AGENT } from "../core/names";
import { OWNER_DATA_DIR } from "../core/paths";
import { ask } from "../host/asks";
import { changeDirectoryEntry } from "../host/change-directory-entry";
import { assignmentOf } from "../host/desk-read";
import { estimateOf } from "../host/desk-turn-reads";
import { areaHold } from "../memory/pages";
import { loadTruth } from "../memory/read-truth";
import { openAssignment, register } from "./agent-actions";
import { recordHandedWork } from "./desk-store";
import { firstTurnOf, handedProjectOf } from "./first-turns";
import {
  catchUpHandoffs,
  openOneOffProject,
  openOneOffProjects,
  promote,
  readHandedConversation,
  writeOneOffProject,
} from "./one-off-projects";
import { ownAssignmentOf } from "./role-agents";
import { receiveSpokenAsks } from "./spoken-ask-intake";
import { advance, setup } from "./test-desk";

// One-off projects (28 Nov 2026): written with a goal, the desk registers the project's agent once and hands it his
// entry in one step; an ask an agent promotes becomes a project from his own told words, never the agent's. Made-up data.

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
const entryAt = (t: T, id: number, words: string, turn?: number) =>
  t.desk.db.run(
    "insert or ignore into thread_entry (id, asked_at, words, turn_id) values (?, ?, ?, ?)",
    [id, clock().toISOString(), words, turn ?? null]
  );
const claim = (t: T, project: string, entry: number) =>
  t.desk.db.run(
    "insert into project_handoff (project, ask, entry_id) values (?, ?, ?)",
    [project, `tell-life:0:change_directory_entry:${project}`, entry]
  );
const handedRows = (t: T, kind = "project") =>
  t.desk.db
    .query<{ assignment_id: string; entry_id: number }, [string]>(
      "select entry_id, assignment_id from handed_work where kind = ?"
    )
    .all(kind);
const takenBy = (t: T, project: string) =>
  t.desk.db
    .query<{ agent_id: string | null }, [string]>(
      "select agent_id from project_handoff where project = ?"
    )
    .get(project)?.agent_id;
const ownOf = (t: T, project: string) => {
  const s = assignmentOf(
    t.desk.db,
    ownAssignmentOf(t.desk.db, agentsOn(t, project)[0]?.id ?? "") ?? ""
  );
  if (!s) {
    throw new Error(`no assignment on ${project}`);
  }
  return s;
};

test("with no area named, his ask made a project goes under a plain Personal area, made when missing; blocked, it is written and kept for the poll's agent", async () => {
  const t = desk();
  entryAt(t, 1, "Build a reading list page for my book club");
  t.fake.blocked = "no key";
  const made = await writeOneOffProject(t.desk, "tell-life:1:x:a", 1, {
    action: "add",
    goal: "Build a reading list page",
    kind: "project",
    name: "Reading list",
    said: "Build a reading list page",
  });
  expect(made).toMatchObject({
    done: expect.any(String),
    pending: expect.stringContaining("no key"),
    project: "reading-list",
    state: "written",
  });
  const truth = await loadTruth();
  expect(truth.areas.map((a) => a.id)).toContain("personal");
  expect(truth.projects.find((p) => p.id === "reading-list")?.area).toBe(
    "personal"
  );
  t.fake.blocked = undefined;
  await openOneOffProjects(t.desk);
  expect(takenBy(t, "reading-list")).toBe(agentsOn(t, "reading-list")[0]?.id);
});

test("a one-off project gets one agent, never on his words, holding his entry; nothing under way while blocked or dropped; never again once stopped; none when ongoing", async () => {
  const t = desk();
  const goal = "Make a page for the bakery's opening day";
  entryAt(t, 3, goal);
  entryAt(t, 4, "Sell the old shelf");
  claim(t, "bakery-page", 3);
  claim(t, "old-shelf", 4);
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
    { assignment_id: ownOf(t, "bakery-page").id, entry_id: 3 },
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

test("an agent already on the project takes its handoff on the poll; a delivery that fails registers no agent", async () => {
  const t = desk();
  entryAt(t, 12, "Plan the garden party");
  await oneOff("Garden party", "Plan the garden party");
  const agent = register(t.desk, {
    brief: "Test: garden party",
    folder: t.dir,
    project: "garden-party",
    runtime: BUILT_IN_RUNTIME,
  });
  openAssignment(t.desk, agent, { openedBy: "owner" });
  claim(t, "garden-party", 12);
  await openOneOffProjects(t.desk);
  expect(takenBy(t, "garden-party")).toBe(agent);
  expect(handedRows(t)).toEqual([
    { assignment_id: ownOf(t, "garden-party").id, entry_id: 12 },
  ]);
  // The agent and its delivery are one step: a failed delivery leaves no agent behind.
  const u = desk();
  entryAt(u, 13, "Sort the spice drawer");
  await oneOff("Spice drawer", "Sort the spice drawer");
  claim(u, "spice-drawer", 13);
  u.desk.db.run("drop table handed_work");
  await openOneOffProjects(u.desk);
  expect([agentsOn(u, "spice-drawer"), takenBy(u, "spice-drawer")]).toEqual([
    [],
    null,
  ]);
});

test("at the desk's start a claim never written is given back, a written one is delivered, and a goal outside his entry is never shown", async () => {
  const t = desk();
  entryAt(t, 20, "Make a map of the hiking trails");
  entryAt(t, 21, "Write a guide to the old town");
  entryAt(t, 22, "Make a quiz night");
  claim(t, "never-written", 20);
  claim(t, "trail-map", 20);
  claim(t, "old-town", 21);
  await oneOff("Trail map", "Make a map of the hiking trails");
  await oneOff("Old town", "Write a guide to the old town");
  await changeDirectoryEntry({
    action: "edit",
    goal: "Write a guide to the whole city",
    id: "old-town",
    kind: "project",
    said: "Write a guide to the whole city",
  });
  await catchUpHandoffs(t.desk);
  expect(
    t.desk.db
      .query("select 1 from project_handoff where project = ?")
      .get("never-written")
  ).toBeNull();
  expect(agentsOn(t, "trail-map")).toHaveLength(1);
  expect(takenBy(t, "trail-map")).toBe(agentsOn(t, "trail-map")[0]?.id);
  const p = (await loadTruth()).projects.find((x) => x.id === "old-town");
  expect([handedProjectOf(t.desk.db, p), agentsOn(t, "old-town")]).toEqual([
    undefined,
    [],
  ]);
});

test("a goal whose entry he deleted is never shown or quoted, and starts no agent; one written elsewhere keeps its goal; an area page never prints a goal", async () => {
  const t = desk();
  const goal = "Plan a surprise for the team's offsite";
  t.desk.db.run(
    "insert into thread_entry (id, asked_at, words, deleted_at) values (7, ?, null, ?)",
    [clock().toISOString(), clock().toISOString()]
  );
  claim(t, "offsite", 7);
  await oneOff("Offsite", goal);
  expect(handedProjectOf(t.desk.db, { goal, id: "offsite" })).toBeUndefined();
  expect(handedProjectOf(t.desk.db, { goal, id: "elsewhere" })).toEqual({
    goal,
  });
  expect(await openOneOffProject(t.desk, "offsite")).toMatchObject({
    error: expect.stringContaining("deleted"),
  });
  expect(agentsOn(t, "offsite")).toEqual([]);
  const truth = await loadTruth();
  expect(
    areaHold(
      { id: "work", name: "Work" } as never,
      truth.projects.filter((p) => p.area === "work")
    )
  ).not.toContain(goal);
});

/** The Personal agent told `quote` from his entry `entry` (words `words`) on main session turn `turn`, as `tell_agent` keeps it (`legacy`: from before the entry was kept on the ask). */
async function told(
  t: T,
  entry: number,
  turn: number,
  words: string,
  quote: string,
  { legacy = false, tag = "" } = {}
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
  entryAt(t, entry, words, turn);
  const line = ask(
    {
      at: clock().toISOString(),
      quote,
      ref: `tell-life:${turn}:tell_agent:t${entry}${tag}`,
    },
    legacy
      ? { agent: DESK_AGENT, to: own }
      : { agent: DESK_AGENT, entry, kind: "other", to: own },
    "connector",
    "test"
  );
  if (legacy) {
    recordHandedWork(t.desk.db, entry, own, "other", line.at);
  }
  await receiveSpokenAsks(t.desk);
  const s = assignmentOf(t.desk.db, own);
  if (!s) {
    throw new Error("no assignment");
  }
  return { ask: line.id, s };
}

test("promote writes the project from his told words, never the agent's; a retry finishes the same one; the notes reach its agent; two asks never share an id; a refused write claims nothing", async () => {
  const t = desk();
  t.desk.db.run(
    "insert into thread_entry (id, asked_at, words, answer, turn_id) values (4, ?, 'What is in my Downloads?', 'Mostly installers.', 9)",
    [new Date(clock().getTime() - 60_000).toISOString()]
  );
  const words = "Clean up my Downloads folder, it is a mess";
  const quote = "Clean up my Downloads folder";
  const { ask: id, s } = await told(t, 5, 9, words, quote);
  // The intake kept the work it handed, once: a crash between the ledger and the store loses nothing.
  await receiveSpokenAsks(t.desk);
  expect(handedRows(t, "other")).toEqual([
    { assignment_id: s.id, entry_id: 5 },
  ]);
  const o = {
    ask: id,
    name: "Downloads cleanup",
    notes: "Mostly old installers.",
  };
  expect(await promote(t.desk, s, { ...o, ask: "ask_none" })).toMatchObject({
    error: expect.stringContaining("no spoken ask"),
  });
  expect(
    await promote(t.desk, s, { ...o, area: "no-such-area" })
  ).toMatchObject({ error: expect.any(String) });
  expect(takenBy(t, "downloads-cleanup")).toBeUndefined();
  expect(await promote(t.desk, s, o)).toMatchObject({
    project: "downloads-cleanup",
    state: "promoted",
  });
  expect(await promote(t.desk, s, o)).toMatchObject({
    project: "downloads-cleanup",
    state: "promoted",
  });
  const project = (await loadTruth()).projects.find(
    (p) => p.id === "downloads-cleanup"
  );
  expect([project?.goal, project?.area]).toEqual([quote, "personal"]);
  expect(agentsOn(t, "downloads-cleanup")).toHaveLength(1);
  const taken = ownOf(t, "downloads-cleanup");
  const first = firstTurnOf(
    t.desk.db,
    { project: "downloads-cleanup", role: null },
    taken,
    project ? [project] : []
  );
  expect(first).toContain("`read_handed_conversation` with `entry: 5`");
  expect(first).toContain("Mostly old installers.");
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
  ).toMatchObject({ error: expect.stringContaining("not handed to you") });
  // A second ask of the same entry: never the first's project; its own id makes its own.
  const again = await told(t, 5, 9, words, quote, { tag: "b" });
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
  expect(
    handedRows(t).filter((r) => r.assignment_id === taken.id)
  ).toHaveLength(1);
});

test("promote: a deleted entry is never promoted or read; an ask told before the entry was kept promotes by its handed work, one with none stays the agent's", async () => {
  const t = desk();
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
  ).toMatchObject({ error: expect.stringContaining("not kept") });
  expect(readHandedConversation(t.desk, gone.s, 6)).toEqual({ entries: [] });
  // Asks told at different instants, as they always are: an old ask is found by its instant.
  advance(1000);
  const old = await told(
    t,
    14,
    15,
    "Scan my old letters",
    "Scan my old letters",
    {
      legacy: true,
    }
  );
  expect(
    await promote(t.desk, old.s, { ask: old.ask, name: "Old letters" })
  ).toMatchObject({ project: "old-letters", state: "promoted" });
  const lost = await told(t, 16, 17, "Frame the prints", "Frame the prints", {
    legacy: true,
    tag: "x",
  });
  t.desk.db.run("delete from handed_work where entry_id = 16");
  expect(
    await promote(t.desk, lost.s, { ask: lost.ask, name: "Prints" })
  ).toMatchObject({ error: expect.stringContaining("not kept") });
});

test("promote on a blocked runtime keeps the project, his entry and the notes for the agent the poll registers", async () => {
  const t = desk();
  const { ask: id, s } = await told(
    t,
    8,
    11,
    "Sort my receipts into folders by year",
    "Sort my receipts"
  );
  t.fake.blocked = "no key";
  expect(
    await promote(t.desk, s, {
      ask: id,
      name: "Receipts",
      notes: "Receipts are in Documents.",
    })
  ).toMatchObject({ pending: expect.stringContaining("no key") });
  expect(takenBy(t, "receipts")).toBeNull();
  t.fake.blocked = undefined;
  await openOneOffProjects(t.desk);
  const p = (await loadTruth()).projects.find((x) => x.id === "receipts");
  expect(handedProjectOf(t.desk.db, p)?.notes).toBe(
    "Receipts are in Documents."
  );
  expect(takenBy(t, "receipts")).toBe(agentsOn(t, "receipts")[0]?.id);
});

test("the time a kind of handed work takes is whole ms, past five ends", () => {
  const t = desk();
  const agent = register(t.desk, {
    brief: "Test: estimates",
    folder: t.dir,
    runtime: BUILT_IN_RUNTIME,
  });
  const s = openAssignment(t.desk, agent, { openedBy: "owner" });
  const at = (ms: number) => new Date(Date.UTC(2026, 10, 1) + ms).toISOString();
  for (const i of [1, 2, 3, 4, 5]) {
    recordHandedWork(t.desk.db, 100 + i, s, "project", at(i * 1000));
    t.desk.db.run(
      "insert into turn (agent_id, assignment_id, cause, started_at, ended_at) values (?, ?, 'test', ?, ?)",
      [agent, s, at(i * 1000 + 1), at(i * 1000 + 333.7 * i)]
    );
  }
  expect(Number.isInteger(estimateOf(t.desk.db, "project"))).toBe(true);
});
