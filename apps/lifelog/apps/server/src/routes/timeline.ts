// What the phone sends for grouping (rebuild contract): each source's timeline facts and
// heard-through. All idempotent; a write that can move a boundary
// regroups after it commits (grouping.ts).
import { createRoute, z } from "@hono/zod-openapi";
import { DAY } from "@life/server/src/core/clock";
import { hasRawPages, sources } from "@lifelog/db/schema";
import { sql } from "drizzle-orm";
import { record } from "../events";
import { regroupAfterCommit } from "../grouping";
import type { Services } from "../services";
import { Instant, recorded, saveSpans, TimelineSpan } from "../timeline-spans";
import { json, router, sizeLimit } from "./common";

const Timeline = z
  .object({
    heardThrough: Instant.nullable().describe(
      "Capture time of the durable, analyzed, contiguous page prefix; only moves forward"
    ),
    sentThrough: Instant.nullable()
      .optional()
      .describe(
        "Every kept second before it is in a speech fragment the server holds: the start of the first stretch not sent, or heard-through when none waits. The server closes blocks on it"
      ),
    spans: z.array(TimelineSpan).max(2000),
  })
  .openapi("Timeline");

export function timelineRoutes({
  db,
  rolling,
  states,
  worker,
}: Pick<Services, "db" | "rolling" | "states" | "worker">) {
  // What the request marked dirty (grouping.ts `markDirty`) is regrouped once it committed.
  // In the background after it: the voices read of what is still going on, and waiting reasons.
  const regroup = (sourceIds: string[]) => {
    regroupAfterCommit(db, sourceIds);
    rolling.drain();
    states.refresh();
  };

  return router()
    .openapi(
      createRoute({
        description:
          "The stretches a Pendant recorded that overlap `from`..`to` (at most 31 days; a day is the reader's own " +
          "bounds of it), oldest first, whole, pauses under a minute joined; and `since`, the start of the first " +
          "recording held: before it, no stretch says nothing.",
        method: "get",
        path: "/recorded",
        request: {
          query: z
            .object({ from: Instant, to: Instant })
            .refine((q) => Date.parse(q.to) - Date.parse(q.from) <= 31 * DAY, {
              message: "at most 31 days: page a longer read",
            }),
        },
        responses: {
          200: json(
            z
              .object({
                since: Instant.nullable(),
                stretches: z.array(
                  z.object({ endAt: Instant, startAt: Instant })
                ),
              })
              .openapi("Recorded"),
            "Recorded"
          ),
        },
      }),
      (c) => {
        const { from, to } = c.req.valid("query");
        return c.json(recorded(db, new Date(from), new Date(to)), 200);
      }
    )
    .openapi(
      createRoute({
        description:
          "The phone's timeline facts for a source, by span. A span replaces the stored one with the same " +
          "first page; heard-through only moves forward. Conversations are regrouped from the earliest " +
          "change; the handover's history (spans of negative first page) stays beside the phone's spans.",
        method: "put",
        middleware: [sizeLimit(8 * 1024 * 1024)] as const,
        path: "/sources/{sourceId}/timeline",
        request: {
          body: {
            content: { "application/json": { schema: Timeline } },
            required: true,
          },
          params: z.object({ sourceId: z.string().min(1).max(200) }),
        },
        responses: {
          200: json(
            z.object({ heardThrough: Instant.nullable(), spans: z.int() }),
            "Stored; conversations regrouped"
          ),
        },
      }),
      (c) => {
        const { sourceId } = c.req.valid("param");
        const body = c.req.valid("json");
        // One writer per source: a raw-page source's are the server's own (page-processing.ts).
        const [page] = db.all<{ source: number }>(
          sql`select ${hasRawPages(sql`${sourceId}`)} as source`
        );
        const phone = !page?.source;
        const heard =
          phone && body.heardThrough ? new Date(body.heardThrough) : null;
        const sent =
          phone && body.sentThrough ? new Date(body.sentThrough) : null;
        const done = db.transaction((tx) => {
          const source = tx
            .insert(sources)
            .values({
              heardThrough: heard,
              id: sourceId,
              sentThrough: sent,
            })
            .onConflictDoUpdate({
              set: {
                heardThrough: sql`max(coalesce(${sources.heardThrough}, excluded.heard_through),
                  coalesce(excluded.heard_through, ${sources.heardThrough}))`,
                // The phone's latest word; a phone that doesn't say keeps the last one.
                sentThrough: sql`coalesce(excluded.sent_through, ${sources.sentThrough})`,
              },
              target: sources.id,
            })
            .returning({ heardThrough: sources.heardThrough })
            .get();
          return {
            heardThrough: source?.heardThrough ?? null,
            moved: saveSpans(tx, sourceId, body.spans),
            stored: body.spans.length,
          };
        });
        for (const fields of done.moved) {
          record(db, "job.span_moved", fields);
        }
        // What the phone sent through may close a block (cutter.ts).
        if (sent) {
          worker.poke();
        }
        regroup([sourceId]);
        return c.json(
          {
            heardThrough: done.heardThrough?.toISOString() ?? null,
            spans: done.stored,
          },
          200
        );
      }
    );
}
