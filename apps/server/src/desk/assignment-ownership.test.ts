import { afterEach, expect, setSystemTime, test } from "bun:test";
import { clock, DAY } from "../core/clock";
import {
  agentOf,
  assignmentOf,
  assignmentOfCard,
  openAssignments,
} from "../host/desk-read";
import { openAssignment, register } from "./agent-actions";
import { start } from "./agent-changes";
import { wakeDue } from "./desk-clock";
import { setup } from "./test-desk";

// The debt verdict on PR 3 (#810, 21 Nov 2026): an agent and its assignments are not one thing. Each test is one of its
// findings, made up.

afterEach(() => {
  setSystemTime();
});

const later = () => new Date(clock().getTime() + 30 * DAY).toISOString();

/** An agent of the made-up desk, its own listening waiting a month. */
function standing(
  desk: ReturnType<typeof setup>["desk"],
  a: { isPersonal?: boolean; project?: string }
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
  const personal = standing(desk, { isPersonal: true });
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
  const first = openAssignments(desk.db)[0]?.id;
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
