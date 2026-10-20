import { expect, test } from "bun:test";
import type { Moment } from "../schema";
import { week, weekLines } from "./week";

const moment = (over: Partial<Moment>): Moment => ({
  copies: [],
  day: "2026-10-14",
  end: null,
  id: "mom_000000000001",
  importance: 1,
  madeBy: {
    engine: "claude",
    model: "m",
    prompt: "memory-moments.v3",
    run: "r",
  },
  people: [],
  place: null,
  schemaVersion: 1,
  start: "2026-10-14 09:00",
  status: "happened",
  title: "Coffee with Bastien",
  units: ["u_000000000001"],
  why: "w",
  ...over,
});

test("each day lays the plan next to the workouts and the moments, in his zone then (Berlin), an all-day block on its own day", () => {
  const lines = weekLines(
    ["2026-10-14", "2026-10-15"],
    [
      {
        allDay: false,
        end: "2026-10-14T06:00:00.000Z",
        start: "2026-10-14T05:00:00.000Z",
        title: "Workout",
      },
      {
        allDay: true,
        end: "2026-10-16T00:00:00.000Z",
        start: "2026-10-15T00:00:00.000Z",
        title: "Free time",
      },
    ],
    [
      {
        end: "2026-10-14T06:10:00.000Z",
        start: "2026-10-14T05:20:00.000Z",
        title: "Push",
      },
    ],
    [moment({})]
  );
  expect(lines).toEqual([
    "## 2026-10-14",
    "Plan (his calendar):",
    "- 07:00–08:00 Workout",
    "Workouts (Hevy):",
    "- 07:20–08:10 Push",
    "Moments:",
    "- mom_000000000001 2026-10-14 09:00 Coffee with Bastien (happened) [u_000000000001]",
    "",
    "## 2026-10-15",
    "Plan (his calendar):",
    "- all day Free time",
    "Workouts (Hevy):",
    "  none logged",
    "Moments:",
    "  none",
    "",
  ]);
});

test("a source that gave nothing says why, never reads as an empty day; any date reads its Monday-to-Sunday week", async () => {
  const lines = weekLines(
    ["2026-10-14"],
    "unreadable: no such table: Calendar",
    "not connected (HEVY_API_KEY is not set in .env)",
    []
  );
  expect(lines).toContain("  unreadable: no such table: Calendar");
  expect(lines).toContain("  not connected (HEVY_API_KEY is not set in .env)");
  expect(lines).not.toContain("  no plan");
  const sunday = await week("2026-10-18");
  expect(sunday).toContain("The week of 2026-10-12");
  expect(sunday).toContain("## 2026-10-18");
  expect(sunday).not.toContain("## 2026-10-19");
  expect(sunday).toContain(
    "  not connected (LIFE_CALENDAR is not set in .env)"
  );
});
