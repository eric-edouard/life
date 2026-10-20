import type { Moment } from "../schema";
import { type Block, PLAN_TAG, readPlan } from "../sources/calendar";
import { readWorkouts, type Workout } from "../sources/hevy";
import { touches } from "./ledger";
import { asData } from "./raw";
import { momentLine, momentsWhere } from "./search";
import { dayRange, daysBefore, time } from "./units";
import { localDate } from "./zones";

// `bun life memory week <date>`, and the connector's `week`: the plan next to what happened, day by day, Monday to
// Sunday of the week holding `date`. The plan is his calendar's `#plan` blocks, the workouts are Hevy's, the rest is
// the moments. Nothing is matched or judged here: the reader (Atlas, at the weekly review) does that.

const span = (b: Block | Workout) => `${time(b.start)}–${time(b.end)}`;
/** An all-day block is stored at midnight UTC of its own day, whatever zone he is in. */
const dayOf = (b: Block) =>
  b.allDay ? b.start.slice(0, 10) : localDate(b.start);

/** A section of a day: the rows of `list` that `keep` keeps, `empty` when none does, or why the source gave none. */
function section<T>(
  title: string,
  list: T[] | string,
  keep: (x: T) => boolean,
  line: (x: T) => string,
  empty: string
) {
  if (typeof list === "string") {
    return [title, `  ${list}`];
  }
  const lines = list.filter(keep).map(line);
  return [title, ...(lines.length > 0 ? lines : [`  ${empty}`])];
}

/** The week's lines: each day's plan, workouts and moments; `plan` or `workouts` a string when that source gave none. */
export function weekLines(
  days: string[],
  plan: Block[] | string,
  workouts: Workout[] | string,
  moments: Moment[]
) {
  return days.flatMap((d) => [
    `## ${d}`,
    ...section(
      "Plan (his calendar):",
      plan,
      (b) => dayOf(b) === d,
      (b) => `- ${b.allDay ? "all day" : span(b)} ${b.title}`,
      "no plan"
    ),
    ...section(
      "Workouts (Hevy):",
      workouts,
      (w) => localDate(w.start) === d,
      (w) => `- ${span(w)} ${w.title}`,
      "none logged"
    ),
    ...section(
      "Moments:",
      moments,
      (m) => touches(m, d, d),
      momentLine,
      "none"
    ),
    "",
  ]);
}

/** A source's rows, or why there are none: its key unset, or the read failed (the rest of the week still shows). */
async function rows<T>(
  key: string,
  read: () => T[] | null | Promise<T[] | null>
): Promise<T[] | string> {
  try {
    return (await read()) ?? `not connected (${key} is not set in .env)`;
  } catch (e) {
    return `unreadable: ${(e as Error).message}`;
  }
}

export async function week(date: string) {
  // Monday of `date`'s week.
  const monday = daysBefore(
    date,
    (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7
  );
  const days = Array.from({ length: 7 }, (_, i) => daysBefore(monday, -i));
  const sunday = days.at(-1) as string;
  const range = dayRange(monday, sunday);
  const [from, to] = [new Date(range.from ?? ""), new Date(range.to ?? "")];
  const [plan, workouts, moments] = await Promise.all([
    rows("LIFE_CALENDAR", () => readPlan(from, to)),
    rows("HEVY_API_KEY", () => readWorkouts(from, to)),
    momentsWhere((m) => touches(m, monday, sunday)),
  ]);
  return asData([
    `The week of ${monday}: the plan (blocks tagged ${PLAN_TAG} on his calendar), his Hevy workouts and the moments, day by day. A planned block with nothing for it is no evidence, not proof it was missed.`,
    "",
    ...weekLines(days, plan, workouts, moments),
  ]);
}
