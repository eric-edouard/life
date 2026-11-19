import { z } from "zod";
import { DAY } from "../core/clock";
import { log } from "../core/log";
import {
  call,
  LIVE,
  lifelogMissing,
  parseTurnRef,
  type Store,
  writeLifelog,
} from "./lifelog";

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
 * What his own answer on a voice row is (`basis: owner`), the one place that says: a person, not relevant, "Not anyone I
 * know" (`unknown`), any other answer that names no one (`other`, media), or null when he did not answer it.
 */
export function ownAnswerOf(row?: VoiceRow) {
  if (row?.basis !== "owner") {
    return null;
  }
  if (row.status === "person" && row.personId) {
    return { kind: "person", personId: row.personId } as const;
  }
  if (row.status === "not_relevant" || row.status === "unknown") {
    return { kind: row.status } as const;
  }
  return { kind: "other" } as const;
}

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

/** The newest name lifelog gave each person id, from `speakerTurns`' rows. */
export function voiceNamesOf(
  rows: { at: string; id: string; name: string | null }[]
) {
  const newest = new Map<string, { at: string; name: string }>();
  for (const { at, id, name } of rows) {
    if (name && at >= (newest.get(id)?.at ?? "")) {
      newest.set(id, { at, name });
    }
  }
  return new Map([...newest].map(([id, { name }]) => [id, name]));
}

/** Whether lifelog now names the speaker of a turn (a turn ref): one he answered turn by turn has a name on the turn and no answer on its voice. */
export function isTurnNamed(store: Store, ref: string) {
  const t = parseTurnRef(ref);
  return Boolean(
    t &&
      store.db
        .query<{ n: number }, [string, number]>(
          "select count(*) as n from turns where job_id = ? and turn_index = ? and (person_id is not null or person_name is not null)"
        )
        .get(t.jobId, t.turnIndex)?.n
  );
}

/** One voice lifelog asks him to name, as `GET /naming-queue` gives it (`QueueItem`): what Life shows of it and sends back. */
export const NamingQueueItem = z.object({
  clips: z.array(
    z.object({
      at: z.string().nullable(),
      audio: z
        .object({ end: z.number(), jobId: z.string(), start: z.number() })
        .nullable(),
      text: z.string(),
      until: z.string().nullable(),
      /** Each word as lifelog times it: [start, end] in ms from the clip's start, and its length in `text` (with its spacing, but the first's). */
      words: z.array(z.tuple([z.number(), z.number(), z.number()])),
    })
  ),
  conversations: z.number(),
  evidence: z.array(
    z.object({
      at: z.string().nullable(),
      conversationId: z.string(),
      text: z.string(),
    })
  ),
  id: z.string(),
  kind: z.enum(["new_person", "known_person", "several"]),
  likely: z.array(z.string()),
  name: z.string().nullable(),
  personId: z.string().nullable(),
  voices: z.array(
    z.object({
      conversationId: z.string(),
      jobId: z.string(),
      speakerLabel: z.string(),
    })
  ),
  words: z.number(),
});
export type NamingQueueItem = z.infer<typeof NamingQueueItem>;

/** The last queue lifelog gave, and whether its last read failed. */
let lastQueue: NamingQueueItem[] = [];
let isDown = false;

/**
 * The voices lifelog asks him to name (`GET /naming-queue`); none when lifelog is not set up. While it fails the last
 * list stands, logged once, so the inbox never fails with it and a minute's look neither loses its voices nor logs.
 */
export async function readNamingQueue() {
  try {
    lastQueue = lifelogMissing()
      ? []
      : z.array(NamingQueueItem).parse(await call("/naming-queue", 30));
    isDown = false;
  } catch (e) {
    if (!isDown) {
      log("run.error", { error: (e as Error).message, step: "naming-queue" });
    }
    isDown = true;
  }
  return lastQueue;
}

const LEADING_SPACE = /^\s*/;

/**
 * A clip's words with their times in seconds of its job's audio (`audio.start` is the clip's start there), cut from its
 * text by the lengths lifelog gives. None for a clip with no audio to play.
 */
function clipWordsOf(clip: NamingQueueItem["clips"][number]) {
  const base = clip.audio?.start;
  const secondsOf = (ms: number) => Math.round((base ?? 0) * 1000 + ms) / 1000;
  let at = 0;
  return base === undefined
    ? []
    : clip.words.map(([start, end, length]) => {
        const piece = clip.text.slice(at, at + length);
        at += length;
        const spacing = LEADING_SPACE.exec(piece)?.[0] ?? "";
        return {
          end: secondsOf(end),
          spacing,
          start: secondsOf(start),
          text: piece.slice(spacing.length),
        };
      });
}

/** A clip as a check shows it: its words with their times (`clipWordsOf`) in place of lifelog's raw ones. */
export const withWords = (clip: NamingQueueItem["clips"][number]) => ({
  ...clip,
  words: clipWordsOf(clip),
});

/** The lifelog people a queue item's voice may be, its best guess first: the card offers them, his answer assigns to one. */
export const namingQueueGuessesOf = (item: NamingQueueItem) => [
  ...new Set([item.personId, ...item.likely].filter((x): x is string => !!x)),
];

/** The owner's answer to a queue item's voices (`POST /naming-queue/answer`): who they are, or that they are not worth naming. */
export const answerNamingQueue = (
  voices: { jobId: string; speakerLabel: string }[],
  answer:
    | { kind: "confirm"; name: string }
    | { kind: "assign"; personId: string }
    | { kind: "ignore" | "media" | "not_relevant" }
) => writeLifelog("POST", "/naming-queue/answer", { answer, voices });
