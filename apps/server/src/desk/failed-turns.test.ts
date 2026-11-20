import { afterEach, expect, setSystemTime, test } from "bun:test";
import { DAY, HOUR, MIN } from "../core/clock";
import { currentAssignmentOf } from "../host/desk-read";
import { DECISION_ANSWERED } from "../host/events";
import { wakeDue } from "./desk-clock";
import { advance, setup } from "./test-desk";

// A failed turn, its retries and what it drops (the wait contract, W11): a try counts only for a turn that began.
// Made-up agents and events, over the fake runtime.

afterEach(() => {
  setSystemTime();
});

test("W11: an event handed to every failing turn that began is dropped, flagged, and the default wait stands", async () => {
  const { desk, end, eventRow, fake, queue, turns, waiting } = setup();
  const id = await waiting();
  queue(id, "e1");
  advance(10 * MIN);
  for (const wait of [0, 5 * MIN, 10 * MIN, 20 * MIN]) {
    advance(wait);
    // biome-ignore lint/performance/noAwaitInLoops: one retry after another
    await wakeDue(desk);
    await end(id, true);
  }
  expect(turns(id).map((t) => t.outcome)).toEqual([
    "waited",
    "failed",
    "failed",
    "failed",
    "failed",
  ]);
  const row = eventRow(id, "e1");
  expect(row?.handed).toBe(4);
  expect(row?.dropped_at).not.toBeNull();
  expect(currentAssignmentOf(desk.db, id)?.wait_is_default).toBe(1);
  advance(HOUR);
  await wakeDue(desk);
  expect(turns(id)).toHaveLength(5);
  // At the default wait's deadline a new run of failures starts: retried at 5 minutes, not another 24 hours.
  fake.isFailing = true;
  advance(DAY);
  await wakeDue(desk);
  advance(5 * MIN);
  await wakeDue(desk);
  expect(turns(id).slice(-2)).toEqual([
    { cause: "deadline", outcome: "failed" },
    { cause: "retry", outcome: "failed" },
  ]);
});

// Finding 2 of the action pipeline review (20 Nov 2026): an hour offline, or a runtime out of quota, dropped his
// answer after 4 tries that never ran, and he never knew the agent did not act on it.
test("W11b: offline, turns that never begin drop nothing: his answer stays queued, tried again at the last retry's gap, never at once", async () => {
  const { desk, eventRow, fake, queue, turns, waiting } = setup();
  const id = await waiting(DAY);
  queue(id, "dec_1.answered", DECISION_ANSWERED);
  fake.isFailing = true;
  for (const wait of [0, 5 * MIN, 10 * MIN, 20 * MIN]) {
    advance(wait);
    // biome-ignore lint/performance/noAwaitInLoops: one retry after another
    await wakeDue(desk);
  }
  expect(turns(id)).toEqual([
    { cause: "deadline", outcome: "waited" },
    { cause: "answer", outcome: "failed" },
    { cause: "retry", outcome: "failed" },
    { cause: "retry", outcome: "failed" },
    { cause: "retry", outcome: "failed" },
  ]);
  expect(eventRow(id, "dec_1.answered")).toEqual({
    consumed_at: null,
    dropped_at: null,
    handed: 0,
  });
  advance(19 * MIN);
  await wakeDue(desk);
  expect(turns(id)).toHaveLength(5);
  advance(MIN);
  await wakeDue(desk);
  expect(turns(id).at(-1)).toEqual({ cause: "answer", outcome: "failed" });
  // Back online: the next try begins, and counts.
  fake.isFailing = false;
  advance(5 * MIN);
  await wakeDue(desk);
  expect(turns(id).at(-1)).toEqual({ cause: "retry", outcome: null });
  expect(eventRow(id, "dec_1.answered")?.handed).toBe(1);
});

test("W11c: a blocked runtime starts no turn, so no try is spent; his answer wakes the agent once it answers", async () => {
  const { desk, fake, queue, turns, waiting } = setup();
  const id = await waiting(DAY);
  queue(id, "dec_2.answered", DECISION_ANSWERED);
  fake.blocked = "Test: out of quota";
  await wakeDue(desk);
  advance(HOUR);
  await wakeDue(desk);
  expect(turns(id)).toHaveLength(1);
  fake.blocked = undefined;
  await wakeDue(desk);
  expect(turns(id).at(-1)).toEqual({ cause: "answer", outcome: null });
});
