import { afterEach, expect, setSystemTime, test } from "bun:test";
import { clock, DAY, HOUR } from "../core/clock";
import { handedOutSince, heldByAgents } from "../host/desk-read";
import { register } from "./agent-actions";
import { handOutDayStartOf, handOutOf, paceRefusalOf } from "./hand-out";
import { setup } from "./test-desk";

// What the desk starts an agent on, and how fast. Made-up matters, steps and agents.

afterEach(() => {
  setSystemTime();
});

const m = (id: string, steps: string[]) => ({ id, steps });
const book = [
  m("mat_a", ["obs_a1", "obs_a2"]),
  m("mat_b", ["obs_b1"]),
  m("mat_c", ["obs_c1"]),
];
const pick = (
  over: Partial<Parameters<typeof handOutOf<(typeof book)[number]>>[0]> = {}
) =>
  handOutOf({
    dismissed: [],
    held: new Set(),
    matters: book,
    offered: new Set(),
    ...over,
  })?.id;

test("the top matter is the first of his ranking, and none when the ranking is empty", () => {
  expect(pick()).toBe("mat_a");
  expect(pick({ matters: [] })).toBeUndefined();
});

test("a matter an agent is anchored on is skipped", () => {
  expect(pick({ held: new Set(["obs_a2"]) })).toBe("mat_b");
});

test("his stopped agent holds its matter; a project's agent holds none", () => {
  const { desk } = setup();
  const own = (subject: object) =>
    register(desk, { brief: "Test brief", runtime: "fake", ...subject });
  const stopped = own({ steps: ["obs_a1"] });
  desk.db.run("update agent set status = 'stopped' where id = ?", [stopped]);
  own({ project: "test-bakery" });
  const held = new Set(heldByAgents(desk.db).steps);
  expect([...held]).toEqual(["obs_a1"]);
  expect(pick({ held })).toBe("mat_b");
});

test("a matter he dismissed is skipped, found by the steps it was pinned to", () => {
  expect(pick({ dismissed: [["obs_a1"]] })).toBe("mat_b");
  expect(pick({ dismissed: [["obs_a1"], ["obs_b1"]] })).toBe("mat_c");
});

test("a matter with an open Start card is skipped: the card owns it", () => {
  expect(pick({ offered: new Set(["mat_a", "mat_b"]) })).toBe("mat_c");
});

test("no matter qualifies: none", () => {
  expect(pick({ offered: new Set(book.map((b) => b.id)) })).toBeUndefined();
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

test("his day starts at his midnight, not the Mac's", () => {
  // 17:30 UTC on the 20th is 00:30 on the 21st in Bangkok, 18:30 on the 20th in Paris.
  const now = new Date(Date.UTC(2026, 10, 20, 17, 30));
  expect(handOutDayStartOf(now, "Asia/Bangkok").toISOString()).toBe(
    "2026-11-20T17:00:00.000Z"
  );
  expect(handOutDayStartOf(now, "Europe/Paris").toISOString()).toBe(
    "2026-11-19T23:00:00.000Z"
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
