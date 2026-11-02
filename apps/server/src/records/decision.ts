import { z } from "zod";
import { isoDateTime } from "./fields";

// His decisions (memory/decisions.jsonl, docs/SCHEMA.md): Life's fact checks and what he answered, one line per step,
// appended, never rewritten; a decision now is the fold of its lines (`decisionsNow`, apps/server/src/memory/decisions.ts).
// Written by Life (`memory/fact-checks.ts`) and by him (the web app's /decisions). Older lines from his loops (until
// 2 Nov 2026) still parse, and fold to nothing.

/** Every step a line may hold. Only asked, answered, done and expired are written now; the rest are the loops' old lines. */
const DECISION_STEPS = [
  "asked",
  "answered",
  "done",
  "expired",
  "revised",
  "taken",
  "reopened",
  "withdrawn",
  "context",
  "revoked",
] as const;
/** Where a decision stands; done and expired are closed (`closedAt`). */
type Status = "open" | "answered" | "done" | "expired";

/** What is asked: the question and its answers, as the page shows them. */
export const DecisionAsk = z
  .object({
    context: z.string().max(4000).optional(),
    deadline: isoDateTime.optional(),
    loop: z.string().regex(/^[a-z0-9-]+$/),
    onNoAnswer: z.string().max(200).optional(),
    options: z
      .array(
        z
          .object({
            id: z.string().min(1).max(40),
            label: z.string().min(1).max(200),
          })
          .strict()
      )
      .min(1)
      .max(4),
    question: z.string().min(1).max(200),
    ref: z.string().max(500).optional(),
  })
  .strict();
export type DecisionAsk = z.infer<typeof DecisionAsk>;

export const DecisionLine = z
  .object({
    /** The loop agent that wrote an old line. */
    agent: z.string().min(1).optional(),
    at: isoDateTime,
    /** asked: the ask; answered: answer and note; done, expired: result. */
    data: z.record(z.string(), z.unknown()),
    decision: z.string().regex(/^[a-z0-9-]+-(\d{8}|\d{14,17})-\d+$/),
    /** The loop run that wrote an old line. */
    run: z.string().max(80).optional(),
    schemaVersion: z.literal(1),
    step: z.enum(DECISION_STEPS),
  })
  .strict();
export type DecisionLine = z.infer<typeof DecisionLine>;

/** A decision as it stands: the fold of its lines (`decisionsNow`). */
export interface Decision extends DecisionAsk {
  answer?: string | null;
  answeredAt?: string;
  closedAt?: string;
  createdAt: string;
  id: string;
  note?: string;
  result?: string;
  status: Status;
}

/** His answer as the fold reads it, from any page that ever wrote one: an option's id, `note` for his words alone, or null. */
export const AnsweredLine = z.object({
  answer: z.string().nullish(),
  note: z.string().optional(),
});

/** What the web app may write: his answer, with its limits. */
export const OwnerStep = z
  .object({
    data: AnsweredLine.extend({
      answer: z.string().max(40).nullable(),
      note: z.string().max(4000),
    }).strict(),
    decision: z.string(),
    step: z.literal("answered"),
  })
  .strict();
export type OwnerStep = z.infer<typeof OwnerStep>;
