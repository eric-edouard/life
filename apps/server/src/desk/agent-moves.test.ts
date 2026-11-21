import { afterEach, expect, setSystemTime, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { clock, DAY, iso, MIN } from "../core/clock";
import { openReadOnly } from "../core/sqlite";
import { agentOf, assignmentOf } from "../host/desk-read";
import { isOldShape } from "../host/desk-shape";
import { MOVE_REASONS, matterMoveReadOf } from "../host/move-read";
import type { AgentChange } from "../records/registered-agent";
import {
  askDecision,
  hasAsked,
  register,
  setWait,
  withdrawOpenCards,
  writeNotes,
} from "./agent-actions";
import { advanceMoves, applyHandOver } from "./agent-moves";
import { readPeopleOnce, wakeDue } from "./desk-clock";
import { type Desk, openDesk } from "./desk-store";
import { foldAssignments } from "./matter-net";
import { fakeRuntime } from "./runtimes/fake-runtime";
import { stepMoves } from "./store-step";
import { ANA, advance, ahead, on, setup, toDo, withBook } from "./test-desk";

// Moving a matter between runtimes (decision 78): its old agent's notes turn, the commit, the new agent's first turn,
// done or rolled back; never half-moved. Made-up agents and matters.

afterEach(() => {
  setSystemTime();
});

const STEP = "obs_00000000a078";
const MATTER = { id: "matter_00000000a078", steps: [STEP] };

/** A made-up desk with a second runtime (`other`), and an agent holding the matter, waiting after its first turn. */
async function holding() {
  const t = setup();
  t.desk.embedder = null;
  const other = fakeRuntime();
  t.desk.runtimes.other = other.runtime;
  const old = register(t.desk, {
    brief: "Test brief: the boiler",
    folder: t.dir,
    runtime: "fake",
    steps: [STEP],
  });
  await wakeDue(t.desk);
  await setWait(t.desk, on(t.desk, old), {
    events: [ANA],
    reason: "Ana's reply",
    until: ahead(DAY),
  });
  await t.end(old);
  return { ...t, assignment: on(t.desk, old).id, old, other };
}

/** His `hand_over` as the desk applies it (`applyAgentChanges`): the change and its `agent_change` row, in one transaction. */
function move(
  desk: Desk,
  c: Omit<AgentChange, "action">,
  ask = "entry_test_move",
  blocked?: string,
  matter?: string
) {
  return desk.db.transaction(() => {
    const r = applyHandOver(
      desk,
      ask,
      { action: "hand_over", ...c },
      { blocked, matter }
    );
    desk.db.run(
      "insert into agent_change (ask, agent_id, error, applied_at) values (?, ?, ?, ?)",
      [
        ask,
        "id" in r ? r.id : null,
        "error" in r ? r.error : null,
        clock().toISOString(),
      ]
    );
    return r;
  })();
}

const phaseOf = (desk: Desk) =>
  matterMoveReadOf(desk.db, { steps: [STEP] }, clock().getTime());

test("a matter moves: the old agent writes its notes in its own session, then a new agent on the other runtime takes it, and the old one ends at done", async () => {
  await withBook([toDo(STEP, "I'll fix the boiler")], MATTER, async () => {
    const { assignment, desk, end, fake, old, other } = await holding();
    expect(move(desk, { runtime: "other", steps: [STEP] })).toEqual({
      id: old,
    });
    await advanceMoves(desk);
    await wakeDue(desk);
    expect(fake.said.at(-1)?.message).toContain("write_notes");
    expect(phaseOf(desk).move?.phase).toBe("notes");
    writeNotes(desk, on(desk, old), "Test notes: the plumber comes Tuesday");
    await end(old);
    await advanceMoves(desk);
    const to = assignmentOf(desk.db, assignment)?.agent_id ?? "";
    expect(to).not.toBe(old);
    expect(agentOf(desk.db, to)).toMatchObject({
      folder: agentOf(desk.db, old)?.folder,
      runtime: "other",
    });
    expect(agentOf(desk.db, old)?.status).toBe("active");
    await wakeDue(desk);
    expect(other.said[0]?.message).toContain("moved to you");
    expect(other.said[0]?.message).toContain("the plumber comes Tuesday");
    await Bun.sleep(1);
    await advanceMoves(desk);
    expect(agentOf(desk.db, old)?.status).toBe("ended");
    expect(phaseOf(desk)).toMatchObject({
      holder: { id: to, movedFrom: { id: old }, runtime: "other" },
      move: { phase: "done" },
    });
  });
});

test("his answer during the notes turn is not handed to it, and wakes the new holder", async () => {
  await withBook([toDo(STEP, "I'll fix the boiler")], MATTER, async () => {
    const { assignment, desk, end, eventRow, old, queue } = await holding();
    move(desk, { runtime: "other", steps: [STEP] });
    await advanceMoves(desk);
    await wakeDue(desk);
    queue(old, "dec_test.answered", "decision.answered");
    await Bun.sleep(1);
    expect(eventRow(old, "dec_test.answered")?.handed).toBe(0);
    await end(old);
    await advanceMoves(desk);
    await wakeDue(desk);
    const to = assignmentOf(desk.db, assignment)?.agent_id ?? "";
    expect(
      desk.db
        .query<{ cause: string }, [string]>(
          "select cause from turn where agent_id = ?"
        )
        .all(to)
    ).toEqual([{ cause: "answer" }]);
  });
});

test("a move to a runtime that can't run is refused, and nothing moves", async () => {
  const { assignment, desk, old } = await holding();
  expect(
    move(desk, { runtime: "other", steps: [STEP] }, "entry_b", "down")
  ).toEqual({
    error: MOVE_REASONS.blocked("other"),
  });
  await advanceMoves(desk);
  expect(assignmentOf(desk.db, assignment)?.agent_id).toBe(old);
  expect(phaseOf(desk).move).toMatchObject({
    phase: "failed",
    reason: MOVE_REASONS.blocked("other"),
  });
});

test("a move finds its assignment by the matter he chose, whatever its anchors", async () => {
  const { assignment, desk, old } = await holding();
  desk.db.run("update assignment set matter_id = ? where id = ?", [
    MATTER.id,
    assignment,
  ]);
  expect(
    move(
      desk,
      { runtime: "other", steps: ["obs_00000000a079"] },
      "entry_m",
      undefined,
      MATTER.id
    )
  ).toEqual({ id: old });
});

test("a second move while one is under way is refused", async () => {
  const { desk } = await holding();
  move(desk, { runtime: "other", steps: [STEP] });
  expect(move(desk, { runtime: "other", steps: [STEP] }, "entry_c")).toEqual({
    error: MOVE_REASONS.underWay,
  });
});

test("a new agent whose first turn never begins rolls the move back: the old one holds it all again, the new one ends", async () => {
  await withBook([toDo(STEP, "I'll fix the boiler")], MATTER, async () => {
    const { assignment, desk, end, old, other } = await holding();
    move(desk, { runtime: "other", steps: [STEP] });
    await advanceMoves(desk);
    await wakeDue(desk);
    await end(old);
    await advanceMoves(desk);
    const to = assignmentOf(desk.db, assignment)?.agent_id ?? "";
    other.isFailing = true;
    await wakeDue(desk);
    await advanceMoves(desk);
    expect(assignmentOf(desk.db, assignment)).toMatchObject({
      agent_id: old,
      closed_at: null,
    });
    expect(agentOf(desk.db, to)?.status).toBe("ended");
    expect(agentOf(desk.db, old)?.status).toBe("active");
    expect(phaseOf(desk).move).toMatchObject({
      phase: "failed",
      reason: MOVE_REASONS.notStarted("other"),
    });
  });
});

test("the notes turn is best effort: past 10 minutes its run is stopped and the matter moves on the notes it has", async () => {
  await withBook([toDo(STEP, "I'll fix the boiler")], MATTER, async () => {
    const { assignment, desk, fake, old } = await holding();
    move(desk, { runtime: "other", steps: [STEP] });
    await advanceMoves(desk);
    await wakeDue(desk);
    advance(11 * MIN);
    await advanceMoves(desk);
    expect(fake.stopped).toHaveLength(1);
    expect(assignmentOf(desk.db, assignment)?.agent_id).not.toBe(old);
  });
});

test("a moved matter stays with its new agent: the fold leaves it, and its new holder asks its plan first", async () => {
  await withBook([toDo(STEP, "I'll fix the boiler")], MATTER, async () => {
    const { assignment, desk, dir, end, old } = await holding();
    const s = on(desk, old);
    const card = await askDecision(desk, s, {
      context: "A made-up reason to ask.",
      deadline: iso(clock().getTime() + DAY),
      options: [
        { id: "yes", label: "Yes" },
        { id: "no", label: "No" },
      ],
      question: "Test: call the plumber?",
      title: "a test",
    });
    move(desk, { runtime: "other", steps: [STEP] });
    await advanceMoves(desk);
    await wakeDue(desk);
    await end(old);
    await advanceMoves(desk);
    const moved = assignmentOf(desk.db, assignment);
    if (!moved) {
      throw new Error("no assignment");
    }
    // The inherited open card stands; once withdrawn, the new holder owes its own plan.
    expect(hasAsked(desk.db, moved)).toBe(true);
    await withdrawOpenCards(desk.db, moved, `test over ${card.id}`);
    expect(hasAsked(desk.db, moved)).toBe(false);
    register(desk, {
      brief: "Test brief: personal",
      folder: dir,
      role: "personal",
      runtime: "fake",
    });
    await foldAssignments(desk, readPeopleOnce());
    expect(assignmentOf(desk.db, assignment)?.agent_id).toBe(moved.agent_id);
  });
});

test("a whole agent switches runtime after its notes, its model and session cleared; one that never starts gets them back", async () => {
  const { desk, end, old, other } = await holding();
  desk.db.run("update agent set model = 'test-model' where id = ?", [old]);
  const before = agentOf(desk.db, old);
  expect(move(desk, { agent: old, runtime: "other" })).toEqual({ id: old });
  await advanceMoves(desk);
  await wakeDue(desk);
  await end(old);
  await advanceMoves(desk);
  expect(agentOf(desk.db, old)).toMatchObject({
    model: null,
    runtime: "other",
    session: null,
  });
  other.isFailing = true;
  await wakeDue(desk);
  await advanceMoves(desk);
  expect(agentOf(desk.db, old)).toMatchObject({
    link: before?.link,
    model: "test-model",
    runtime: "fake",
    session: before?.session,
  });
});

test("the store step gives a store of the shape before moves its tables, behind a dated copy; openDesk refuses it before", () => {
  const { dir, path, desk } = setup();
  desk.db.run("drop table move");
  desk.db.run("drop table runtime_block");
  desk.db.run("alter table turn drop column move");
  desk.db.close();
  expect(() => openDesk(path)).toThrow();
  expect(stepMoves(path, dir)).toBe("migrated");
  expect(isOldShape(openReadOnly(path))).toBe(false);
  const copies = () =>
    readdirSync(dirname(path)).filter((f) =>
      f.startsWith("desk-before-moves-")
    );
  const shape = () =>
    openReadOnly(path)
      .query("select type, name, sql from sqlite_master order by name")
      .all();
  expect(copies()).toHaveLength(1);
  // A second run changes nothing: same shape, no second copy.
  const before = shape();
  expect(stepMoves(path, dir)).toBe("in shape");
  expect(shape()).toEqual(before);
  expect(copies()).toHaveLength(1);
  expect(existsSync(path)).toBe(true);
});
