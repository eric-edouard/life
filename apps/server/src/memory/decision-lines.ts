import { join } from "node:path";
import { z } from "zod";
import { isoDateTime } from "../records/fields";
import { Ask } from "./card-request";
import { StoredDraft } from "./draft";
import { MEMORY } from "./memory-files";
import { amountOf, type Need } from "./needs";

// The decisions' stored lines (`decisions.jsonl`, `decisions.ts` reads and writes them) and a decision as read: one
// `asked` line and the lines after it, each kind's shape here.

/** Where the decisions are stored: one line each, append-only. */
export const DECISIONS = join(MEMORY, "decisions.jsonl");

/** The version decision lines are written at; earlier lines (the old decisions page's, the cards before titles) are skipped. */
export const DECISIONS_VERSION = 3;
const DecisionId = z.string().regex(/^dec_[0-9a-f]{12}$/);
export const Asked = Ask.extend({
  asker: z.string().min(1),
  /** The desk's assignment that asked it (`askDecision`), which owns it when the desk's own row of it is missing; cards before it have none. */
  assignment: z.string().min(1).optional(),
  at: isoDateTime,
  /** The open card of another asker that held the draft's chat when this one was asked: this one waits on it (`contestOf`). */
  contests: DecisionId.optional(),
  /** The draft as Life stored it when asked (`resolveDraft`): `to` the chat's name, `chat` and the stamps; a card asked before Life could send has none, and sends nothing. */
  draft: StoredDraft.optional(),
  id: DecisionId,
  kind: z.literal("asked"),
  /** The matter it was asked on, as the ask resolved it: the finder's pick (`prefer`) among the matters its `subject` step rides on; cards before it, or off a matter, have none. */
  matter: z.string().min(1).optional(),
  schemaVersion: z.literal(DECISIONS_VERSION),
}).strict();
export const Answered = z
  .object({
    /** One tap's key, made by his app and kept on every repeat of that tap: a repeat finds this line and sends nothing. Lines before it have none. */
    answerKey: z.string().min(1).max(100).optional(),
    at: isoDateTime,
    id: DecisionId,
    kind: z.literal("answered"),
    note: z.string().min(1).optional(),
    /** The option ids he picked; none when he answered in words. */
    options: z.array(z.string()),
    schemaVersion: z.literal(DECISIONS_VERSION),
    /** His app through the connector, or a session's `bun life` command, which never sends. */
    via: z.enum(["connector", "session"]),
  })
  .strict();
export const Withdrawn = z
  .object({
    /** When he wrote in the draft's chat himself, Life withdrew it (`withdrawDraftsAnsweredInChat`): his message's instant, never its words. The asker's own withdrawal has none. */
    answeredInChatAt: isoDateTime.optional(),
    at: isoDateTime,
    id: DecisionId,
    kind: z.literal("withdrawn"),
    /** The card that took its place: the newer card his Send sent (Life's withdrawal), or, worked out, the holder's combined card (`merges`). */
    replacedBy: DecisionId.optional(),
    schemaVersion: z.literal(DECISIONS_VERSION),
    why: z.string().min(1),
  })
  .strict();
/** The holder's keep of its card against the waiting card `id` (`keepDraft`): `id` waits until the held card settles. */
export const Kept = Withdrawn.omit({
  answeredInChatAt: true,
  kind: true,
  replacedBy: true,
}).extend({ kind: z.literal("kept") });
/** What his answer sent: the sent message's id (Life's own event id where it knows it) once its network took it. */
export const Sent = z
  .object({
    at: isoDateTime,
    eventId: z.string().min(1),
    id: DecisionId,
    kind: z.literal("sent"),
    schemaVersion: z.literal(DECISIONS_VERSION),
  })
  .strict();
export const SendFailed = Sent.omit({ eventId: true, kind: true })
  .extend({
    /** False when the same draft can never go (the file is gone or changed, no chat, the channel is off): his next tap would fail alike. */
    canRetry: z.literal(false).optional(),
    error: z.string().min(1),
    kind: z.literal("send-failed"),
    /** The message that refused the send ("someone wrote since"): when, by whom, its words on one line. */
    wrote: z
      .object({ at: isoDateTime, by: z.string(), text: z.string() })
      .strict()
      .optional(),
  })
  .strict();
/** What his answer's `adds` option did (`addEventByHisWord`): the calendar event written (`eventId`), or `error` when it failed or never finished. Written once, never retried. */
export const Added = z
  .object({
    at: isoDateTime,
    error: z.string().min(1).optional(),
    eventId: z.string().min(1).optional(),
    id: DecisionId,
    kind: z.literal("added"),
    schemaVersion: z.literal(DECISIONS_VERSION),
  })
  .strict();
/** What his answer's `runs` option started (`runApifyByHisWord`): the Apify run (`runId`), or `error` when it failed or never finished. Written once, never retried. */
export const Ran = z
  .object({
    at: isoDateTime,
    error: z.string().min(1).optional(),
    id: DecisionId,
    kind: z.literal("ran"),
    runId: z.string().min(1).optional(),
    schemaVersion: z.literal(DECISIONS_VERSION),
  })
  .strict();
/** What his answer's `ends` option closed (`endByHisWord`): `error` when it failed, or never finished. */
export const Ended = z
  .object({
    at: isoDateTime,
    error: z.string().min(1).optional(),
    id: DecisionId,
    kind: z.literal("ended"),
    schemaVersion: z.literal(DECISIONS_VERSION),
  })
  .strict();
/** Life's outcome when it looked for the card's step done (`recordDoneSeen`): `seen` (the event, `eventId`), or `not_found` (with `error` when the look failed or never finished). Never his answer. */
export const DoneSeen = z
  .object({
    at: isoDateTime,
    error: z.string().min(1).optional(),
    eventId: z.string().min(1).optional(),
    id: DecisionId,
    kind: z.literal("done-seen"),
    schemaVersion: z.literal(DECISIONS_VERSION),
    state: z.enum(["seen", "not_found"]),
  })
  .strict();
export const Line = z.discriminatedUnion("kind", [
  Asked,
  Answered,
  Withdrawn,
  Kept,
  Sent,
  SendFailed,
  Ended,
  Added,
  Ran,
  DoneSeen,
]);
/** A line of an earlier version: skipped. */
const Historical = z.object({ schemaVersion: z.literal([1, 2]) }).loose();
export const Stored = z.union([Line, Historical]);

export type Asked = z.infer<typeof Asked>;
export type Answered = z.infer<typeof Answered>;
export type Withdrawn = z.infer<typeof Withdrawn>;
/** A withdrawal of card `id` at `now`, and why (`more`: who answered in its chat, the card that replaced it). */
export const withdrawnOf = (
  id: string,
  now: Date,
  why: string,
  more: Pick<Withdrawn, "answeredInChatAt" | "replacedBy"> = {}
): Withdrawn => ({
  ...more,
  at: now.toISOString(),
  id,
  kind: "withdrawn",
  schemaVersion: DECISIONS_VERSION,
  why,
});
export type SendFailed = z.infer<typeof SendFailed>;
type Send = z.infer<typeof Sent> | SendFailed;
export type Ended = z.infer<typeof Ended>;
export type Added = z.infer<typeof Added>;
export type Ran = z.infer<typeof Ran>;
export type DoneSeen = z.infer<typeof DoneSeen>;

export type DecisionState =
  | "answered"
  | "lapsed"
  | "open"
  | "seen"
  | "waiting"
  | "withdrawn";
export type Decision = Asked & {
  /** His answer's `adds` outcome (`added`). */
  added?: Added;
  answer?: Answered;
  /** Life's newest look: the one his answer's look made, a `seen` that settled the card, or a `not_found` that voided his answer (the card is open again). */
  doneSeen?: DoneSeen;
  end?: Ended;
  /** The holder's keep, while this card waits on its card. */
  kept?: z.infer<typeof Kept>;
  /** His answer's `runs` outcome (`ran`). */
  ran?: Ran;
  /** The newest `not sent:` outcome, which voided the answer in `voided` (the card is open again). */
  notSent?: SendFailed;
  /** The older card this one replaces, once asked after `CONTEST_WAIT` while that one is still open: his Send withdraws it. */
  replaces?: string;
  send?: Send;
  state: DecisionState;
  /** Every answer a `not sent:` or `not_found` outcome voided, with that outcome, oldest first: a repeat of any of those taps (its `answerKey`) finds its own here. */
  voided?: { answer: Answered; doneSeen?: DoneSeen; notSent?: SendFailed }[];
  withdrawn?: Withdrawn;
};

/** Life's outcome as his card and app show it: its state and Life's words for it; when seen, `paid` (the card's amount, which the look matched exactly, and `seenAt`, when Life saw it); null when Life looked for nothing. */
export function doneSeenShownOf(l?: DoneSeen, needs?: readonly Need[]) {
  if (!l) {
    return null;
  }
  const notFound = l.error
    ? `Life could not look in your accounts: ${l.error}`
    : "Not in your accounts yet";
  const amount = l.state === "seen" ? amountOf(needs) : undefined;
  return {
    line: l.state === "seen" ? "Paid: Life saw it in your accounts" : notFound,
    ...(amount && {
      paid: { currency: amount.currency, seenAt: l.at, value: amount.value },
    }),
    state: l.state,
  };
}
