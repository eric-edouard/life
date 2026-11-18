// Conversations: one read (readers), the owner's titles, summaries.
import { createRoute, z } from "@hono/zod-openapi";
import type { Db } from "@lifelog/db";
import {
  conversations,
  intelligenceProviders,
  intelligenceStates,
  type JobMap,
} from "@lifelog/db/schema";
import { eq, sql } from "drizzle-orm";
import { latestRun, latestSummary, type Run } from "../runs";
import type { Services } from "../services";
import { setOwnerTitle } from "../titles";
import { Result } from "../voices-call";
import { IdParam, json, notFound, router } from "./common";

const EpochMs = z.int().nonnegative();
const ConversationPart = z
  .object({
    jobId: z.uuid(),
    segments: z.array(z.tuple([EpochMs, EpochMs])),
    separatorMs: z.int(),
    starts: z
      .array(z.number())
      .optional()
      .describe(
        "Where each segment begins in the job's audio (ms), when the server joined it from speech fragments; absent, each begins one separator after the one before"
      ),
  })
  .openapi("ConversationPart");

const EditedAt = z.iso
  .datetime()
  .optional()
  .describe(
    "When the owner made the edit, on the device that did; now when omitted. A time in the future counts as now. An edit older than the stored one is ignored."
  );

const IntelligenceRun = z
  .object({
    conversationId: z.uuid(),
    costUsd: z.number().nullable(),
    coverage: z
      .object({
        mode: z
          .enum(["whole", "windowed", "reused", "rolling"])
          .describe("rolling for every run since Oct 14; the others are older"),
        turnCount: z.int(),
        windows: z.array(z.tuple([z.int(), z.int()])),
      })
      .nullable(),
    createdAt: z.iso.datetime(),
    error: z.string().nullable(),
    id: z.uuid(),
    inputTokens: z.int(),
    latencyMs: z.int().nullable(),
    model: z.string(),
    outputTokens: z.int(),
    promptVersion: z.int(),
    provider: z.enum(intelligenceProviders),
    raw: z.array(
      z.object({
        inputTokens: z.int(),
        latencyMs: z.int(),
        model: z.string().optional(),
        outputTokens: z.int(),
        provider: z.enum(intelligenceProviders).optional(),
        reasoningEffort: z.string().nullable().optional(),
        stage: z.string(),
        text: z.string(),
        turns: z.tuple([z.int(), z.int()]).optional(),
      })
    ),
    reasoningEffort: z.string().nullable(),
    result: Result.nullable().openapi({
      description:
        "Turn ids index into turns. Kept even when invalid. Since prompt version 12 a run holds only " +
        "speakerIdentities: who each voice without a person is, from the turns read so far. Runs " +
        "of prompt version 11 and before also hold chapters, a title and a TLDR (written as tokens " +
        "like {S2}, with speakerTokens saying which voices each stands for) and boundarySuggestions; " +
        "they stay as stored and nothing writes them any more.",
    }),
    state: z.enum(intelligenceStates),
    turns: z.array(
      z.object({
        capturedAt: z.iso.datetime().nullable(),
        jobId: z.uuid(),
        turnIndex: z.int(),
      })
    ),
    updatedAt: z.iso.datetime(),
    validationErrors: z.array(z.string()),
  })
  .openapi("IntelligenceRun");

const Conversation = z
  .object({
    captureEndedAt: z.iso.datetime(),
    captureStartedAt: z.iso.datetime(),
    id: z.uuid(),
    latestRun: z.union([IntelligenceRun, z.null()]),
    ownerTitle: z.string().nullable(),
    ownerTitleAt: z.iso.datetime().nullable(),
    parts: z
      .array(ConversationPart)
      .describe(
        "The jobs whose turns start inside it, in order, with their time maps"
      ),
    title: z.string().nullable(),
    titleSource: z.enum(["owner", "generated", "none"]),
  })
  .openapi("Conversation");

const toRun = (r: Run): z.infer<typeof IntelligenceRun> => ({
  ...r,
  createdAt: r.createdAt.toISOString(),
  result: Result.nullable().catch(null).parse(r.result),
  updatedAt: r.updatedAt.toISOString(),
});

// The jobs whose turns start inside [from, to), by their first turn there, with their maps.
const jobsIn = (db: Db, from: Date, to: Date) =>
  db
    .all<{ jobId: string; map: string }>(sql`
      select j.id as "jobId", j.map from turns t
      join transcription_jobs j on j.id = t.job_id
      where t.start_at >= ${from.getTime()} and t.start_at < ${to.getTime()}
      group by j.id order by min(t.start_at)`)
    .map((j) => ({ jobId: j.jobId, map: JSON.parse(j.map) as JobMap }));

// The owner's title always wins; otherwise the latest valid generated one.
function conversationView(
  db: Db,
  c: typeof conversations.$inferSelect
): z.infer<typeof Conversation> {
  const latest = latestRun(db, c.id);
  const output = latestSummary(db, c.id)?.result;
  const jobs = jobsIn(db, c.captureStartedAt, c.captureEndedAt);
  const generated = output?.title?.text ?? null;
  let titleSource: "owner" | "generated" | "none" = "none";
  if (c.ownerTitle) {
    titleSource = "owner";
  } else if (generated) {
    titleSource = "generated";
  }
  return {
    captureEndedAt: c.captureEndedAt.toISOString(),
    captureStartedAt: c.captureStartedAt.toISOString(),
    id: c.id,
    latestRun: latest ? toRun(latest) : null,
    ownerTitle: c.ownerTitle,
    ownerTitleAt: c.ownerTitleAt?.toISOString() ?? null,
    parts: jobs.map((j) => ({ jobId: j.jobId, ...j.map })),
    title: c.ownerTitle ?? generated,
    titleSource,
  };
}

const findConversation = (db: Db, id: string) =>
  db.query.conversations.findFirst({ where: eq(conversations.id, id) }).sync();

const noConversation = {
  error: "not_found" as const,
  message: "no such conversation",
};

export function conversationRoutes({ db }: Pick<Services, "db">) {
  return router()
    .openapi(
      createRoute({
        description:
          "One conversation: its range, titles, latest run and jobs.",
        method: "get",
        path: "/conversations/{id}",
        request: { params: IdParam },
        responses: {
          200: json(Conversation, "The conversation and its title"),
          404: notFound,
        },
      }),
      (c) => {
        const row = findConversation(db, c.req.valid("param").id);
        return row
          ? c.json(conversationView(db, row), 200)
          : c.json(noConversation, 404);
      }
    )
    .openapi(
      createRoute({
        description:
          "Set (or clear, with null) the owner's title. It always wins over generated " +
          "titles and no regeneration overwrites it. Between edits, the latest by editedAt wins.",
        method: "put",
        path: "/conversations/{id}/title",
        request: {
          body: {
            content: {
              "application/json": {
                schema: z.object({
                  editedAt: EditedAt,
                  title: z.string().trim().min(1).max(200).nullable(),
                }),
              },
            },
            required: true,
          },
          params: IdParam,
        },
        responses: {
          200: json(Conversation, "The conversation, with the title that won"),
          404: notFound,
        },
      }),
      (c) => {
        const { editedAt, title } = c.req.valid("json");
        const row = setOwnerTitle(db, c.req.valid("param").id, title, editedAt);
        return row
          ? c.json(conversationView(db, row), 200)
          : c.json(noConversation, 404);
      }
    );
}
