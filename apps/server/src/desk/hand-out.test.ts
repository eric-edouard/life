import { afterEach, expect, setSystemTime, test } from "bun:test";
import { clock, DAY, HOUR } from "../core/clock";
import { handedOutSince, heldByAgents } from "../host/desk-read";
import { isHeldOf } from "../memory/held-matters";
import { register } from "./agent-actions";
import {
  CARD_WITHIN_MS,
  handOutOf,
  isCardOverdue,
  paceRefusalOf,
} from "./hand-out";
import { setup } from "./test-desk";

// What the desk starts an agent on, and how fast. Made-up matters, steps and agents.

afterEach(() => {
  setSystemTime();
});

const AT = "2026-11-18T09:00:00.000Z";
const m = (id: string, steps: string[]) => ({
  id,
  steps: steps.map((ref) => ({ at: AT, ref })),
});
const book = [
  m("mat_a", ["obs_a1", "obs_a2"]),
  m("mat_b", ["obs_b1"]),
  m("mat_c", ["obs_c1"]),
];
const heldOn = (...steps: string[]) =>
  isHeldOf(
    steps.map((step) => ({
      endedAt: null,
      kind: "asked" as const,
      outcome: null,
      project: null,
      step,
      whyNotStarted: null,
    }))
  );
const pick = (
  over: Partial<Parameters<typeof handOutOf<(typeof book)[number]>>[0]> = {}
) =>
  handOutOf({
    dismissed: [],
    isHeld: heldOn(),
    matters: book,
    ...over,
  })?.id;

test("the top matter is the first of his ranking, and none when the ranking is empty", () => {
  expect(pick()).toBe("mat_a");
  expect(pick({ matters: [] })).toBeUndefined();
});

test("a matter an agent is anchored on is skipped", () => {
  expect(pick({ isHeld: heldOn("obs_a2") })).toBe("mat_b");
});

test("his stopped agent holds its matter; a project's agent holds none", () => {
  const { desk } = setup();
  const own = (subject: object) =>
    register(desk, { brief: "Test brief", runtime: "fake", ...subject });
  const stopped = own({ steps: ["obs_a1"] });
  desk.db.run("update agent set status = 'stopped' where id = ?", [stopped]);
  own({ project: "test-bakery" });
  const holds = heldByAgents(desk.db);
  expect(holds.map((h) => h.step ?? h.project)).toEqual([
    "obs_a1",
    "test-bakery",
  ]);
  expect(pick({ isHeld: isHeldOf(holds) })).toBe("mat_b");
});

test("a matter he dismissed is skipped, found by the steps it was pinned to", () => {
  expect(pick({ dismissed: [["obs_a1"]] })).toBe("mat_b");
  expect(pick({ dismissed: [["obs_a1"], ["obs_b1"]] })).toBe("mat_c");
});

test("no matter qualifies: none", () => {
  expect(
    pick({ isHeld: heldOn("obs_a1", "obs_b1", "obs_c1") })
  ).toBeUndefined();
});

const pace = { aDay: 3, cardsWaiting: 2 };

test("enough cards waiting stop the hand-out", () => {
  expect(paceRefusalOf(pace, { cardsOpen: 1, startedToday: 0 })).toBeNull();
  expect(paceRefusalOf(pace, { cardsOpen: 2, startedToday: 0 })).toContain(
    "cards wait"
  );
});

test("enough started today stop the hand-out", () => {
  expect(paceRefusalOf(pace, { cardsOpen: 0, startedToday: 2 })).toBeNull();
  expect(paceRefusalOf(pace, { cardsOpen: 0, startedToday: 3 })).toContain(
    "started"
  );
});

test("hand-outs count from a given instant only", () => {
  const { desk } = setup();
  const id = register(desk, { brief: "Test brief", runtime: "fake" });
  desk.db.run(
    "update agent set is_handed_out = 1, created_at = ? where id = ?",
    [new Date(clock().getTime() - 2 * DAY - HOUR).toISOString(), id]
  );
  expect(
    handedOutSince(desk.db, new Date(clock().getTime() - DAY).toISOString())
  ).toBe(0);
  expect(
    handedOutSince(desk.db, new Date(clock().getTime() - 3 * DAY).toISOString())
  ).toBe(1);
});

test("a card is overdue for an active handed-out agent whose first turn began 2 hours ago and that asked none", () => {
  const now = clock().getTime();
  const a = {
    first_begun_at: new Date(now - CARD_WITHIN_MS).toISOString(),
    is_handed_out: 1,
    status: "active" as const,
  };
  expect(isCardOverdue(a, false, now)).toBe(true);
  expect(isCardOverdue(a, false, now - 1)).toBe(false);
  expect(isCardOverdue(a, true, now)).toBe(false);
  expect(isCardOverdue({ ...a, first_begun_at: null }, false, now)).toBe(false);
  expect(isCardOverdue({ ...a, is_handed_out: 0 }, false, now)).toBe(false);
  expect(isCardOverdue({ ...a, status: "ended" as const }, false, now)).toBe(
    false
  );
});
