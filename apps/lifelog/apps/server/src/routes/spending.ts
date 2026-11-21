// What Voice spent, for Life's model spending (`spending.ts`).
import { createRoute, z } from "@hono/zod-openapi";
import { DAY } from "@life/server/src/core/clock";
import { intelligenceProviders, transcribers } from "@lifelog/db/schema";
import type { Services } from "../services";
import { spendingOf } from "../spending";
import { Instant } from "../timeline-spans";
import { json, router } from "./common";

const Spending = z
  .object({
    jobs: z.array(
      z.object({
        at: Instant,
        billableSeconds: z.number(),
        outcome: z.enum(["billed", "maybe_billed", "unsettled"]),
        seconds: z.number(),
        transcriber: z.enum(transcribers),
      })
    ),
    modelRuns: z.array(
      z.object({
        at: Instant,
        inputTokens: z.number(),
        latencyMs: z.number().nullable(),
        model: z.string(),
        outputTokens: z.number(),
        provider: z.enum(intelligenceProviders),
      })
    ),
    voiceNotes: z.array(
      z.object({
        at: Instant,
        billableSeconds: z.number().nullable(),
        route: z.string().nullable(),
        seconds: z.number().nullable(),
      })
    ),
  })
  .openapi("Spending");

export const spendingRoutes = ({ db }: Pick<Services, "db">) =>
  router().openapi(
    createRoute({
      description:
        "What Voice spent from `from` to `to` (at most 31 days): its transcription jobs by admission, settled or " +
        "not (`unsettled`: seconds still an estimate; `maybe_billed`: a send it may have been billed for), the chat " +
        "voice notes it heard, by their answer (no seconds: an answer lost, maybe billed), and its model runs on the " +
        "Mac, by start. A failed job that billed nothing is left out.",
      method: "get",
      path: "/spending",
      request: {
        query: z
          .object({ from: Instant, to: Instant })
          .refine((q) => Date.parse(q.to) - Date.parse(q.from) <= 31 * DAY, {
            message: "at most 31 days: page a longer read",
          }),
      },
      responses: { 200: json(Spending, "Spending") },
    }),
    (c) => {
      const { from, to } = c.req.valid("query");
      return c.json(spendingOf(db, new Date(from), new Date(to)), 200);
    }
  );
