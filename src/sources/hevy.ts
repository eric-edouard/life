import { z } from "zod";

// His workouts as he logs them in Hevy, read from its public API (a Hevy Pro key, `HEVY_API_KEY` in .env). Read-only:
// Life never writes to Hevy. The evidence of a planned workout, which his voice and chats almost never carry.

const API = "https://api.hevyapp.com/v1/workouts/events";

const Workout = z.object({
  end_time: z.string(),
  id: z.string(),
  start_time: z.string(),
  title: z.string(),
});
const Page = z.object({
  events: z.array(
    z.union([
      z.object({ type: z.literal("updated"), workout: Workout }),
      z.object({ id: z.string(), type: z.literal("deleted") }),
    ])
  ),
  page_count: z.int(),
});

export interface Workout {
  end: string;
  start: string;
  title: string;
}

/**
 * His workouts that started in `from`–`to`, by start; null without a key. Read from the change feed since `from`
 * (newest change first, so a workout's first event is how it stands; a deletion hides it).
 */
export async function readWorkouts(
  from: Date,
  to: Date,
  key = process.env.HEVY_API_KEY,
  get = fetch
): Promise<Workout[] | null> {
  if (!key) {
    return null;
  }
  const seen = new Map<string, Workout | null>();
  for (let page = 1, pages = 1; page <= pages; page += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: the page count comes with the first page
    const res = await get(
      `${API}?since=${from.toISOString()}&page=${page}&pageSize=10`,
      { headers: { "api-key": key }, signal: AbortSignal.timeout(30_000) }
    );
    if (!res.ok) {
      throw new Error(`hevy GET /v1/workouts/events: ${res.status}`);
    }
    const body = Page.parse(await res.json());
    pages = body.page_count;
    for (const e of body.events) {
      const id = e.type === "deleted" ? e.id : e.workout.id;
      if (!seen.has(id)) {
        seen.set(
          id,
          e.type === "deleted"
            ? null
            : {
                end: new Date(e.workout.end_time).toISOString(),
                start: new Date(e.workout.start_time).toISOString(),
                title: e.workout.title,
              }
        );
      }
    }
  }
  return [...seen.values()]
    .filter(
      (w): w is Workout =>
        w !== null &&
        w.start >= from.toISOString() &&
        w.start < to.toISOString()
    )
    .toSorted((a, b) => a.start.localeCompare(b.start));
}
