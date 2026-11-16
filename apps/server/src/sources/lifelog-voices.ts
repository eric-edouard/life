import { z } from "zod";
import { DAY } from "../core/clock";
import { call, LIVE, type Store } from "./lifelog";

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
  const starts = Array.from(
    { length: Math.max(1, Math.ceil((to.getTime() - from.getTime()) / DAY)) },
    (_, i) => from.getTime() + i * DAY
  );
  const windows = await Promise.all(
    starts.map((at) => {
      const [start, end] = [at, Math.min(at + DAY, to.getTime())].map((t) =>
        encodeURIComponent(new Date(t).toISOString())
      );
      return call(`/speakers/voices?from=${start}&to=${end}`)
        .then((rows) => Voices.parse(rows))
        .catch((e: { status?: number }) => {
          throw e.status === 404
            ? new Error("voice naming needs the new Lifelog Host", { cause: e })
            : e;
        });
    })
  );
  return windows.flat();
}

/** Every turn someone other than the owner spoke in a live conversation since `since`, by lifelog's own speaker (never a model's): who and when. */
export function speakerTurns(store: Store, since: Date) {
  return store.db
    .query<
      {
        at: string;
        conversation: string;
        id: string;
        job: string;
        name: string | null;
      },
      [string]
    >(
      `select t.person_id as id, t.person_name as name, t.start_at as at, t.job_id as job, t.conversation_id as conversation from turns t
        join conversations c on c.id = t.conversation_id
        where ${LIVE} and t.person_id is not null and t.is_owner = 0 and t.start_at >= ?`
    )
    .all(since.toISOString());
}
