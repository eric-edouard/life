import { afterEach, expect, setSystemTime, test } from "bun:test";
import { clock, DAY, iso, MIN } from "../core/clock";
import {
  agentOf,
  assignmentOf,
  assignmentOfCard,
  openAssignments,
  readStartFacts,
} from "../host/desk-read";
import {
  askDecision,
  openAssignment,
  register,
  withdrawOpenCards,
} from "./agent-actions";
import { start } from "./agent-changes";
import { readPeopleOnce, wakeDue } from "./desk-clock";
import { foldAssignments } from "./matter-net";
import { advance, setup, toDo, withBook } from "./test-desk";

// The debt verdict on PR 3 (#810, 21 Nov 2026): an agent and its assignments are not one thing. Each test is one of its
// findings, made up.

afterEach(() => {
  setSystemTime();
});

const later = () => new Date(clock().getTime() + 30 * DAY).toISOString();

/** An agent of the made-up desk, its own listening waiting a month. */
function standing(
  desk: ReturnType<typeof setup>["desk"],
  a: { project?: string; role?: "personal" }
) {
  const id = register(desk, { brief: "Test brief", runtime: "fake", ...a });
  desk.db.run("update assignment set wait_until = ? where agent_id = ?", [
    later(),
    id,
  ]);
  return id;
}

test("a start on matter A hands over only A of the stopped agent: its matter B keeps its wait, its own stays, it stays stopped", () => {
  const { desk } = setup();
  const personal = standing(desk, { role: "personal" });
  const a = openAssignment(desk, personal, {
    openedBy: "owner",
    steps: ["obs_test_a"],
  });
  const b = openAssignment(desk, personal, {
    openedBy: "owner",
    steps: ["obs_test_b"],
  });
  desk.db.run(
    "update assignment set wait_until = ?, wait_reason = 'Test: B waits' where id = ?",
    [later(), b]
  );
  desk.db.run("update agent set status = 'stopped' where id = ?", [personal]);
  const shop = standing(desk, { project: "test-shop" });
  expect(
    start(desk, { action: "start", steps: ["obs_test_a"] }, "Test: A", {
      taker: shop,
    })
  ).toEqual({ id: shop });
  expect(assignmentOf(desk.db, a)?.outcome).toBe(`replaced by ${shop}`);
  expect(assignmentOf(desk.db, b)).toMatchObject({
    closed_at: null,
    wait_reason: "Test: B waits",
  });
  expect(agentOf(desk.db, personal)?.status).toBe("stopped");
});

test("an agent's 51st open assignment is read and woken like its first", async () => {
  const { desk } = setup();
  const id = standing(desk, {});
  const opened = Array.from({ length: 51 }, (_, i) =>
    openAssignment(desk, id, { openedBy: "desk", steps: [`obs_test_${i}`] })
  );
  const last = opened.at(-1) ?? "";
  desk.db.run("update assignment set wait_until = ? where id <> ?", [
    later(),
    last,
  ]);
  expect(openAssignments(desk.db).map((s) => s.id)).toContain(last);
  await wakeDue(desk);
  expect(
    desk.db
      .query<{ assignment_id: string }, [string]>(
        "select assignment_id from turn where agent_id = ?"
      )
      .all(id)
  ).toEqual([{ assignment_id: last }]);
});

test("a card asked before the desk kept its owner stays its agent's first assignment's when another runs a turn", () => {
  const { desk } = setup();
  const id = standing(desk, {});
  const first = openAssignments(desk.db)[0]?.id ?? null;
  const card = { agent: id, id: "dec_test_before_owners" };
  expect(assignmentOfCard(desk.db, card)).toBe(first);
  const second = openAssignment(desk, id, {
    openedBy: "owner",
    steps: ["obs_test_c"],
  });
  desk.db.run(
    "insert into turn (agent_id, assignment_id, cause, started_at) values (?, ?, 'event', ?)",
    [id, second, clock().toISOString()]
  );
  expect(assignmentOfCard(desk.db, card)).toBe(first);
});

test("a fold onto an agent leaves its own older card on its own assignment", async () => {
  const { desk } = setup();
  desk.embedder = null;
  const step = "obs_00000000f061";
  await withBook(
    [toDo(step, "I'll book the piano tuner")],
    { id: "matter_00000000f061", steps: [step] },
    async () => {
      // The matter's assignment is older than the Personal agent's own: after the move it is the agent's first.
      const old = register(desk, {
        brief: "Test brief: the piano",
        runtime: "fake",
        steps: [step],
      });
      advance(MIN);
      const personal = standing(desk, { role: "personal" });
      const own = openAssignments(desk.db).find((s) => s.agent_id === personal);
      if (!own) {
        throw new Error("no own assignment");
      }
      const { id } = await askDecision(desk, own, {
        context: "A made-up reason to ask.",
        deadline: iso(clock().getTime() + DAY),
        options: [
          { id: "yes", label: "Yes" },
          { id: "no", label: "No" },
        ],
        question: "Test: go on?",
        title: "a test",
      });
      // Asked before the desk kept owners.
      desk.db.run("delete from card where decision_id = ?", [id]);
      const card = { agent: personal, id };
      expect(assignmentOfCard(desk.db, card)).toBe(own.id);
      await foldAssignments(desk, readPeopleOnce());
      expect(
        openAssignments(desk.db).filter((s) => s.agent_id === personal)
      ).toHaveLength(2);
      expect(agentOf(desk.db, old)?.status).toBe("ended");
      expect(assignmentOfCard(desk.db, card)).toBe(own.id);
      await withdrawOpenCards(desk.db, own, "test over");
    }
  );
});

test("a repeated Start reports the open assignment it found, never a newer closed one on another of its steps", () => {
  const { desk } = setup();
  const id = standing(desk, {});
  const open = openAssignment(desk, id, {
    openedBy: "owner",
    steps: ["obs_test_d1"],
  });
  advance(MIN);
  const closed = openAssignment(desk, id, {
    openedBy: "owner",
    steps: ["obs_test_d2"],
  });
  desk.db.run(
    "update assignment set closed_at = ?, outcome = 'test' where id = ?",
    [clock().toISOString(), closed]
  );
  desk.db.run(
    "insert into agent_change (ask, agent_id, applied_at) values ('entry_test', ?, ?)",
    [id, clock().toISOString()]
  );
  expect(
    readStartFacts(desk.db, "entry_test", {
      steps: ["obs_test_d1", "obs_test_d2"],
    }).assignment?.id
  ).toBe(open);
});
