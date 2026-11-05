import { expect, test } from "bun:test";
import { madeBy } from "@life/server/src/memory/record-fixtures";
import type { Episode } from "@life/server/src/records/episode";
import { timelineScore } from "./timeline";

const episode = (over: Partial<Episode>): Episode => ({
  copies: [],
  day: "2026-10-20",
  end: null,
  id: "ep_000000000001",
  importance: 1,
  madeBy,
  people: [],
  place: null,
  schemaVersion: 1,
  start: null,
  title: "An episode",
  units: ["unit_000000000001"],
  what: "",
  within: null,
  ...over,
});

const truth = {
  from: "2026-10-20",
  timeline: [
    {
      end: "2026-10-20 21:30",
      evidence: ["unit_000000000001 'the dinner'", "places 20:00 Rue Neuve"],
      gps: "48.8566,2.3522",
      id: "dinner",
      start: "2026-10-20 20:00",
      title: "Dinner with Bastien",
    },
    {
      end: "2026-10-20 21:30",
      evidence: ["unit_000000000001"],
      gps: null,
      id: "toast",
      start: "2026-10-20 21:00",
      title: "Toast for Kofi at the dinner",
    },
    {
      end: "2026-10-20 10:00",
      evidence: ["unit_000000000002"],
      gps: null,
      id: "gym",
      start: "2026-10-20 09:00",
      title: "Gym",
    },
  ],
  to: "2026-10-20",
};

test("truth and Life episodes sharing a unit while overlapping match one to one; the rest are merged, missed, extra or duplicates", () => {
  const dinner = episode({
    end: "2026-10-20 21:40",
    start: "2026-10-20 19:30",
  });
  const s = timelineScore(
    truth,
    [
      dinner,
      // The same dinner again, shorter: a duplicate.
      episode({
        end: "2026-10-20 20:30",
        id: "ep_000000000002",
        start: "2026-10-20 20:10",
      }),
      // Money moved: shares nothing.
      episode({
        id: "ep_000000000003",
        start: "2026-10-20 12:00",
        units: ["unit_000000000009"],
      }),
      // Another day: out of the window.
      episode({ day: "2026-10-22", id: "ep_000000000004" }),
    ],
    [
      // Where the dinner was, ~100 m off, and home before it.
      {
        arrivedAt: "2026-10-20T17:45:00Z",
        latitude: 48.8575,
        leftAt: null,
        longitude: 2.3522,
        place: "Rue Neuve",
      },
      {
        arrivedAt: "2026-10-20T10:00:00Z",
        latitude: 48.9,
        leftAt: "2026-10-20T17:40:00Z",
        longitude: 2.4,
        place: "Home",
      },
    ]
  );
  expect(s.counts).toMatchObject({
    duplicates: 1,
    end: { checked: 1, ok: 1 },
    extra: 1,
    found: 1,
    merged: 1,
    missed: 1,
    place: { checked: 1, ok: 1 },
    start: { checked: 1, ok: 0 },
    truth: 3,
  });
  const [found, toast] = s.rows;
  expect(found?.episode?.id).toBe(dinner.id);
  expect(found?.startOff).toBe(30);
  // The toast is inside the dinner: read as one with it.
  expect(toast?.into?.id).toBe(dinner.id);
  expect(s.extra.map((m) => m.id)).toEqual(["ep_000000000003"]);
});
