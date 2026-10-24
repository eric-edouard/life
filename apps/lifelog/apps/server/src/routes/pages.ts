// Page ingest: a thin phone's raw pages (pages.ts) and what the server holds of them.
import { createRoute, z } from "@hono/zod-openapi";
import { safeJson } from "../elevenlabs";
import { ingestState, PageBatch, storePages } from "../pages";
import type { Services } from "../services";
import {
  ApiError,
  FirstPage,
  json,
  router,
  SourceId,
  sizeLimit,
} from "./common";

const IngestState = z
  .object({
    highestPage: z
      .int()
      .nullable()
      .describe(
        "The highest page index stored, null when none is: a hint, not a resume cursor (holes stay below it)"
      ),
    labeledUntil: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe(
        "Capture time up to which the server has labeled the source's speech, null before any"
      ),
  })
  .openapi("IngestState");

const SourceParam = z.object({ sourceId: SourceId });

export function pageRoutes({
  audio,
  db,
  pages,
}: Pick<Services, "audio" | "db" | "pages">) {
  const app = router();
  // Sent as a JSON string inside the multipart upload, so registered by hand.
  app.openAPIRegistry.register("PageBatch", PageBatch);
  return app
    .openapi(
      createRoute({
        description: "What the server holds of a source's raw pages.",
        method: "get",
        path: "/sources/{sourceId}/ingest",
        request: { params: SourceParam },
        responses: { 200: json(IngestState, "The source's ingest state") },
      }),
      (c) => c.json(ingestState(db, c.req.valid("param").sourceId), 200)
    )
    .openapi(
      createRoute({
        description:
          "Upload raw pages exactly as the phone stored them, contiguous from `firstPage`, in index " +
          "order. Idempotent: a page already stored with the same bytes is accepted and kept once. " +
          "Any 200 means every page of the batch is with the server. The server decides what gets " +
          "transcribed: it labels the speech of an Omi source's pages and cuts it into speech " +
          "fragments itself, as the iPhone would.",
        method: "put",
        middleware: [sizeLimit(64 * 1024 * 1024)] as const,
        path: "/sources/{sourceId}/pages/{firstPage}",
        request: {
          body: {
            content: {
              "multipart/form-data": {
                schema: z.object({
                  metadata: z.string().openapi({
                    description: "JSON-encoded PageBatch",
                  }),
                  pages: z
                    .instanceof(File)
                    .openapi({ format: "binary", type: "string" }),
                }),
              },
            },
            required: true,
          },
          params: SourceParam.extend({
            firstPage: FirstPage,
          }),
        },
        responses: {
          200: json(IngestState, "Stored, or held already"),
          400: json(
            ApiError,
            "Invalid metadata, a hash mismatch, lengths that don't add up, or pages not contiguous from firstPage"
          ),
          409: json(
            ApiError.extend({
              page: z
                .int()
                .describe(
                  "The first index that holds other bytes: the phone moves it and the pages after it to a new band"
                ),
            }).openapi("PageConflict"),
            "A page's index holds other bytes (page_conflict), as after a new flash life the phone didn't band: nothing was kept"
          ),
          503: json(
            ApiError,
            "The pages could not be stored (audio_store_unavailable): nothing was kept"
          ),
        },
      }),
      async (c) => {
        const { firstPage, sourceId } = c.req.valid("param");
        const form = c.req.valid("form");
        const parsed = PageBatch.safeParse(safeJson(form.metadata));
        if (!parsed.success) {
          const { message } = parsed.error;
          return c.json({ error: "invalid_request" as const, message }, 400);
        }
        const bytes = new Uint8Array(await form.pages.arrayBuffer());
        const stored = await storePages(
          db,
          audio,
          sourceId,
          firstPage,
          parsed.data,
          bytes
        );
        if (stored === "unavailable") {
          c.header("Retry-After", "30");
          const message =
            "the pages could not be stored; send them again later";
          return c.json(
            { error: "audio_store_unavailable" as const, message },
            503
          );
        }
        if ("conflict" in stored) {
          const message =
            "a page's index holds other bytes: nothing was kept (a new flash life needs its own band)";
          return c.json(
            { error: "page_conflict" as const, message, page: stored.conflict },
            409
          );
        }
        if ("invalid" in stored) {
          const message = stored.invalid;
          return c.json({ error: "invalid_request" as const, message }, 400);
        }
        pages.poke(sourceId);
        return c.json(stored, 200);
      }
    );
}
