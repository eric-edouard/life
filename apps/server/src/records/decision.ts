import { z } from "zod";
import { isoDateTime } from "./fields";

// His decisions (memory/decisions.jsonl, docs/SCHEMA.md): the questions his loops put to him and what he answered,
// one line per step, appended, never rewritten; a decision now is the fold of its lines (`decisionsNow`,
// apps/server/src/memory/decisions.ts). Written by his loops (the connector's `update_decision`) and by him (the page,
// /me/decisions). Life never acts on one: the loop that asked does, on its next run.

/** A step of a decision: a loop's (asked, revised, taken, done, reopened, withdrawn, expired) or his (answered, wrong, context, revoked). */
export const DECISION_STEPS = [
  "asked",
  "revised",
  "taken",
  "done",
  "reopened",
  "withdrawn",
  "expired",
  "answered",
  "context",
  "revoked",
] as const;
/** The steps a loop takes (the connector's `update_decision`); the rest are his, on the page. */
export const LOOP_STEPS = [
  "asked",
  "revised",
  "taken",
  "done",
  "reopened",
  "withdrawn",
  "expired",
] as const;

export const DecisionOption = z
  .object({
    consequence: z.string().max(200).optional(),
    draft: z.string().max(4000).optional(),
    id: z.string().min(1).max(40),
    label: z.string().min(1).max(60),
  })
  .strict();

/** What a loop asks (asked, revised): the question and its answers, as the page shows them. */
export const DecisionAsk = z
  .object({
    context: z.string().max(4000).optional(),
    deadline: isoDateTime.optional(),
    draft: z.string().max(4000).optional(),
    kind: z.enum(["grant", "change", "audit"]).optional(),
    lang: z.enum(["en", "fr"]).optional(),
    loop: z.string().regex(/^[a-z0-9-]+$/),
    onNoAnswer: z.string().max(200).optional(),
    options: z.array(DecisionOption).max(4),
    pick: z.string().max(40).optional(),
    question: z.string().min(1).max(200),
    ref: z.string().max(500).optional(),
  })
  .strict();
export type DecisionAsk = z.infer<typeof DecisionAsk>;

export const DecisionLine = z
  .object({
    at: isoDateTime,
    /** asked, revised: the ask; answered: answer and note; done: result (and scope, a grant's); reopened, withdrawn, expired: result. */
    data: z.record(z.string(), z.unknown()),
    decision: z.string().regex(/^[a-z0-9-]+-\d{14,17}-\d+$/),
    /** The run that wrote it (a loop's), none for his. */
    run: z.string().max(80).optional(),
    schemaVersion: z.literal(1),
    step: z.enum(DECISION_STEPS),
  })
  .strict();
export type DecisionLine = z.infer<typeof DecisionLine>;
