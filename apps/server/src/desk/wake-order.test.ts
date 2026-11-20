import { afterEach, expect, setSystemTime, test } from "bun:test";
import { tmpdir } from "node:os";
import { DAY, HOUR, MIN } from "../core/clock";
import { DECISION_ANSWERED } from "../host/events";
import { answerDecision, requestDecision } from "../memory/decisions";
import { register } from "./agent-actions";
import { pollAnswers, wakeDue } from "./desk-clock";
import { moveAssignment } from "./desk-store";
import { advance, ahead, on, setup } from "./test-desk";

// Which turn starts, and for whom (one due rule, `dueOf`): his answer first, only for the agent holding the assignment
// now, never lost while its agent is stopped (decision 78's plan, rules 2 and 9). Made up.

afterEach(() => {
  setSystemTime();
});

test("an assignment moved to another agent while a wake was launching gets no turn of its old holder", async () => {
  const { desk, fake, turns, waiting } = setup();
  const first = await waiting();
  const second = await waiting();
  advance(HOUR + MIN);
  fake.duringSend = () => {
    moveAssignment(desk.db, on(desk, second).id, first, []);
    fake.duringSend = undefined;
    return Promise.resolve();
  };
  await wakeDue(desk);
  expect(turns(second)).toHaveLength(1);
});

test("his answer starts ahead of three new agents' first turns", async () => {
  const { desk, queue, turns, waiting } = setup();
  const id = await waiting(DAY);
  advance(2 * HOUR);
  const fresh = [1, 2, 3].map((i) =>
    register(desk, {
      brief: `Test brief: new start ${i}`,
      folder: tmpdir(),
      runtime: "fake",
    })
  );
  // The answer is newer than the three first turns it must beat.
  advance(MIN);
  queue(id, "dec_3.answered", DECISION_ANSWERED);
  await wakeDue(desk);
  expect(turns(id).at(-1)).toEqual({ cause: "answer", outcome: null });
  expect(fresh.filter((f) => turns(f).length > 0)).toHaveLength(2);
});

test("his answer while its agent is stopped is queued once, and wakes it when he resumes it", async () => {
  const { desk, turns, waiting } = setup();
  const id = await waiting(DAY);
  pollAnswers(desk);
  const { id: dec } = await requestDecision("desk", {
    agent: id,
    context: "A made-up reason to ask.",
    deadline: ahead(DAY),
    options: [
      { id: "yes", label: "Yes" },
      { id: "no", label: "No" },
    ],
    question: "Test: book the made-up table?",
    title: "a test",
  });
  desk.db.run("update agent set status = 'stopped' where id = ?", [id]);
  advance(1000);
  await answerDecision(dec, ["yes"]);
  advance(1000);
  pollAnswers(desk);
  pollAnswers(desk);
  desk.db.run("update agent set status = 'active' where id = ?", [id]);
  await wakeDue(desk);
  expect(turns(id).at(-1)).toEqual({ cause: "answer", outcome: null });
  expect(
    desk.db
      .query<{ n: number }, []>(
        `select count(*) as n from event where name = '${DECISION_ANSWERED}'`
      )
      .get()?.n
  ).toBe(1);
});
