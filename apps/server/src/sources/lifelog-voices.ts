import { z } from "zod";
import { DAY } from "../core/clock";
import { call } from "./lifelog";

// What lifelog says of the voices of its recordings: how a conversation's voices were heard (`readVoiceKinds`) and who
// answered or recognised each (`readVoices`). Read-only.

export const ConversationAnswer = z.object({
  latestRun: z
    .object({
      result: z
        .object({
          speakerIdentities: z
            .array(
              z.object({
                jobId: z.string(),
                kind: z.enum(["live", "phone", "media", "announcement"]),
                speakerLabel: z.string(),
                withOwner: z.boolean(),
              })
            )
            .optional(),
        })
        .nullable(),
    })
    .nullable(),
});
export interface VoiceKind {
  kind: string;
  withOwner: boolean;
}

/**
 * What lifelog's latest summary of a conversation heard of each voice it could not name, by `voiceKey`: how it was heard
 * (live in the room, over a phone, from a screen, an announcement) and whether it talked with him. None for a conversation
 * lifelog no longer has. Read-only.
 */
export async function readVoiceKinds(conversationId: string) {
  const answer = await call(
    `/conversations/${encodeURIComponent(conversationId)}`
  ).catch((e: { status?: number }) => {
    if (e.status === 404) {
      return { latestRun: null };
    }
    throw e;
  });
  return new Map<string, VoiceKind>(
    (
      ConversationAnswer.parse(answer).latestRun?.result?.speakerIdentities ??
      []
    ).map((s) => [
      voiceKey(s.jobId, s.speakerLabel),
      { kind: s.kind, withOwner: s.withOwner },
    ])
  );
}
/** A recording's voice: its job and the transcript's speaker label. */
export const voiceKey = (jobId: string, label: string | null) =>
  `${jobId} ${label}`;


/** One voice of a recording, as `GET /speakers/voices` gives it: who named it (`basis`: his answer, lifelog's sound, nobody), who, and whom it sounds like. */
export const Voices = z.array(
  z.object({
    basis: z.string().nullable(),
    jobId: z.string(),
    likeness: z.array(z.object({ personId: z.string(), score: z.number() })),
    mixed: z.boolean(),
    personId: z.string().nullable(),
    speakerLabel: z.string(),
    status: z.string().nullable(),
  })
);
export type VoiceRow = z.infer<typeof Voices>[number];

/**
 * Every voice of the recordings with a turn starting in [from, to), in windows of the 24 hours lifelog answers at most.
 * An older Lifelog Host has no such route (404): that throws.
 */
export async function readVoices(from: Date, to: Date) {
  const rows: VoiceRow[] = [];
  for (let at = from.getTime(); at < to.getTime(); at += DAY) {
    const [start, end] = [
      new Date(at).toISOString(),
      new Date(Math.min(at + DAY, to.getTime())).toISOString(),
    ];
    try {
      rows.push(
        // biome-ignore lint/performance/noAwaitInLoops: a span is a few windows
        ...Voices.parse(
          await call(
            `/speakers/voices?from=${encodeURIComponent(start)}&to=${encodeURIComponent(end)}`
          )
        )
      );
    } catch (e) {
      if ((e as { status?: number }).status === 404) {
        throw new Error("voice naming needs the new Lifelog Host");
      }
      throw e;
    }
  }
  return rows;
}
