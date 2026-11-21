// A field's dictation on the phone: the owner's words, heard while he waits at the field, ahead of
// every other request (the speech service's interactive place, then Scribe's for Thai turns). Nothing
// is kept: no audio, no words, no row. A lost answer is said again (the phone shows "Not written.
// Please say it again."), never asked of Scribe twice.
import { randomUUID } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import { clock } from "@life/server/src/core/clock";
import { oggOpusSeconds } from "../audio";
import { record } from "../events";
import { hearOnTheMac, hearRouted, textFrom } from "../hear-routed";
import type { Services } from "../services";
import { blockKeyterms } from "../vocabulary";
import { ApiError, json, router, sizeLimit } from "./common";

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_SECONDS = 600;
// The owner waits at the field: a Scribe slot frees when any send ends, and dictation goes first.
const SLOT_WAIT_MS = 60_000;
const NOT_KEPT = { "Cache-Control": "no-store" };
const STATUS = {
  identity_busy: 503,
  invalid_audio: 400,
  transcription_failed: 502,
} as const;

type Said =
  | { text: string }
  | {
      error: "identity_busy" | "invalid_audio" | "transcription_failed";
      message: string;
    };

export function dictationRoutes({
  config,
  db,
  worker,
}: Pick<Services, "config" | "db" | "worker">) {
  async function hear(
    bytes: Uint8Array,
    { seconds, signal }: { seconds: number; signal: AbortSignal }
  ): Promise<Said> {
    const said = await hearOnTheMac({ config, db }, bytes, {
      at: clock(),
      priority: "interactive",
      signal,
    });
    if ("error" in said) {
      return said.error === "invalid_audio"
        ? { error: "invalid_audio", message: said.message }
        : {
            error: "identity_busy",
            message: "the speech service is busy or off",
          };
    }
    if (said.routed.length === 0) {
      record(db, "dictation.heard", { route: "local", seconds });
      return { text: said.text };
    }
    const heard = await hearRouted(
      { config, db },
      bytes,
      said.heard,
      said.routed,
      {
        keyterms: blockKeyterms(db),
        ref: { dictation: "field" },
        send: (post) =>
          worker.paidSend(
            `dictation:${randomUUID()}`,
            { priority: "interactive", signal, waitMs: SLOT_WAIT_MS },
            () => null,
            post
          ),
        settle: (outcome) => {
          if (outcome.kind === "heard") {
            record(db, "dictation.heard", {
              billableSeconds: outcome.billableSeconds,
              route: said.route,
              seconds,
            });
          }
        },
      }
    );
    if (heard.kind !== "heard") {
      return { error: "identity_busy", message: heard.error };
    }
    // Words missing are never filled in later: the owner says it again.
    return heard.error
      ? { error: "transcription_failed", message: "its Thai words are missing" }
      : { text: textFrom(heard.transcript) };
  }

  return router().openapi(
    createRoute({
      description:
        "A field's dictation from the phone (Ogg Opus, at most 10 minutes): its words, heard ahead of " +
        "all other work, by the speech service and Scribe for the turns it routes as Thai by where the " +
        "owner is now. Nothing is kept. 503 when the speech service or transcription is off or busy, " +
        "or the words need Scribe while its credits are out or no slot frees: nothing was billed. 502 " +
        "when Scribe failed to give the Thai words: the owner says it again. The device token only.",
      method: "post",
      middleware: [sizeLimit(MAX_BYTES)] as const,
      path: "/dictation/transcript",
      request: {
        body: {
          content: {
            "audio/ogg": {
              schema: z.string().openapi({ format: "binary", type: "string" }),
            },
          },
          required: true,
        },
      },
      responses: {
        200: json(
          z.object({ text: z.string() }).openapi("DictationWords"),
          "Its words; empty when nothing was heard"
        ),
        400: json(ApiError, "Not Ogg Opus, or longer than 10 minutes"),
        413: json(ApiError, "Over 16 MB"),
        502: json(ApiError, "Its Thai words are missing: say it again"),
        503: json(ApiError, "Not now, nothing billed: say it again"),
      },
    }),
    async (c) => {
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      const seconds = oggOpusSeconds(bytes);
      const said: Said =
        seconds === null || seconds > MAX_SECONDS
          ? {
              error: "invalid_audio",
              message: "audio must be Ogg Opus of at most 10 minutes",
            }
          : await hear(bytes, { seconds, signal: c.req.raw.signal });
      if ("text" in said) {
        return c.json({ text: said.text }, 200, NOT_KEPT);
      }
      return c.json(said, STATUS[said.error], NOT_KEPT);
    }
  );
}
