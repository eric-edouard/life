import type { Moment } from "../schema";
import { type Block, PLAN_TAG, readPlan } from "../sources/calendar";
import { readWorkouts, type Workout } from "../sources/hevy";
import { daysOf } from "./ledger";
import { asData } from "./raw";
import { momentLine, momentsWhere } from "./search";
import { daysBefore, time } from "./units";
import { dayStart, localDate } from "./zones";

// `bun life memory week <date>`, and the connector's `week`: the plan next to what happened, day by day, Monday to
// Sunday of the week holding `date`. The plan is his calendar's `#plan` blocks, the workouts are Hevy's, the rest is
// the moments. Nothing is matched or judged here: the reader (Atlas, at the weekly review) does that.

const span = (b: Block | Workout) => `${time(b.start)}–${time(b.end)}`;
/** An all-day block is stored at midnight UTC of its own day, whatever zone he is in. */
const dayOf = (b: Block) =>
  b.allDay ? b.start.slice(0, 10) : localDate(b.start);
/** A moment touching any day from `first` to `last`. */
const touches = (m: Moment, first: string, last: string) => {
  const [from, to] = daysOf(m);
  return from <= last && first <= to;
};

/** A section: its lines, `empty` when there are none, or that its source is not connected (`lines` null, `key` unset). */
function section(
  title: string,
  lines: string[] | null,
  empty: string,
  key = ""
) {
  if (lines === null) {
    return [title, `  not connected (${key} is not set in .env)`];
  }
  return [title, ...(lines.length === 0 ? [`  ${empty}`] : lines)];
}

/** The week's lines: each day's plan, workouts and moments; `plan` or `workouts` null when that source is not connected. */
export function weekLines(
  days: string[],
  plan: Block[] | null,
  workouts: Workout[] | null,
  moments: Moment[]
) {
  return days.flatMap((d) => [
    `## ${d}`,
    ...section(
      "Plan (his calendar):",
      plan
        ?.filter((b) => dayOf(b) === d)
        .map((b) => `- ${b.allDay ? "all day" : span(b)} ${b.title}`) ?? null,
      "no plan",
      "LIFE_CALENDAR"
    ),
    ...section(
      "Workouts (Hevy):",
      workouts
        ?.filter((w) => localDate(w.start) === d)
        .map((w) => `- ${span(w)} ${w.title}`) ?? null,
      "none logged",
      "HEVY_API_KEY"
    ),
    ...section(
      "Moments:",
      moments.filter((m) => touches(m, d, d)).map(momentLine),
      "none"
    ),
    "",
  ]);
}

export async function week(date: string) {
  // Monday of `date`'s week.
  const monday = daysBefore(
    date,
    (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7
  );
  const days = Array.from({ length: 7 }, (_, i) => daysBefore(monday, -i));
  const [from, to] = [dayStart(monday), dayStart(daysBefore(monday, -7))];
  const [plan, workouts, moments] = await Promise.all([
    readPlan(from, to),
    readWorkouts(from, to),
    momentsWhere((m) => touches(m, monday, days.at(-1) as string)),
  ]);
  return asData([
    `The week of ${monday}: the plan (blocks tagged ${PLAN_TAG} on his calendar), his Hevy workouts and the moments, day by day. A planned block with nothing for it is no evidence, not proof it was missed.`,
    "",
    ...weekLines(days, plan, workouts, moments),
  ]);
}
