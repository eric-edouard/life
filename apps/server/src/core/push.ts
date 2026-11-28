import { z } from "zod";

// What a push to his phone may say, the one schema Life and its voice server share: ids only (a card's or an
// appointment's push id, a kind, a level), never words, a ref, a name or a count. The words an alert shows are fixed per
// kind where it is sent (`apns-request.ts`, the voice server), and the phone writes the card's own text itself, from the
// connector.

/** A push id as it travels: 16 hex of an HMAC of a card's or an appointment's ref, under a key that never leaves the Mac. */
export const PUSH_ID = /^[0-9a-f]{16}$/;

/** How a push interrupts him: Apple's `interruption-level` (passive: Notification Center only, no sound). */
export const PushLevel = z.enum(["passive", "active", "time-sensitive"]);

export type PushLevel = z.infer<typeof PushLevel>;

const pushId = z.string().regex(PUSH_ID);

/** The alert kinds that name a card, an appointment or a spoken ask; `voice.waiting` alone names nothing. */
type AlertKind =
  | "calendar.added"
  | "card.new"
  | "thread.answered"
  | "thread.failed"
  | "thread.heard";

/** An alert that names what it is about: the phone reads that from the connector and writes the notification's words. */
const alertOf = <Kind extends AlertKind>(kind: Kind) =>
  z
    .object({
      kind: z.literal(kind),
      level: PushLevel.optional(),
      pushId,
    })
    .strict();

export const Push = z.discriminatedUnion("kind", [
  alertOf("card.new"),
  alertOf("calendar.added"),
  alertOf("thread.heard"),
  alertOf("thread.answered"),
  alertOf("thread.failed"),
  // An alert about nothing to name: the Pendant's audio waits for the app.
  z.object({ kind: z.literal("voice.waiting") }).strict(),
  // Background: the app reads its inbox at once (its badge follows from what it reads), or collects what is ready. Apple
  // holds a 4 KB payload, hence the cap on what one removal carries.
  z
    .object({
      kind: z.literal("cards.removed"),
      removed: z.array(pushId).min(1).max(100),
    })
    .strict(),
  z.object({ kind: z.literal("voice.ready") }).strict(),
]);

export type Push = z.infer<typeof Push>;
