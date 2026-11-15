import { z } from "zod";
import { DAY, iso } from "../core/clock";
import { call } from "./lifelog";

// What lifelog says of the pendant's recording (its `GET /recorded`), read by the night into the recorded days
// (memory/recorded-days.ts).

export const Recorded = z.object({
  since: z.string().nullable(),
  stretches: z.array(z.object({ endAt: z.string(), startAt: z.string() })),
});
export type Recorded = z.infer<typeof Recorded>;

/** The longest range one call may ask: the route refuses more. */
const PAGE = 31 * DAY;

/**
 * Every stretch the pendant recorded up to `to`, oldest first, and `since` when lifelog can tell. Asked a page at a
 * time, newest first, stopping at the page `since` falls in: nothing is held before it, and with none (`since` null)
 * nothing is held at all. A stretch crossing a page's edge comes back in both, whole: its one reader keeps days
 * (`recordedDaysOf`), so none is merged.
 */
export async function readRecorded(
  to: string,
  ask = (from: string, until: string) =>
    call(`/recorded?${new URLSearchParams({ from, to: until })}`)
): Promise<Recorded> {
  const end = Date.parse(to);
  const from = iso(end - PAGE);
  const page = Recorded.parse(await ask(from, iso(end)));
  if (!page.since || page.since >= from) {
    return page;
  }
  const earlier = await readRecorded(from, ask);
  return {
    since: page.since,
    stretches: [...earlier.stretches, ...page.stretches],
  };
}
