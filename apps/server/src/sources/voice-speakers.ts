import { z } from "zod";
import { DAY } from "../core/clock";
import { log } from "../core/log";
import { errorOf } from "../core/log-line";
import {
  LIVE,
  parseTurnRef,
  type Store,
  withStore,
  writeVoiceServer,
} from "./voice-server";
import { call, voiceServerMissing } from "./voice-server-call";

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

/**
 * The newest name lifelog gave each of these person ids (`ids`), and each id it gave any of these names (`named`, any
 * case), with its newest name: who an id is when Life's directory does not know it (`voicePersonOf`). Indexed reads
 * (`turns_person`, `turns_person_name`), one per id and name; none without ids or names.
 */
export async function readVoiceNames(
  ids: readonly string[],
  named: readonly string[] = []
): Promise<Record<string, string>> {
  if (ids.length === 0 && named.length === 0) {
    return {};
  }
  return await withStore((store) => {
    const newest = store.db.query<{ name: string }, [string]>(
      "select person_name as name from turns where person_id = ? and person_name is not null order by start_at desc limit 1"
    );
    const idsNamed = store.db.query<{ id: string }, [string]>(
      "select distinct person_id as id from turns where person_name = ? collate nocase and person_id is not null"
    );
    const all = new Set([
      ...ids,
      ...named.flatMap((n) => idsNamed.all(n).map((r) => r.id)),
    ]);
    return Object.fromEntries(
      [...all].flatMap((id) => {
        const name = newest.get(id)?.name;
        return name ? [[id, name]] : [];
      })
    );
  });
}

/** The person id lifelog gives the owner (the newest of its owner's turns), none before it has heard him. */
export async function readOwnerVoiceId(): Promise<string | undefined> {
  return await withStore(
    (store) =>
      store.db
        .query<{ id: string }, []>(
          "select person_id as id from turns where is_owner = 1 and person_id is not null order by start_at desc limit 1"
        )
        .get()?.id
  );
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

/** A clip of a recording: where it is in the job's audio (`audio`), when, its words and their timings (`TimedWords`: each word's [start, end] in ms from the clip's start and its length in `text`, with the spacing before it). */
export const Clip = z.object({
  at: z.string().nullable(),
  audio: z
    .object({ end: z.number(), jobId: z.string(), start: z.number() })
    .nullable(),
  text: z.string(),
  until: z.string().nullable(),
  words: z.array(z.array(z.number())),
});

/** The clip of one turn of a recording, as lifelog cuts it for its cards (`GET /turns/clip`); null once lifelog has no such turn. */
export const readTurnClip = (jobId: string, turnIndex: number) =>
  call(
    `/turns/clip?jobId=${encodeURIComponent(jobId)}&turnIndex=${turnIndex}`
  ).then(
    (clip) => Clip.parse(clip),
    (e: { status?: number }) => {
      if (e.status === 404) {
        return null;
      }
      throw e;
    }
  );

/** One voice lifelog asks him to name, as `GET /naming-queue` gives it (`QueueItem`): what Life shows of it and sends back. */
export const NamingQueueItem = z.object({
  clips: z.array(Clip),
  conversations: z.number(),
  evidence: z.array(
    z.object({
      at: z.string().nullable(),
      conversationId: z.string(),
      text: z.string(),
    })
  ),
  id: z.string(),
  isLikely: z.boolean(),
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

/** The last queue lifelog gave (none until a read succeeded), the read in flight, the answers sent, and whether reads fail. */
let kept: NamingQueueItem[] | undefined;
let reading: Promise<NamingQueueItem[]> | undefined;
let answered = 0;
let isDown = false;

/**
 * The queue as lifelog gives it now (`GET /naming-queue`), nothing kept: for an answer, which reads it in its turn
 * (`answerCheck`), never the kept list; throws when lifelog cannot be read.
 */
export const readNamingQueueNow = async () =>
  voiceServerMissing()
    ? []
    : z.array(NamingQueueItem).parse(await call("/naming-queue", 30));

/**
 * The one writer of the kept queue: one read at a time, kept unless an answer was sent since it started (its list may
 * hold the answered voice); a failure is logged once while lifelog stays down, and the next read tries again.
 */
function refresh() {
  const since = answered;
  reading ??= readNamingQueueNow()
    .then((queue) => {
      if (since === answered) {
        kept = queue;
      }
      isDown = false;
      return queue;
    })
    .catch((e: Error) => {
      if (!isDown) {
        log("run.error", { ...errorOf(e), step: "naming-queue" });
      }
      isDown = true;
      throw e;
    })
    .finally(() => {
      reading = undefined;
    });
  return reading;
}

/**
 * The voices lifelog asks him to name (`GET /naming-queue`), for the inbox: the last list read, at once, with a read
 * started behind it (lifelog can take seconds to rebuild it), so a changed queue shows on the next read; the first read
 * waits. While lifelog fails the last list stands (none before any), so the inbox never fails or waits on it.
 */
export async function readNamingQueue() {
  const next = refresh().catch(() => kept ?? []);
  return kept ?? (await next);
}

/** The lifelog people a queue item's voice may be, its best guess first: the card offers them, his answer assigns to one. */
export const namingQueueGuessesOf = (item: NamingQueueItem) => [
  ...new Set([item.personId, ...item.likely].filter((x): x is string => !!x)),
];

/** The owner's answer to a queue item's voices (`POST /naming-queue/answer`): who they are, or that they are not worth naming. */
export async function answerNamingQueue(
  voices: { jobId: string; speakerLabel: string }[],
  answer:
    | { kind: "confirm"; name: string }
    | { kind: "assign"; personId: string }
    | { kind: "ignore" | "media" | "not_relevant" }
) {
  const done = await writeVoiceServer("POST", "/naming-queue/answer", {
    answer,
    voices,
  });
  // His answered voice leaves the kept list now, and no read started before it can put it back.
  answered += 1;
  const sent = new Set(voices.map((v) => voiceKey(v.jobId, v.speakerLabel)));
  kept = kept?.filter(
    (i) => !i.voices.some((v) => sent.has(voiceKey(v.jobId, v.speakerLabel)))
  );
  return done;
}

/**
 * The UTC months (`YYYY-MM`) a read of these jobs' speech can be filed under (a reply goes in its first message's month):
 * from their first conversation's start to their last turn. A job the store does not hold has none.
 */
export const readJobMonths = (jobIds: readonly string[]) =>
  withStore((store) => {
    const span = store.db.query<
      { from: string | null; to: string | null },
      [string]
    >(
      `select min(c.start_at) as "from", max(t.start_at) as "to" from turns t
        join conversations c on c.id = t.conversation_id where t.job_id = ?`
    );
    return [
      ...new Set(
        jobIds.flatMap((job) => {
          const { from, to } = span.get(job) ?? {};
          const months: string[] = [];
          for (let m = from?.slice(0, 7); m && to && m <= to.slice(0, 7); ) {
            months.push(m);
            const [y, mo] = m.split("-").map(Number) as [number, number];
            m =
              mo === 12
                ? `${y + 1}-01`
                : `${y}-${String(mo + 1).padStart(2, "0")}`;
          }
          return months;
        })
      ),
    ];
  });
