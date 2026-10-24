// Backups of the phone's raw audio (rebuild P7; logic in backup.ts): the prepared Ogg of jobs
// already transcribed, the sealed packs, and the phone's source.sqlite. All are stored, none is
// ever admitted as a job or read back by a processor.
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  backfillAudio,
  backupOf,
  isKept,
  keepRaw,
  MAX_BACKUP_BYTES,
  type RawFile,
  rawPack,
  rawSnapshot,
} from "../backup";
import { Sha256, sha256Hex } from "../config";
import { getJob } from "../jobs";
import type { Services } from "../services";
import {
  ApiError,
  json,
  notFound,
  router,
  SourceId,
  Stored,
  sizeLimit,
} from "./common";
import { measureUpload } from "./transcription";

const Name = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const ShaHeader = z.object({ "x-content-sha256": Sha256 });
const body = {
  content: {
    "application/octet-stream": {
      schema: z.string().openapi({ format: "binary", type: "string" }),
    },
  },
  required: true,
};
const uploaded = {
  200: json(Stored, "Held; `stored` is false when it already was"),
  400: json(ApiError, "The body does not hash to X-Content-Sha256"),
  413: json(ApiError, "Over 64 MB"),
  503: json(ApiError, "The bucket is down (audio_store_unavailable)"),
};
const mismatch = {
  error: "audio_hash_mismatch" as const,
  message: "the body does not match X-Content-Sha256",
};
const unavailable = {
  error: "audio_store_unavailable" as const,
  message: "the bucket is down; send it again later",
};

export function backupRoutes({ audio, db }: Pick<Services, "audio" | "db">) {
  const app = router();
  return app
    .openapi(
      createRoute({
        description:
          "The prepared Ogg Opus of a completed job whose audio the bucket lacks, re-rendered by the " +
          "phone from its packs (the render is deterministic, so the hash matches). Refused with 409 " +
          "audio_hash_mismatch unless its sha256 is the job's audioSha256, and 400 invalid_audio unless " +
          "it lasts the job's duration (1 s tolerance). Stored under the job's key (`jobs/<sha256>.ogg`) and " +
          "recorded on the job; idempotent. Nothing is admitted, sent or billed. Also for imported " +
          "old-app recordings: their jobs exist with their sha.",
        method: "put",
        middleware: [sizeLimit(MAX_BACKUP_BYTES)] as const,
        path: "/jobs/{jobId}/audio",
        request: { body, params: z.object({ jobId: z.uuid() }) },
        responses: {
          200: json(
            z.object({ jobId: z.uuid(), objectKey: z.string() }),
            "The audio is in the bucket"
          ),
          400: json(ApiError, "Not Ogg Opus of the job's duration"),
          404: notFound,
          409: json(
            ApiError,
            "The hash is not the job's, or the job is not completed"
          ),
          413: json(ApiError, "Over 64 MB"),
          503: json(ApiError, "The bucket is down (audio_store_unavailable)"),
        },
      }),
      async (c) => {
        const { jobId } = c.req.valid("param");
        const job = getJob(db, jobId);
        if (!job) {
          return c.json(
            { error: "not_found" as const, message: "no such job" },
            404
          );
        }
        if (job.state !== "completed") {
          return c.json(
            {
              error: "invalid_state" as const,
              message: "only a completed job takes backfilled audio",
            },
            409
          );
        }
        const bytes = await c.req.arrayBuffer();
        const measured = measureUpload(
          bytes,
          job.audioSha256,
          job.preparedDurationSeconds
        );
        if (typeof measured !== "number") {
          return c.json(
            measured,
            measured.error === "audio_hash_mismatch" ? 409 : 400
          );
        }
        const objectKey = await backfillAudio(
          db,
          audio,
          job,
          new Uint8Array(bytes)
        );
        if (!objectKey) {
          c.header("Retry-After", "30");
          return c.json(unavailable, 503);
        }
        return c.json({ jobId, objectKey }, 200);
      }
    )
    .openapi(
      createRoute({
        description:
          "A sealed raw pack, content-addressed (`raw/<sourceId>/<name>-<sha256>.pack`), at most 64 MB, " +
          "with its hash in `X-Content-Sha256`. It holds everything the Pendant heard, dictation " +
          "included: stored, never processed. Idempotent: one already held answers `stored: false`.",
        method: "put",
        middleware: [sizeLimit(MAX_BACKUP_BYTES)] as const,
        path: "/backup/packs/{sourceId}/{name}",
        request: {
          body,
          headers: ShaHeader,
          params: z.object({ name: Name, sourceId: SourceId }),
        },
        responses: uploaded,
      }),
      (c) => {
        const { name, sourceId } = c.req.valid("param");
        const sha = c.req.valid("header")["x-content-sha256"];
        return keep(c, rawPack(sourceId, name, sha));
      }
    )
    .openapi(
      createRoute({
        description:
          "A snapshot of the phone's source.sqlite (the receipts that tell how to read the packs), at " +
          "most 64 MB, hash in `X-Content-Sha256`. One per UTC date is kept, the last 7 dates; " +
          "idempotent for the same bytes.",
        method: "put",
        middleware: [sizeLimit(MAX_BACKUP_BYTES)] as const,
        path: "/backup/source-db/{sourceId}",
        request: {
          body,
          headers: ShaHeader,
          params: z.object({ sourceId: SourceId }),
        },
        responses: uploaded,
      }),
      (c) => {
        const { sourceId } = c.req.valid("param");
        const sha = c.req.valid("header")["x-content-sha256"];
        return keep(c, rawSnapshot(sourceId, sha));
      }
    )
    .openapi(
      createRoute({
        description:
          "What the server holds of this source's raw backup: each pack's name, hash and size, and the " +
          "newest source.sqlite snapshot. The phone uploads only what is missing.",
        method: "get",
        path: "/backup/{sourceId}",
        request: { params: z.object({ sourceId: SourceId }) },
        responses: {
          200: json(
            z
              .object({
                latestSnapshot: z
                  .object({
                    bytes: z.int(),
                    date: z.string(),
                    sha256: Sha256,
                    uploadedAt: z.iso.datetime(),
                  })
                  .optional(),
                packs: z.array(
                  z.object({ bytes: z.int(), name: z.string(), sha256: Sha256 })
                ),
              })
              .openapi("BackupHeld"),
            "The source's held files"
          ),
        },
      }),
      (c) => c.json(backupOf(db, c.req.valid("param").sourceId), 200)
    );

  // Reads the body, checks it against the declared hash and keeps it; the answer for both uploads.
  async function keep(c: Context, file: RawFile) {
    if (isKept(db, file.key)) {
      return c.json({ stored: false }, 200);
    }
    const bytes = await c.req.arrayBuffer();
    if (bytes.byteLength === 0 || sha256Hex(bytes) !== file.sha256) {
      return c.json(mismatch, 400);
    }
    if (!(await keepRaw(db, audio, file, new Uint8Array(bytes)))) {
      c.header("Retry-After", "30");
      return c.json(unavailable, 503);
    }
    return c.json({ stored: true }, 200);
  }
}
