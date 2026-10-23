// Speech: the phone's kept speech as fragments of whole Pendant pages, which the server closes into
// blocks itself (cutter.ts), and the pages it holds of a source.
import { createRoute, z } from "@hono/zod-openapi";
import { joinTouching } from "@life/voice-db/schema";
import { joinOggOpus } from "../audio";
import { Sha256 } from "../config";
import { storeFragment } from "../cutter";
import { safeJson } from "../elevenlabs";
import { sourcePages } from "../jobs";
import type { Services } from "../services";
import { ApiError, FirstPage, json, router, SourceId } from "./common";
import { MAX_PREPARED_SECONDS, measureUpload } from "./transcription";

// [[first, last], …] inclusive, sorted, non-overlapping; touching ranges are joined, so the
// same pages are always the same text.
const Pages = z
  .array(z.tuple([z.int().min(0), z.int().min(0)]))
  .min(1)
  .refine(
    (pages) =>
      pages.every(
        ([first, last], i) => first <= last && first > (pages[i - 1]?.[1] ?? -1)
      ),
    "sorted, non-overlapping [first, last] ranges"
  )
  .transform(joinTouching);

// The phone's TimeMap: kept capture intervals in prepared order, epoch milliseconds.
const TimeMap = z
  .object({
    segments: z.array(z.tuple([z.number(), z.number()])).min(1),
    separatorMs: z.number().min(0),
  })
  .openapi("TimeMap");

const FragmentMetadata = z
  .object({
    audioSha256: Sha256,
    durationSeconds: z.number().positive().max(MAX_PREPARED_SECONDS),
    map: TimeMap,
    pages: Pages,
  })
  .openapi("FragmentMetadata");

const SourceParam = z.object({ sourceId: SourceId });

const PageList = z.array(z.tuple([z.int(), z.int()]));

export function speechRoutes({
  audio,
  db,
  worker,
}: Pick<Services, "audio" | "db" | "worker">) {
  const app = router();
  // Sent as a JSON string inside the multipart upload, so registered by hand.
  app.openAPIRegistry.register("FragmentMetadata", FragmentMetadata);
  return app
    .openapi(
      createRoute({
        description:
          "The pages the server holds of a source: every job's, any state, and every speech " +
          "fragment's in no job. The phone sends kept speech from every other page. `jobId` is " +
          "the job's or the fragment's id, read only by the phone build of Oct 15. `handedOver`: " +
          "whether the cutover happened; a reinstalled phone starts its cursor from this only then.",
        method: "get",
        path: "/sources/{sourceId}/blocks",
        request: { params: SourceParam },
        responses: {
          200: json(
            z
              .object({
                blocks: z.array(z.object({ jobId: z.uuid(), pages: PageList })),
                handedOver: z.boolean(),
              })
              .openapi("SourceBlocks"),
            "The source's pages"
          ),
        },
      }),
      (c) => c.json(sourcePages(db, c.req.valid("param").sourceId), 200)
    )
    .openapi(
      createRoute({
        description:
          "Upload one speech fragment: the kept speech of a run of whole Pendant pages the server " +
          "doesn't hold, as Ogg Opus, with its pages and map. The server checks the hash, the Ogg " +
          "duration (1 s tolerance) and that the map fits the audio, and keeps it in the bucket " +
          "until it closes the fragment's block itself (on its own clock, the phone's `sentThrough`, " +
          "or 2 minutes of speech). Idempotent: the same pages and audio answer the same fragment; " +
          "any 2xx means the pages are with the server. Refused with 409 `held`, nothing kept, when " +
          "a job or another fragment holds any of its pages: the phone reads " +
          "`GET /sources/{sourceId}/blocks` and renders again without them. When its block closes, " +
          "a fragment bought already (or from before the Mac's quiet ranges) is covered, its pages " +
          "held and nothing sent; one a quiet range touches is withdrawn, and the feed lists it as " +
          "a removed job with its first page: its pages are the phone's to send again.",
        method: "put",
        path: "/sources/{sourceId}/speech/{firstPage}",
        request: {
          body: {
            content: {
              "multipart/form-data": {
                schema: z.object({
                  audio: z
                    .instanceof(File)
                    .openapi({ format: "binary", type: "string" }),
                  metadata: z.string().openapi({
                    description: "JSON-encoded FragmentMetadata",
                  }),
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
          200: json(
            z
              .object({
                id: z.uuid(),
                jobId: z
                  .uuid()
                  .nullable()
                  .describe("The job its block became; null while open"),
                pages: PageList,
              })
              .openapi("SpeechFragment"),
            "The fragment, new or existing"
          ),
          400: json(
            ApiError,
            "Invalid metadata, audio hash mismatch, or audio that is not Ogg Opus of the declared duration or its map"
          ),
          409: json(
            ApiError,
            "Some of its pages are held already (held): nothing was kept"
          ),
          503: json(
            ApiError,
            "The audio could not be stored (audio_store_unavailable): nothing was kept"
          ),
        },
      }),
      async (c) => {
        const { firstPage, sourceId } = c.req.valid("param");
        const form = c.req.valid("form");
        const parsed = FragmentMetadata.safeParse(safeJson(form.metadata));
        if (parsed.data?.pages[0]?.[0] !== firstPage) {
          const message =
            parsed.error?.message ?? "pages must start at firstPage";
          return c.json({ error: "invalid_request" as const, message }, 400);
        }
        const { audioSha256, durationSeconds, map, pages } = parsed.data;
        const buffer = await form.audio.arrayBuffer();
        const measured = measureUpload(buffer, audioSha256, durationSeconds);
        if (typeof measured !== "number") {
          return c.json(measured, 400);
        }
        const bytes = new Uint8Array(buffer);
        // The cutter joins it with others later; one that can't join is refused now.
        if (!joinOggOpus([{ audio: bytes, map }])) {
          const message = "its map runs past its audio";
          return c.json({ error: "invalid_audio" as const, message }, 400);
        }
        const fragment = await storeFragment(
          db,
          audio,
          { audioSha256, map, pages, sourceId },
          bytes
        );
        if (fragment === "unavailable") {
          c.header("Retry-After", "30");
          const message = "the audio could not be stored; send it again later";
          return c.json(
            { error: "audio_store_unavailable" as const, message },
            503
          );
        }
        if (fragment === "held") {
          const message =
            "some of these pages are held already: render again without them (GET /sources/{sourceId}/blocks)";
          return c.json({ error: "held" as const, message }, 409);
        }
        worker.poke();
        const { id, jobId } = fragment;
        return c.json({ id, jobId, pages: fragment.pages }, 200);
      }
    );
}
