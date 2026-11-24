import { z } from "zod";
import { call } from "./lifelog-call";

// lifelog's search of the exact spoken words (POST /search).

export const Hits = z.object({
  hits: z.array(
    z.object({
      capturedFrom: z.string().nullable(),
      conversationId: z.string(),
      firstTurn: z.number(),
      jobId: z.string(),
      lastTurn: z.number(),
      speakers: z.array(z.string()),
      text: z.string(),
    })
  ),
});

/** lifelog's search of the exact spoken words, best first. `from` is inclusive, `to` exclusive (ISO instants). */
export async function searchVoice(
  query: string,
  range: { from?: string; to?: string },
  limit: number
) {
  return Hits.parse(
    await call("/search", 60, {
      dateRange: range,
      limit,
      query,
    })
  ).hits;
}
