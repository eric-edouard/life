// What the phone sends for grouping (rebuild contract): each source's timeline facts and
// heard-through and the owner's grouping edits. All idempotent; a write that can move a boundary
// regroups after it commits (grouping.ts).
import { createRoute, z } from "@hono/zod-openapi";
import { hasRawPages, sources } from "@lifelog/db/schema";
import { sql } from "drizzle-orm";
import { record } from "../events";
import { pendantSources, regroupAfterCommit, saveEdit } from "../grouping";
import type { Services } from "../services";
import { Instant, saveSpans, TimelineSpan } from "../timeline-spans";
import { ApiError, json, router, sizeLimit } from "./common";

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

const editBase = { editedAt: Instant, id: z.uuid() };
const Edit = z
  .discriminatedUnion("kind", [
    z.object({ ...editBase, at: Instant, kind: z.literal("split") }),
    z.object({
      ...editBase,
      from: Instant,
      kind: z.literal("merge"),
      to: Instant,
    }),
    z.object({ ...editBase, edit: z.uuid(), kind: z.literal("undo") }),
    z.object({ ...editBase, at: Instant, kind: z.literal("dismissSplit") }),
  ])
  .refine(
    (e) => e.kind !== "merge" || Date.parse(e.from) < Date.parse(e.to),
    "a merge ends after it starts"
  )
  .openapi("OwnerEdit");

const notFound = (message: string) =>
  ({ error: "not_found", message }) as const;

export function timelineRoutes({
  db,
  rolling,
  states,
  worker,
}: Pick<Services, "db" | "rolling" | "states" | "worker">) {
  // What the request marked dirty (grouping.ts `markDirty`) is regrouped once it committed.
  // In the background after it: chapters of what is still going on, and waiting reasons.
  const regroup = (sourceIds: string[]) => {
    regroupAfterCommit(db, sourceIds);
    rolling.drain();
    states.refresh();
  };

  return router()
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
    )
    .openapi(
      createRoute({
        description:
          "An owner's grouping edit, idempotent by its id: split, merge, undo (of an earlier edit) or a " +
          "dismissed split suggestion. Conversations are regrouped from where it applies.",
        method: "post",
        path: "/edits",
        request: {
          body: {
            content: { "application/json": { schema: Edit } },
            required: true,
          },
        },
        responses: {
          200: json(z.object({ stored: z.boolean() }), "Kept (or already)"),
          400: json(
            ApiError,
            "An undo of an undo, or a split or merge inside an imported recording"
          ),
          404: json(ApiError, "An undo of an edit the server doesn't have"),
        },
      }),
      (c) => {
        const edit = c.req.valid("json");
        const result = saveEdit(db, edit);
        if ("refused" in result) {
          return result.refused === "unknown"
            ? c.json(notFound("No such edit"), 404)
            : c.json(
                {
                  error: "invalid_request" as const,
                  message:
                    result.refused === "imported"
                      ? "A recording imported from the old app can't be split or merged"
                      : "An undo can't be undone; edit again instead",
                },
                400
              );
        }
        // A replay regroups too: the first try may have stopped before it did.
        regroup(pendantSources(db));
        return c.json({ stored: result.stored }, 200);
      }
    );
}
