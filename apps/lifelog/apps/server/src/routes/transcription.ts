// Transcription: a job's transcript (readers read it), spending, the ElevenLabs webhook. Audio comes
// in as speech fragments (routes/speech.ts).
import { createRoute, z } from "@hono/zod-openapi";
import { transcripts } from "@lifelog/db/schema";
import { eq } from "drizzle-orm";
import { oggOpusSeconds } from "../audio";
import { sha256Hex } from "../config";
import { verifySignature } from "../elevenlabs";
import type { Services } from "../services";
import { usageSummary } from "../usage";
import { type ApiError, IdParam, json, notFound, router } from "./common";

export const MAX_PREPARED_SECONDS = 60 * 60; // the client sends ≤ ~30 min; leave headroom
// How far the declared duration may stray from the measured one (rounding, not billing).
const DURATION_TOLERANCE_SECONDS = 1;

const Transcript = z
  .object({
    jobId: z.uuid(),
    languageCode: z.string(),
    languageProbability: z.number(),
    parserVersion: z.int(),
    turns: z.array(
      z.object({
        end: z.number(),
        speakerId: z.string().nullable(),
        start: z.number(),
        text: z.string(),
      })
    ),
    words: z.array(
      z.object({
        end: z.number(),
        logprob: z.number().nullable(),
        spacing: z.string(),
        speakerId: z.string().nullable(),
        start: z.number(),
        text: z.string(),
      })
    ),
  })
  .openapi("Transcript");

const SpendPeriod = z
  .object({
    intelligence: z.object({
      byProvider: z.object({
        anthropic: z.number(),
        "claude-code": z
          .number()
          .describe("Always 0: the Mac runs on the Max plan."),
        codex: z
          .number()
          .describe("Always 0: the Mac runs on the ChatGPT plan."),
        openai: z.number(),
      }),
      unpricedRuns: z
        .int()
        .describe("Runs on a model with no known price: not in usd."),
      usd: z.number().describe("Estimated from tokens at list prices."),
    }),
    totalUsd: z.number(),
    transcription: z.object({
      hours: z
        .number()
        .describe("Billable hours at the base rate, keyterms included."),
      usd: z.number(),
    }),
  })
  .openapi("SpendPeriod");

const UsageSummary = z
  .object({
    days: z
      .array(SpendPeriod.extend({ date: z.iso.date() }))
      .describe("The last 30 local days, oldest first, today last."),
    elevenLabsThisMonth: z
      .object({ hours: z.number(), usd: z.number() })
      .nullable()
      .describe(
        "Speech-to-text ElevenLabs itself reports this month for the whole workspace " +
          "(every key and app). Null when it didn't answer."
      ),
    last30Days: SpendPeriod,
    monthStart: z.iso.datetime(),
    thisMonth: SpendPeriod,
    timeZone: z.string(),
    today: SpendPeriod,
  })
  .openapi("UsageSummary");

// The upload's measured duration, or why it is refused.
export function measureUpload(
  bytes: ArrayBuffer,
  audioSha256: string,
  declared: number
): number | z.infer<typeof ApiError> {
  if (sha256Hex(bytes) !== audioSha256) {
    return {
      error: "audio_hash_mismatch",
      message: "audio does not match audioSha256",
    };
  }
  const measured = oggOpusSeconds(new Uint8Array(bytes));
  if (measured === null) {
    return { error: "invalid_audio", message: "audio must be Ogg Opus" };
  }
  return Math.abs(measured - declared) > DURATION_TOLERANCE_SECONDS
    ? {
        error: "invalid_audio",
        message: `audio lasts ${measured} s, not the declared ${declared} s`,
      }
    : measured;
}

export function transcriptionRoutes({
  config,
  db,
  worker,
}: Pick<Services, "config" | "db" | "worker">) {
  return router()
    .openapi(
      createRoute({
        description:
          "A job's parsed transcript; a turn's index in `turns` is its `turnIndex`.",
        method: "get",
        path: "/transcription-jobs/{id}/transcript",
        request: { params: IdParam },
        responses: {
          200: json(Transcript, "Parsed transcript"),
          404: notFound,
        },
      }),
      (c) => {
        const row = db.query.transcripts
          .findFirst({
            where: eq(transcripts.jobId, c.req.valid("param").id),
          })
          .sync();
        return row
          ? c.json(
              {
                jobId: row.jobId,
                parserVersion: row.parserVersion,
                ...row.parsed,
              },
              200
            )
          : c.json(
              { error: "not_found" as const, message: "no transcript yet" },
              404
            );
      }
    )
    .openapi(
      createRoute({
        description:
          "What was spent, from our own ledgers at list prices: today, the last 30 days and " +
          "this month (days in the owner's time zone), split by service.",
        method: "get",
        path: "/usage/summary",
        responses: { 200: json(UsageSummary, "Spending by day and service") },
      }),
      async (c) => c.json(await usageSummary(db, config), 200)
    )
    .openapi(
      createRoute({
        description:
          "ElevenLabs transcription webhook. Verified with ElevenLabs-Signature over the raw body.",
        method: "post",
        path: "/webhooks/elevenlabs",
        responses: {
          200: json(z.object({ result: z.string() }), "Accepted or ignored"),
          401: json(z.object({ result: z.string() }), "Bad signature"),
        },
        security: [],
      }),
      async (c) => {
        const raw = await c.req.text();
        const signature = c.req.header("ElevenLabs-Signature");
        const secret = config.ELEVENLABS_WEBHOOK_SECRET;
        if (!(secret && verifySignature(signature, raw, secret))) {
          return c.json({ result: "bad_signature" }, 401);
        }
        const { result } = worker.webhook(raw);
        return c.json({ result }, 200);
      }
    );
}
