// Dictation on the phone, by its device token only (no reader's token opens these): its quiet
// range opens before the microphone and closes at Stop (quiet-ranges.ts `openQuietRange`).
import { createRoute, z } from "@hono/zod-openapi";
import { record } from "../events";
import {
  closeQuietRange,
  DICTATION_CAP_MS,
  openQuietRange,
  openQuietRangeInput,
} from "../quiet-ranges";
import type { Services } from "../services";
import { ApiError, IdParam, json, router } from "./common";
import { QuietRange } from "./sync";

const OpenDictationRange = z
  .object({
    endsBy: z.iso
      .datetime()
      .describe(
        `Its cap, ${DICTATION_CAP_MS / 60_000} minutes after startedAt: the phone stops taking sound before it`
      ),
    id: z.uuid(),
    startedAt: z.iso.datetime().describe("The start as first opened"),
  })
  .openapi("OpenDictationRange");

export function dictationRoutes(s: Services) {
  const { db } = s;
  return router()
    .openapi(
      createRoute({
        description:
          "A dictation on the phone starts, before its microphone opens: from `startedAt` (less a " +
          "clock margin) no pendant audio is labeled, cut or sent until it closes, or until its cap " +
          "when the close never comes. Only this answer lets the phone open its microphone. " +
          "Idempotent by id: a retry answers the range as first opened; one already closed is " +
          "never opened again (409).",
        method: "post",
        path: "/dictation/ranges",
        request: {
          body: {
            content: {
              "application/json": {
                schema: openQuietRangeInput.openapi("DictationRangeInput"),
              },
            },
            required: true,
          },
        },
        responses: {
          200: json(OpenDictationRange, "The range, open"),
          400: json(
            ApiError,
            "Invalid, or `startedAt` more than a minute from the server's clock"
          ),
          409: json(ApiError, "This range was closed already"),
        },
      }),
      (c) => {
        const input = c.req.valid("json");
        const open = openQuietRange(db, input);
        if (open === "out of bounds") {
          return c.json(
            {
              error: "invalid_request" as const,
              message:
                "startedAt is more than a minute from the server's clock",
            },
            400
          );
        }
        if (open === "closed") {
          return c.json(
            {
              error: "invalid_state" as const,
              message: "This range was closed already.",
            },
            409
          );
        }
        record(db, "dictation.opened", { id: open.id, source: input.source });
        s.dictationChanged();
        return c.json(open, 200);
      }
    )
    .openapi(
      createRoute({
        description:
          "A dictation on the phone ends (Stop, cancel, an interruption, a failed start): its range, " +
          "widened by the clock margin at both edges and no longer than its cap, becomes a quiet " +
          "range, and the pendant's audio around it goes on. A close again keeps the first end.",
        method: "post",
        path: "/dictation/ranges/{id}/close",
        request: {
          body: {
            content: {
              "application/json": {
                schema: z.object({ endedAt: z.iso.datetime({ offset: true }) }),
              },
            },
            required: true,
          },
          params: IdParam,
        },
        responses: {
          200: json(QuietRange, "The quiet range, as stored"),
          404: json(ApiError, "No dictation opened with this id"),
        },
      }),
      (c) => {
        const { id } = c.req.valid("param");
        const range = closeQuietRange(
          db,
          id,
          new Date(c.req.valid("json").endedAt)
        );
        if (!range) {
          return c.json(
            {
              error: "not_found" as const,
              message: "No dictation opened with this id.",
            },
            404
          );
        }
        record(db, "dictation.closed", {
          id,
          seconds:
            (Date.parse(range.endedAt) - Date.parse(range.startedAt)) / 1000,
        });
        s.dictationChanged();
        return c.json(range, 200);
      }
    );
}
