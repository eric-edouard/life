import { z } from "zod";
import { isoDateTime } from "./fields";

// His decisions (memory/decisions.jsonl, docs/SCHEMA.md): the questions his loops put to him and what he answered,
// one line per step, appended, never rewritten; a decision now is the fold of its lines (`decisionsNow`,
// apps/server/src/memory/decisions.ts). Written by his loops (the connector's `update_decision`) and by him (the page,
// /me/decisions). Life acts on one only to send the reply he chose (`host/send.ts`), when the loop that asked runs it.

/** The steps a loop takes (the connector's `update_decision`). */
export const LOOP_STEPS = [
  "asked",
  "revised",
  "taken",
  "done",
  "reopened",
  "withdrawn",
  "expired",
] as const;
/** The steps only he takes, on the page: an answer, opening the context, revoking a grant. */
const HIS_STEPS = ["answered", "context", "revoked"] as const;
/** What the page may write: his steps, and asking a request ("Something's wrong"). */
export const OWNER_STEPS = ["asked", ...HIS_STEPS] as const;
const DECISION_STEPS = [...LOOP_STEPS, ...HIS_STEPS] as const;
/** Where a decision stands; done, withdrawn and expired are closed (`closedAt`). */
export const STATUSES = [
  "open",
  "answered",
  "taken",
  "done",
  "withdrawn",
  "expired",
] as const;

const DecisionOption = z
  .object({
    consequence: z.string().max(200).optional(),
    draft: z.string().max(4000).optional(),
    id: z.string().min(1).max(40),
    label: z.string().min(1).max(200),
  })
  .strict();

/** What is asked (asked, revised): the question and its answers, as the page shows them; none makes it a request (an audit). */
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
    /** The asking loop's goal rank when it asked (his goals' order, lower first; 0 for the daily and asks): the page's order. */
    rank: z.number().int().min(0).max(99).optional(),
    ref: z.string().max(500).optional(),
  })
  .strict();
export type DecisionAsk = z.infer<typeof DecisionAsk>;

export const DecisionLine = z
  .object({
    at: isoDateTime,
    /** asked, revised: the ask; answered: answer and note; done: result (and scope, a grant's); reopened, withdrawn, expired: result. */
    data: z.record(z.string(), z.unknown()),
    decision: z.string().regex(/^[a-z0-9-]+-(\d{8}|\d{14,17})-\d+$/),
    /** The loop run that wrote it (life-loops' run id), none for his. */
    run: z.string().max(80).optional(),
    schemaVersion: z.literal(1),
    step: z.enum(DECISION_STEPS),
  })
  .strict();
export type DecisionLine = z.infer<typeof DecisionLine>;
