import { expect, test } from "bun:test";
import { readWorkouts } from "./hevy";

const workout = (id: string, start: string, title = "Push") => ({
  type: "updated",
  workout: {
    end_time: start.replace("T07", "T08"),
    exercises: [],
    id,
    start_time: start,
    title,
  },
});

/** Hevy's change feed, newest first, `size` events a page; the URLs it was asked for. */
function feed(events: unknown[], size = 2) {
  const asked: string[] = [];
  const get = (url: string) => {
    asked.push(url);
    const page = Number(new URL(url).searchParams.get("page"));
    return Promise.resolve(
      Response.json({
        events: events.slice((page - 1) * size, page * size),
        page,
        page_count: Math.ceil(events.length / size),
      })
    );
  };
  return { asked, get: get as unknown as typeof fetch };
}

const FROM = new Date("2026-10-12T00:00:00Z");
const TO = new Date("2026-10-19T00:00:00Z");

test("his workouts in the range, by start, across pages: a workout as its newest change has it, a deleted one gone", async () => {
  const { asked, get } = feed([
    workout("a", "2026-10-15T07:00:00Z", "Legs, renamed"),
    { deleted_at: "2026-10-15T09:00:00Z", id: "b", type: "deleted" },
    workout("a", "2026-10-15T07:00:00Z", "Legs"),
    workout("b", "2026-10-14T07:00:00Z"),
    workout("c", "2026-10-13T07:00:00Z"),
    // Logged in the range, done the week after.
    workout("d", "2026-10-20T07:00:00Z"),
  ]);
  expect(await readWorkouts(FROM, TO, "key", get)).toEqual([
    {
      end: "2026-10-13T08:00:00.000Z",
      start: "2026-10-13T07:00:00.000Z",
      title: "Push",
    },
    {
      end: "2026-10-15T08:00:00.000Z",
      start: "2026-10-15T07:00:00.000Z",
      title: "Legs, renamed",
    },
  ]);
  expect(asked).toHaveLength(3);
  expect(asked[0]).toContain(`since=${FROM.toISOString()}`);
});

test("an empty feed, as Hevy sends it (`workouts: []`, no `events`), is no workouts", async () => {
  const get = (() =>
    Promise.resolve(
      Response.json({ page: 1, page_count: 1, workouts: [] })
    )) as unknown as typeof fetch;
  expect(await readWorkouts(FROM, TO, "key", get)).toEqual([]);
});

test("no key, no read; a failed page fails the read", async () => {
  expect(await readWorkouts(FROM, TO, "", feed([]).get)).toBeNull();
  const down = (() =>
    Promise.resolve(
      new Response("", { status: 500 })
    )) as unknown as typeof fetch;
  await expect(readWorkouts(FROM, TO, "key", down)).rejects.toThrow(
    "hevy GET /v1/workouts/events: 500"
  );
});
