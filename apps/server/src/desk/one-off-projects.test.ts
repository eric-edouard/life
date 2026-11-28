import { afterAll, beforeAll, expect, test } from "bun:test";
import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";
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
beforeAll(() => cpSync(TRUTH, BACKUP, { recursive: true }));
afterAll(() => {
  rmSync(TRUTH, { force: true, recursive: true });
  cpSync(BACKUP, TRUTH, { recursive: true });
  rmSync(BACKUP, { force: true, recursive: true });
});

const desk = () => {
  const t = setup();
  t.desk.runtimes = { [BUILT_IN_RUNTIME]: t.fake.runtime };
  return t;
};
const agentsOn = (t: ReturnType<typeof setup>, project: string) =>
  t.desk.db
    .query<{ brief: string; id: string }, [string]>(
      "select id, brief from agent where project = ?"
    )
    .all(project);

test("a one-off project gets one agent, on his ask, never again once it ended; an ongoing one gets none", async () => {
  const t = desk();
  const goal = "Make a page for the bakery's opening day";
  await changeDirectoryEntry({
    action: "add",
    id: "work",
    kind: "area",
    name: "Work",
    said: "Add a Work area",
  });
  await changeDirectoryEntry({
    action: "add",
    area: "work",
    goal,
    kind: "project",
    name: "Bakery page",
    said: goal,
  });
  await changeDirectoryEntry({
    action: "add",
    area: "work",
    kind: "project",
    name: "Garden",
    said: "Add a Garden project",
  });
  await openOneOffProjects(t.desk);
  await openOneOffProjects(t.desk);
  const [agent] = agentsOn(t, "bakery-page");
  expect(agentsOn(t, "bakery-page")).toEqual([
    { brief: goal, id: expect.any(String) },
  ]);
  expect(agentsOn(t, "garden")).toEqual([]);
  t.desk.db.run("update agent set status = 'ended' where id = ?", [
    agent?.id ?? "",
  ]);
  await openOneOffProjects(t.desk);
  expect(agentsOn(t, "bakery-page")).toHaveLength(1);
});

test("promote writes the project from his thread entry's words, never the agent's; a retry finishes the same one; its agent reads the talk around his ask", async () => {
  const t = desk();
  const personal = register(t.desk, {
    brief: "Test: the Personal agent",
    folder: t.dir,
    role: "personal",
    runtime: BUILT_IN_RUNTIME,
  });
  const own =
    ownAssignmentOf(t.desk.db, personal) ??
    openAssignment(t.desk, personal, { openedBy: "owner" });
  const words = "Clean up my Downloads folder, it is a mess";
  const line = ask(
    {
      at: new Date().toISOString(),
      quote: "Clean up my Downloads folder",
      ref: "test-promote",
    },
    { agent: DESK_AGENT, to: own },
    "connector",
    "test"
  );
  await receiveSpokenAsks(t.desk);
  t.desk.db.run(
    "insert into thread_entry (id, asked_at, words, answer) values (4, ?, 'What is in my Downloads?', 'Mostly installers.'), (5, ?, ?, null)",
    [
      new Date(Date.now() - 60_000).toISOString(),
      new Date().toISOString(),
      words,
    ]
  );
  recordHandedWork(t.desk.db, 5, own, "other", line.instruction?.at ?? "");
  const s = assignmentOf(t.desk.db, own);
  if (!s) {
    throw new Error("no assignment");
  }
  const o = {
    ask: line.id,
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
});
