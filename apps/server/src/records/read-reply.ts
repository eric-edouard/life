import { z } from "zod";
import { Appointment } from "./appointment";
import { isoDateTime, MadeBy, UnitId } from "./fields";

// A stored read reply (memory/read-replies/<YYYY-MM>.jsonl, the month of its first message, docs/SCHEMA.md): what a model answered when it read
// exchanges of a one-to-one chat, as given.

/** The three reads of exchanges (the moves reads); the shape of each one's moves is `MOVES` (`memory/moves.ts`). */
export const MOVE_READS = ["conflict", "connection", "mentions"] as const;
export type MoveRead = (typeof MOVE_READS)[number];

/** The read that summarises a conversation recorded in person (`memory/conversation-summaries.ts`). */
export const SUMMARY_READ = "conversation_summary" as const;
/** The read that names the voices of a conversation part recorded in person (`memory/voice-naming.ts`). */
export const VOICE_NAMING_READ = "voice_naming" as const;
/** The arrival reader's two reads (`memory/arrival-reader.ts`): Apple's on-device trigger, then his engine's confirm. */
export const ARRIVAL_TRIGGER_READ = "arrival_trigger" as const;
export const ARRIVAL_CONFIRM_READ = "arrival_confirm" as const;
/** The arrival reader's read of an appointment agreed in new lines (`memory/arrival-appointments.ts`). */
export const ARRIVAL_APPOINTMENT_READ = "arrival_appointment" as const;
/** Every read whose replies are stored. */
export type ReadName =
  | MoveRead
  | typeof SUMMARY_READ
  | typeof VOICE_NAMING_READ
  | typeof ARRIVAL_TRIGGER_READ
  | typeof ARRIVAL_CONFIRM_READ
  | typeof ARRIVAL_APPOINTMENT_READ;

/**
 * One call's reply, a line of the file: the reply as given, except a voice naming's, stored after `checkedVoices` (a moves read only needs its `exchanges` list,
 * the summary its `summary`, the voice naming its `voices`, the rest is checked when read), the key of every message the call showed in order
 * (`messages`: `eventKey`, or `turnKey` for speech, `unnamedTurnKey` for a voice no one named), where each item starts in them (`starts`: each exchange, or `[0]`
 * for a summary or a voice naming), the prompt's name in `madeBy.prompt` and the digest of its text (`promptDigest`). The person and the
 * moves are never stored.
 */
const stored = {
  at: isoDateTime,
  madeBy: MadeBy,
  messages: z.array(z.string().min(1)).min(1),
  promptDigest: z.string().regex(/^[0-9a-f]{16}$/),
  schemaVersion: z.literal(1),
  starts: z.array(z.int().min(0)).min(1),
};
export const MoveReply = z
  .object({
    ...stored,
    read: z.enum(MOVE_READS),
    reply: z.looseObject({ exchanges: z.array(z.unknown()) }),
  })
  .strict();
export const SummaryReply = z
  .object({
    ...stored,
    read: z.literal(SUMMARY_READ),
    reply: z.looseObject({ summary: z.string() }),
  })
  .strict();
/** One voice's guess in a voice naming reply: `voice` is a `V` token of the part's lines, `person` an offered ref, `me` or `unknown`, `lines` the ones that show it. */
export const NamedVoice = z.object({
  confidence: z.enum(["sure", "likely", "weak"]),
  lines: z.array(z.int().min(0)).min(1),
  person: z.string(),
  voice: z.string(),
});
export const VoiceNamingReply = z
  .object({
    ...stored,
    read: z.literal(VOICE_NAMING_READ),
    reply: z.looseObject({ voices: z.array(z.unknown()) }),
  })
  .strict();
/**
 * Apple's answer to the arrival trigger, as given, or why it gave none (`refused`): made on
 * this Mac, so its `madeBy` names the OS build (a macOS update changes the model). `unit` is the unit its lines are of.
 */
export const ArrivalTriggerReply = z
  .object({
    ...stored,
    madeBy: z
      .object({
        model: z.literal("apple-on-device"),
        os: z.string(),
        prompt: z.string(),
        run: z.string(),
      })
      .strict(),
    read: z.literal(ARRIVAL_TRIGGER_READ),
    reply: z.union([
      z
        .object({
          author: z.enum(["person", "automated"]),
          /** Whether the lines set a meeting or an appointment (trigger v3 on; v2's lines lack it). */
          event: z.enum(["yes", "no"]).optional(),
          quote: z.string(),
          /** Whether someone is about to be in the same place as him, today (trigger v4 on; earlier lines lack it). */
          together: z.enum(["yes", "no"]).optional(),
        })
        .strict(),
      z.object({ refused: z.string() }).strict(),
    ]),
    unit: UnitId,
  })
  .strict();
/** His engine's confirm: whether the lines hold something for him to act on, and who wrote them (refs as read, never him). */
export const ArrivalConfirmReply = z
  .object({
    ...stored,
    people: z.array(z.string()),
    read: z.literal(ARRIVAL_CONFIRM_READ),
    reply: z.looseObject({ isActionable: z.boolean() }),
    unit: UnitId,
  })
  .strict();
/**
 * His engine's read of whether new lines agree an appointment, stored after its check: agreed, with what goes in his
 * calendar (a meeting link copied exactly, https only; the people as the lines name them, never guests); or not, with
 * why the check refused the reply (`refused`), so it is not asked again.
 */
export const ArrivalAppointmentReply = z
  .object({
    ...stored,
    read: z.literal(ARRIVAL_APPOINTMENT_READ),
    reply: z.union([
      z
        .object({
          agreed: z.literal(true),
          allDay: Appointment.shape.allDay,
          end: Appointment.shape.end,
          link: z.url({ protocol: /^https$/ }).nullable(),
          people: z.array(z.string().min(1)).max(10),
          place: Appointment.shape.place,
          quote: z.string().min(1),
          start: Appointment.shape.start,
          title: z.string().min(1).max(80),
          zone: Appointment.shape.zone,
        })
        .strict(),
      z
        .object({ agreed: z.literal(false), refused: z.string().optional() })
        .strict(),
    ]),
    unit: UnitId,
  })
  .strict();
export const ReadReply = z.discriminatedUnion("read", [
  MoveReply,
  SummaryReply,
  VoiceNamingReply,
  ArrivalTriggerReply,
  ArrivalConfirmReply,
  ArrivalAppointmentReply,
]);
export type ReadReply = z.infer<typeof ReadReply>;
