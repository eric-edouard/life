import { z } from "zod";
import { isoDateTime, MadeBy } from "./fields";

// The actions ledger (memory/ledger.jsonl, docs/SCHEMA.md): what Life did on his request, his changes read back,
// and the agent's tasks.

export const TASK_LINES = ["update", "reply", "nudge", "steer"] as const;

/** What `act` does to a reminder. undone: ticked back open; restore: a removed one back from Recently Deleted, into `list`. */
export const REMINDER_KINDS = [
  "add",
  "edit",
  "done",
  "remove",
  "undone",
  "restore",
] as const;

/**
 * One thing Life did outside itself on the owner's clear request (memory/ledger.jsonl): the only history of its
 * writes. `ref` is where his words are; `before` and `after` the reminder's fields; `target` what was touched. An ask
 * for the agent (`kind` ask, `target` `AGENT_WORD`) has `after` {agent, confidence, conversation?, turns?, title?, parent?}: it is a task (apps/server/src/memory/tasks.ts),
 * whose `TASK_LINES` have no `instruction` and its id as `target`: the agent's updates and replies; Life's nudges and his steers (until 20 Oct) only parse now.
 * A reply (`after` {text}) is what the agent told him; one on no task targets `chat`.
 */
export const LedgerEntry = z
  .object({
    after: z.record(z.string(), z.unknown()),
    at: isoDateTime,
    before: z.record(z.string(), z.unknown()).optional(),
    // Also "partial: <failed step>" on an add or edit that was done but lost a private field (result ok).
    error: z.string().optional(),
    id: z.string().regex(/^entry_[0-9a-f]{12}$/),
    instruction: z
      .object({ at: isoDateTime, quote: z.string(), ref: z.string() })
      .strict()
      .optional(),
    // "instinct": an email to Instinct, until 19 Oct. "grant": his words in a Claude session turning the standing grant
    // on or off (`after.on`), the latest one standing.
    kind: z.enum([
      ...REMINDER_KINDS,
      "ask",
      "grant",
      // A reminder Life links without a change: the first sync's baseline, or fields it learns (apps/server/src/host/inbound.ts).
      "import",
      "instinct",
      // His answered decision's reply, sent into its chat (apps/server/src/host/send.ts); `target` the decision.
      "sent",
      ...TASK_LINES,
    ]),
    // "intent": a write outside Life is about to make (`attempt`, act.ts), recorded before it (its outcome is a later line with the same id).
    result: z.enum(["ok", "failed", "duplicate", "intent"]),
    schemaVersion: z.literal(1),
    // "<prefix>:<id>" (an item of the actions backend: "reminder:<numericId>", "gtask:<list>/<task>"), "<prefix>:new" (a failed add), `AGENT_WORD` (an ask), a task's id (its lines), "chat" (a reply on no task) or "mailto:<address>" (Instinct, until 19 Oct).
    target: z.string(),
    // An ask heard in his speech: where the time went (spoke = instruction.at, recorded = at). `ended`: his last turn of
    // it ended; `arrived`: lifelog's feed had brought all of it. Until 19 Oct, a heard request's `heard`, `modelMs`, `actMs`.
    timing: z
      .object({
        actMs: z.int().optional(),
        arrived: isoDateTime,
        ended: isoDateTime.optional(),
        heard: isoDateTime.optional(),
        modelMs: z.int().optional(),
      })
      .strict()
      .optional(),
    // A model step (until 19 Oct, the hearing), or who passed his words on; "watch": the watcher (a "hey <agent>" heard; a nudge or a steer until 20 Oct);
    // "reminders": his own change read back from Reminders (apps/server/src/host/inbound.ts), state only, never his words.
    via: z.union([
      MadeBy,
      z.enum(["connector", "reminders", "session", "watch"]),
    ]),
    why: z.string(),
  })
  .strict();

export type LedgerEntry = z.infer<typeof LedgerEntry>;

export type Instruction = NonNullable<LedgerEntry["instruction"]>;

/** A task's own line (the agent's update, an old nudge or steer), not something done on his request: the one test. */
export const isTaskLine = (a: LedgerEntry) =>
  (TASK_LINES as readonly string[]).includes(a.kind);

/** A line that records no change of its own: a write's intent (its outcome follows), a reminder's baseline (apps/server/src/host/inbound.ts). */
export const isBookkeeping = (a: LedgerEntry) =>
  a.result === "intent" || a.kind === "import";

/** What the day's and the nightly's Actions list: neither a task's own line nor bookkeeping. */
export const isListed = (a: LedgerEntry) =>
  !(isTaskLine(a) || isBookkeeping(a));

/** A line whose outcome stands: done, or found already done. */
export const stands = (a: LedgerEntry) =>
  a.result === "ok" || a.result === "duplicate";
