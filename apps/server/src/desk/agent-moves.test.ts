import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { clock, DAY, iso, MIN } from "../core/clock";
import { openReadOnly } from "../core/sqlite";
import { agentOf, assignmentOf } from "../host/desk-read";
import { isOldShape } from "../host/desk-shape";
import { opensWithPlan } from "../host/inbox";
import {
  assignmentOnMatter,
  MOVE_REASONS,
  matterMoveReadOf,
} from "../host/move-read";
import { recordDoneSeen } from "../memory/decisions";
// biome-ignore lint/performance/noNamespaceImport: a test spies on which agent takes a matter
import * as readMatters from "../memory/read-matters";
import type { AgentChange } from "../records/registered-agent";
import {
  askDecision,
  closeAssignment,
  hasAsked,
  openAssignment,
  register,
  setWait,
  withdrawOpenCards,
  writeNotes,
} from "./agent-actions";
import { advanceMoves, applyHandOver } from "./agent-moves";
import { cardHomeOf } from "./card-home";
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
  matterMoveReadOf(
    desk.db,
    { steps: [STEP] },
    clock().getTime(),
    () => undefined
  );

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

// Verdict (decision 78, PR A): with no assignment chosen for the asked matter, one sharing a step but chosen for another
// matter was taken.
test("a move or a read of a matter never takes an assignment of another matter sharing its step", async () => {
  const { assignment, desk } = await holding();
  // The finder: the assignment's chosen matter takes a tie while it is a live matter; otherwise the step is matter A's.
  const matterOf = (_refs: readonly string[], prefer?: string) =>
    prefer === "matter_00000000000b" ? prefer : "matter_00000000000a";
  const heldOn = (id: string) =>
    assignmentOnMatter(desk.db, { id, steps: [STEP] }, matterOf)?.id ?? null;
  desk.db.run("update assignment set matter_id = ? where id = ?", [
    "matter_00000000000b",
    assignment,
  ]);
  expect(heldOn("matter_00000000000a")).toBeNull();
  expect(heldOn("matter_00000000000b")).toBe(assignment);
  // A matter re-grouped away (its chosen id gone) or none chosen: found by its anchors.
  desk.db.run("update assignment set matter_id = ? where id = ?", [
    "matter_0000000000ff",
    assignment,
  ]);
  expect(heldOn("matter_00000000000a")).toBe(assignment);
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

// Verdict (decision 78, PR A): a failed look at the old session, or a stop that left the new one running, let two
// sessions share one agent's door.
test("a switch waits until the session it leaves is seen stopped, at its commit and at its rollback", async () => {
  const { desk, end, fake, old, other } = await holding();
  expect(move(desk, { agent: old, runtime: "other" })).toEqual({ id: old });
  await advanceMoves(desk);
  await wakeDue(desk);
  await end(old);
  const look = spyOn(fake.runtime, "state").mockRejectedValue(
    new Error("test: no answer")
  );
  await advanceMoves(desk);
  expect(agentOf(desk.db, old)?.runtime).toBe("fake");
  look.mockRestore();
  await advanceMoves(desk);
  expect(agentOf(desk.db, old)?.runtime).toBe("other");
  other.holdBegun();
  await wakeDue(desk);
  const stop = spyOn(other.runtime, "stop").mockResolvedValue();
  advance(31 * MIN);
  await advanceMoves(desk);
  await advanceMoves(desk);
  expect(agentOf(desk.db, old)?.runtime).toBe("other");
  stop.mockRestore();
  await advanceMoves(desk);
  expect(agentOf(desk.db, old)?.runtime).toBe("fake");
});

// Verdict (decision 78, PR A): the old holder ended once its last other assignment closed while the move was starting,
// so a rollback gave the matter back to an ended agent; and a stopped old holder was never ended after a move done.
test("the old holder is kept until the move is done: a rollback finds it active, and a stopped one ends once done", async () => {
  await withBook([toDo(STEP, "I'll fix the boiler")], MATTER, async () => {
    const { assignment, desk, end, old, other } = await holding();
    const second = openAssignment(desk, old, {
      openedBy: "owner",
      steps: ["obs_00000000a079"],
    });
    move(desk, { runtime: "other", steps: [STEP] });
    await advanceMoves(desk);
    await wakeDue(desk);
    await end(old);
    await advanceMoves(desk);
    other.holdBegun();
    await closeAssignment(desk, second, "test: done");
    expect(agentOf(desk.db, old)?.status).toBe("active");
    advance(31 * MIN);
    await advanceMoves(desk);
    expect(assignmentOf(desk.db, assignment)?.agent_id).toBe(old);
    expect(agentOf(desk.db, old)?.status).toBe("active");
    // Moved again, and this time it starts: the old holder, stopped meanwhile, ends at done.
    other.isFailing = false;
    move(desk, { runtime: "other", steps: [STEP] }, "entry_test_move_2");
    await advanceMoves(desk);
    await wakeDue(desk);
    await end(old);
    await advanceMoves(desk);
    desk.db.run("update agent set status = 'stopped' where id = ?", [old]);
    const to = assignmentOf(desk.db, assignment)?.agent_id ?? "";
    await wakeDue(desk);
    other.begin(agentOf(desk.db, to)?.session ?? "");
    await Bun.sleep(1);
    await advanceMoves(desk);
    expect(agentOf(desk.db, old)?.status).toBe("ended");
  });
});

// Verdict (decision 78, PR A): the agent a matter was moved away from still filed cards on it under its own assignment,
// as the agent that takes the matter.
test("the old holder's cards on a matter moved away are refused, though its agent takes that matter", async () => {
  await withBook([toDo(STEP, "I'll fix the boiler")], MATTER, async () => {
    const { desk, end, old } = await holding();
    const own = openAssignment(desk, old, { openedBy: "owner" });
    const takes = spyOn(readMatters, "agentForMatterOf").mockReturnValue(
      () => old
    );
    try {
      move(desk, { runtime: "other", steps: [STEP] });
      await advanceMoves(desk);
      await wakeDue(desk);
      await end(old);
      await advanceMoves(desk);
      const s = assignmentOf(desk.db, own);
      if (!s) {
        throw new Error("no own assignment");
      }
      await expect(cardHomeOf(desk.db, s, STEP)).rejects.toThrow(
        "not on a matter you hold"
      );
    } finally {
      takes.mockRestore();
    }
  });
});

// Verdict (decision 78, PR A): a notes send that failed threw out of the tick, and every notes turn of a switch was told
// the same words.
test("a notes turn whose send fails ends without stopping the tick; each of a switch's notes turns names its own work", async () => {
  const { desk, dir, fake, old } = await holding();
  const second = openAssignment(desk, old, {
    openedBy: "owner",
    steps: ["obs_00000000a079"],
  });
  move(desk, { agent: old, runtime: "other" });
  const send = spyOn(fake.runtime, "send").mockRejectedValueOnce(
    new Error("test: send failed")
  );
  const other = register(desk, {
    brief: "Test brief: another",
    folder: dir,
    runtime: "fake",
  });
  await advanceMoves(desk);
  await wakeDue(desk);
  send.mockRestore();
  expect(fake.said.some((x) => x.message.includes("Test brief: another"))).toBe(
    true
  );
  expect(agentOf(desk.db, other)?.session).toBeTruthy();
  for (let i = 0; i < 3; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: one tick after another
    await advanceMoves(desk);
    await wakeDue(desk);
    const ref = agentOf(desk.db, old)?.session ?? "";
    if (fake.sessions.get(ref)?.running) {
      fake.exit(ref);
      await Bun.sleep(1);
    }
  }
  const notes = fake.said.filter((x) =>
    x.message.includes("This turn's notes")
  );
  expect(notes.some((x) => x.message.includes(second))).toBe(true);
});

// Verdict (decision 78, PR A): a card whose step Life saw done before the move still counted as asked, and an assignment
// the desk opened, once he moved it, could not ask a plan.
test("after a move, a card seen done before it does not count as asked, and a desk-opened assignment opens with a plan", async () => {
  await withBook([toDo(STEP, "I'll fix the boiler")], MATTER, async () => {
    const { assignment, desk, end, old } = await holding();
    desk.db.run("update assignment set opened_by = 'desk' where id = ?", [
      assignment,
    ]);
    const card = await askDecision(desk, on(desk, old), {
      context: "A made-up reason to ask.",
      deadline: iso(clock().getTime() + DAY),
      options: [
        { id: "yes", label: "Yes" },
        { id: "no", label: "No" },
      ],
      question: "Test: pay the plumber?",
      title: "a test",
    });
    recordDoneSeen(card.id, { state: "seen" });
    advance(MIN);
    move(desk, { runtime: "other", steps: [STEP] });
    await advanceMoves(desk);
    await wakeDue(desk);
    await end(old);
    await advanceMoves(desk);
    const moved = assignmentOf(desk.db, assignment);
    if (!moved) {
      throw new Error("no assignment");
    }
    expect(hasAsked(desk.db, moved)).toBe(false);
    expect(opensWithPlan(desk.db, moved)).toBe(true);
  });
});

test("the store step gives a store of the shape before moves its tables, behind a dated copy; openDesk refuses it before", () => {
  const { dir, path, desk } = setup();
  desk.db.run("drop table move");
  desk.db.run("drop table runtime_block");
  desk.db.run("alter table turn drop column move");
  desk.db.run(
    "insert into turn (agent_id, assignment_id, cause, started_at) values ('agt_000000000001', 'asg_000000000001', 'start', ?)",
    [clock().toISOString()]
  );
  desk.db.close();
  expect(() => openDesk(path)).toThrow();
  expect(stepMoves(path, dir)).toBe("migrated");
  const store = openReadOnly(path);
  expect(isOldShape(store)).toBe(false);
  expect(
    store
      .query<{ name: string }, []>(
        "select name from sqlite_master where name in ('move', 'runtime_block', 'move_by_assignment', 'move_by_agent') order by name"
      )
      .all()
      .map((r) => r.name)
  ).toEqual(["move", "move_by_agent", "move_by_assignment", "runtime_block"]);
  expect(store.query("select cause, move from turn").all()).toEqual([
    { cause: "start", move: null },
  ]);
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
