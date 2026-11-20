// Dictation on the phone, by its device token only (no reader's token opens these): its quiet
// range opens before the microphone and closes at Stop (phone-dictations.ts).
import { createRoute, z } from "@hono/zod-openapi";
import { record } from "../events";
import {
  closePhoneDictation,
  DICTATION_CAP_MS,
  openPhoneDictation,
  phoneDictationInput,
} from "../phone-dictations";
import type { Services } from "../services";
import { ApiError, IdParam, json, router } from "./common";
import { QuietRange } from "./sync";

const OpenDictationRange = z
  .object({
    endsBy: z.iso
      .datetime()
      .describe(
        `Its cap, ${DICTATION_CAP_MS / 60_000} minutes after startedAt: the phone stops taking sound before it, by its own monotonic clock from the tap`
      ),
    id: z.uuid(),
    startedAt: z.iso
      .datetime()
      .describe("When the server first opened it, by the server's clock"),
  })
  .openapi("OpenDictationRange");

export function dictationRoutes(s: Services) {
  const { db } = s;
  return router()
    .openapi(
      createRoute({
        description:
          "A dictation on the phone starts, before its microphone opens: from when the server opens " +
          "it (less a clock margin) no pendant audio is labeled, cut or sent until it closes, or " +
          "until its cap when the close never comes. Only this answer lets the phone open its " +
          "microphone. Idempotent by id, however late: a retry answers the range as first opened; " +
          "one already closed, or past its cap, is never opened again (409). A new open whose `startedAt` is more " +
          "than a minute from the server's clock is stale (400).",
        method: "post",
        path: "/dictation/ranges",
        request: {
          body: {
            content: {
              "application/json": {
                schema: phoneDictationInput.openapi("DictationRangeInput"),
              },
            },
            required: true,
          },
        },
        responses: {
          200: json(OpenDictationRange, "The range, open"),
          400: json(
            ApiError,
            "Invalid, or a new open whose `startedAt` is more than a minute from the server's clock"
          ),
          409: json(ApiError, "This range was closed already"),
        },
      }),
      (c) => {
        const input = c.req.valid("json");
        const open = openPhoneDictation(db, input);
        if (open === "stale") {
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
          // One past its cap ended just now.
          s.dictationChanged();
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
          "A dictation on the phone ends (Stop, cancel, an interruption, a failed start), sent once " +
          "its microphone stopped: its range ends when this arrives, by the server's clock, widened " +
          "by the clock margin at both edges and no longer than its cap. It becomes a quiet range, " +
          "and the pendant's audio around it goes on. A close again keeps the first end.",
        method: "post",
        path: "/dictation/ranges/{id}/close",
        request: { params: IdParam },
        responses: {
          200: json(QuietRange, "The quiet range, as stored"),
          404: json(ApiError, "No dictation opened with this id"),
        },
      }),
      (c) => {
        const { id } = c.req.valid("param");
        const range = closePhoneDictation(db, id);
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
