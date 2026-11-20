import { afterEach, expect, setSystemTime, test } from "bun:test";
import { clock, HOUR, MIN } from "../core/clock";
import { currentAssignmentOf } from "../host/desk-read";
import { openAssignment, setWait } from "./agent-actions";
import { wakeDue } from "./desk-clock";
import { agentWakesOf } from "./event-queue";
import { advance, ahead, asgOf, setup } from "./test-desk";

// Assignments of one agent keep apart (agents and matters, PR 1): a turn consumes only its own assignment's events, and
// nothing from before an assignment was opened is new to it.

afterEach(() => {
  setSystemTime();
});

test("a turn on one assignment never consumes another's events", async () => {
  const { desk, end, waiting } = setup();
  const id = await waiting();
  const first = asgOf(desk, id);
  const second = openAssignment(desk, id, {
    openedBy: "owner",
    steps: ["obs_test_b"],
  });
  for (const [assignment, eventId] of [
    [first, "e1"],
    [second, "e2"],
  ] as const) {
    desk.db.run(
      "insert into event (assignment_id, event_id, name, payload, received_at) values (?, ?, 'message.received', '{}', ?)",
      [assignment, eventId, clock().toISOString()]
    );
  }
  advance(HOUR);
  await wakeDue(desk);
  // The agent's one turn runs on one of the two; it ends with its set_wait.
  const ran = desk.db
    .query<{ assignment_id: string }, []>(
      "select assignment_id from turn order by id desc limit 1"
    )
    .get()?.assignment_id;
  await setWait(desk, id, { events: [], reason: "r", until: ahead(HOUR) });
  await end(id);
  const [mine, other] = ran === first ? ["e1", "e2"] : ["e2", "e1"];
  const row = (eventId: string) =>
    desk.db
      .query<{ consumed_at: string | null; handed: number }, [string]>(
        "select handed, consumed_at from event where event_id = ?"
      )
      .get(eventId);
  expect(row(mine)?.consumed_at).not.toBeNull();
  expect(row(other)).toEqual({ consumed_at: null, handed: 0 });
});

test("an event from before an assignment was opened never wakes it", async () => {
  const { desk, waiting } = setup();
  const id = await waiting();
  const mine = currentAssignmentOf(desk.db, id);
  const event = (eventId: string, at: string) => ({
    at,
    eventId,
    matchable: { channel: "whatsapp", chat: "Test Ana", fromMe: false },
    payload: {},
  });
  const wakes = (e: ReturnType<typeof event>) =>
    agentWakesOf(desk.db, mine ? [mine] : [], {} as never, [e]);
  // `waiting` opened the assignment now, T0: an event a minute older was heard before it.
  expect(wakes(event("before", ahead(-MIN)))).toEqual([]);
  expect(wakes(event("after", ahead(MIN)))).toEqual([
    { assignment: mine?.id ?? "", eventId: "after", payload: {} },
  ]);
});
