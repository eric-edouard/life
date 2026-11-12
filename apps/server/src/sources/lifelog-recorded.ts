import { z } from "zod";
import { call } from "./lifelog";

// What lifelog says of the pendant's recording (its `GET /recorded`): coverage's evidence for a day Life holds
// nothing of (memory/coverage.ts).

export const Recorded = z.object({
  since: z.string().nullable(),
  stretches: z.array(z.object({ endAt: z.string(), startAt: z.string() })),
});
export type Recorded = z.infer<typeof Recorded>;

/** The stretches the pendant recorded between two instants (at most 31 days; a day: `dayRange`), and `since` when lifelog can tell. */
export async function readRecorded(from: string, to: string) {
  return Recorded.parse(
    await call(`/recorded?${new URLSearchParams({ from, to })}`)
  );
}
