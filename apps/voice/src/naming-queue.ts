// The voices to name (docs/processing.md, "Speakers"): the unnamed voices that
// talked with the owner, grouped (people.ts `regroup`), each with a name the summaries heard for
// it, as cards to confirm, rename, give to someone else or ignore. Strangers (little
// back-and-forth with the owner), media and announcements get none.
//
// - A card is only a suggestion. An answer is the owner's correction (people.ts `assign`), so
//   only the owner creates people or adds voice evidence.
// - One notification a morning, and only when voices wait: its number is the queue's length,
//   the same the app's badge shows.
// - Names come from the summary runs (intelligence.ts `speakerIdentities`): recorded speech is
//   content, never a command, and a name is shown with the turns it was heard in.
import { randomUUID } from "node:crypto";
import type { Db } from "@life/voice-db";
import {
  conversationJobs,
  conversations,
  intelligenceRuns,
  type JobMap,
  live,
  people,
  type Suggestion,
  speakerAssignments,
  transcriptionJobs,
  turns as turnRows,
} from "@life/voice-db/schema";
import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { type Pusher, sendPush } from "./apns";
import { latestSeq, turnRef } from "./change-log";
import { NAMING, ownerClock, RECOGNITION } from "./config";
import { textOf } from "./elevenlabs";
import { record, recordedOn } from "./events";
import {
  addAlias,
  assign,
  isCalled,
  sampleRanker,
  type Target,
  voiceId,
  voiceMatcher,
} from "./people";
import { Result } from "./summary-calls";
import { keptAt, type LoadedTurn, loadTurns, timedWords } from "./transcript";

interface Voice {
  conversationId: string;
  exchanges: number;
  // Its unnamed group across conversations, or itself.
  group: string;
  jobId: string;
  // What the summaries called it, weighed by its talk.
  kind: string | null;
  // What the summaries heard, one per run (null: nothing).
  names: (string | null)[];
  people: (string | null)[];
  quotes: Suggestion["evidence"];
  seconds: number;
  // Called several people before the multi-select (`mixed`): asked again, who.
  several: boolean;
  speakerLabel: string;
  // Whether the summaries say it talks with the owner; null from runs that don't say.
  withOwner: boolean | null;
}

// One conversation's unnamed voices, each with the turns it traded with the owner: a turn
// right before or after one of the owner's, in the same job.
function voicesOf(
  conversationId: string,
  turns: LoadedTurn[],
  ownerId: string,
  groups: Map<string, string>,
  skipped: Set<string>,
  mixed: Set<string>
) {
  const voices = new Map<string, Voice>();
  for (const [i, t] of turns.entries()) {
    const label = t.person ? null : t.speakerLabel;
    const k = label && voiceId(t.ref.jobId, label);
    if (label && k && !skipped.has(k)) {
      const voice =
        voices.get(k) ??
        newVoice(conversationId, t, label, groups.get(k) ?? k, mixed.has(k));
      voice.seconds += t.endSeconds - t.startSeconds;
      voice.exchanges += [turns[i - 1], turns[i + 1]].filter(
        (o) => o?.ref.jobId === t.ref.jobId && o.person?.id === ownerId
      ).length;
      voices.set(k, voice);
    }
  }
  return voices;
}

const newVoice = (
  conversationId: string,
  t: LoadedTurn,
  speakerLabel: string,
  group: string,
  several: boolean
): Voice => ({
  conversationId,
  exchanges: 0,
  group,
  jobId: t.ref.jobId,
  kind: null,
  names: [],
  people: [],
  quotes: [],
  seconds: 0,
  several,
  speakerLabel,
  withOwner: null,
});

// The turns a run cites (its own turn ids), as quotes.
function quotes(
  ids: number[],
  runTurns: { jobId: string; turnIndex: number }[],
  byRef: Map<string, LoadedTurn>,
  conversationId: string
): Suggestion["evidence"] {
  return ids.flatMap((id) => {
    const ref = runTurns[id];
    const turn = ref && byRef.get(turnRef(ref.jobId, ref.turnIndex));
    return turn
      ? [
          {
            at: turn.ref.capturedAt,
            conversationId,
            text: turn.text.slice(0, NAMING.quoteChars),
          },
        ]
      : [];
  });
}

// Everything a run says about its unnamed speakers; runs before prompt version 6 say only
// their kind.
const heardOf = (run: Result | null) => [
  ...(run?.speakerKinds ?? []).map((k) => ({
    ...k,
    evidenceTurnIds: [] as number[],
    name: null,
    personId: null,
    withOwner: null,
  })),
  ...(run?.speakerIdentities ?? []),
];

// What the latest summary run said about each voice: its kind, a name with the turns it was
// heard in (a run cites turns only for a name), the owner's person it seems to be.
function heardIn(
  run: Result | null,
  runTurns: { jobId: string; turnIndex: number }[],
  turns: LoadedTurn[],
  voices: Map<string, Voice>
) {
  const byRef = new Map(
    turns.map((t) => [turnRef(t.ref.jobId, t.ref.turnIndex), t])
  );
  for (const s of heardOf(run)) {
    const voice = voices.get(voiceId(s.jobId, s.speakerLabel));
    if (voice) {
      voice.kind = s.kind;
      voice.withOwner = s.withOwner ?? voice.withOwner;
      voice.people.push(s.personId);
      voice.names.push(s.name);
      voice.quotes.push(
        ...quotes(s.evidenceTurnIds, runTurns, byRef, voice.conversationId)
      );
    }
  }
}

// The value said most often, ignoring case.
const mostOf = (values: (string | null)[]) =>
  [
    ...Map.groupBy(
      values.filter((v) => v !== null),
      (v) => v.toLowerCase()
    ).values(),
  ].sort((a, b) => b.length - a.length)[0]?.[0] ?? null;

// A group of voices as a card, its id the group's, or why it gets none.
function judge(
  group: string,
  voices: Voice[]
): Suggestion | "media" | "stranger" {
  const seconds = voices.reduce((sum, v) => sum + v.seconds, 0);
  const exchanges = voices.reduce((sum, v) => sum + v.exchanges, 0);
  const media = voices
    .filter((v) => v.kind === "media" || v.kind === "announcement")
    .reduce((sum, v) => sum + v.seconds, 0);
  if (voices.some((v) => v.several)) {
    // Called several people before: asked again who, whatever the checks below say.
    return { ...cardOf(group, voices, seconds, exchanges), kind: "several" };
  }
  if (media * 2 > seconds) {
    return "media";
  }
  // Turns next to the owner's can be people nearby talking among themselves: when the
  // summaries say none of these voices talks with the owner, they are strangers.
  const told = voices.filter((v) => v.withOwner !== null);
  const overheard = told.length > 0 && !told.some((v) => v.withOwner);
  if (
    overheard ||
    exchanges < NAMING.minExchanges ||
    seconds < NAMING.minSeconds
  ) {
    return "stranger";
  }
  return cardOf(group, voices, seconds, exchanges);
}

function cardOf(
  group: string,
  voices: Voice[],
  seconds: number,
  exchanges: number
): Suggestion {
  const personId = mostOf(voices.flatMap((v) => v.people));
  return {
    conversations: new Set(voices.map((v) => v.conversationId)).size,
    evidence: voices.flatMap((v) => v.quotes).slice(0, NAMING.quotes),
    exchanges,
    id: group,
    kind: personId ? "known_person" : "new_person",
    name: mostOf(voices.flatMap((v) => v.names)),
    personId,
    seconds: Math.round(seconds),
    voices: voices.map(({ conversationId, jobId, speakerLabel }) => ({
      conversationId,
      jobId,
      speakerLabel,
    })),
  };
}

// The unnamed voices of conversations `ids`, with what their summaries said about them.
function voicesIn(db: Db, ids: { id: string }[], ownerId: string) {
  const loaded = ids.map(({ id }) => ({
    id,
    turns: loadTurns(db, id)?.turns ?? [],
  }));
  const jobs = [
    ...new Set(loaded.flatMap((c) => c.turns.map((t) => t.ref.jobId))),
  ];
  const rows =
    jobs.length > 0
      ? db
          .select()
          .from(speakerAssignments)
          .where(
            and(
              inArray(speakerAssignments.jobId, jobs),
              isNull(speakerAssignments.turnIndex)
            )
          )
          .all()
      : [];
  const groups = new Map(
    rows.flatMap((r) =>
      r.source === "recognized" && r.candidateId && !r.mixed
        ? [[voiceId(r.jobId, r.speakerLabel), r.candidateId]]
        : []
    )
  );
  // The owner already answered for it: never asked again. One called several people (`mixed`) is.
  const skipped = new Set(
    rows.flatMap((r) =>
      r.source === "owner" ? [voiceId(r.jobId, r.speakerLabel)] : []
    )
  );
  const mixed = new Set(
    rows.flatMap((r) => (r.mixed ? [voiceId(r.jobId, r.speakerLabel)] : []))
  );
  const runs = loaded.map((c) => {
    const run = db
      .select({
        result: intelligenceRuns.result,
        turns: intelligenceRuns.turns,
      })
      .from(intelligenceRuns)
      .where(
        and(
          eq(intelligenceRuns.conversationId, c.id),
          sql`${intelligenceRuns.result} is not null`
        )
      )
      .orderBy(desc(intelligenceRuns.createdAt))
      .limit(1)
      .get();
    return run;
  });
  return loaded.flatMap((c, i) => {
    // A mixed voice is asked about named or not.
    const turns = c.turns.map((t) =>
      mixed.has(voiceId(t.ref.jobId, t.speakerLabel ?? ""))
        ? { ...t, person: null }
        : t
    );
    const mine = voicesOf(c.id, turns, ownerId, groups, skipped, mixed);
    const run = runs[i];
    heardIn(
      Result.safeParse(run?.result).data ?? null,
      run?.turns ?? [],
      c.turns,
      mine
    );
    return [...mine.values()];
  });
}

// The owner person, whose turns "talks with the owner" counts against.
const ownerOf = (db: Db) =>
  db.query.people.findFirst({ where: eq(people.isOwner, true) }).sync();

// Unnamed voices as cards, the most back-and-forth first; media and strangers get none. A group
// spans conversations (and days) through its unnamed group.
function suggest(db: Db, voices: Voice[]) {
  // A card no summary tied to a person may still sound like one, the owner included: then it
  // asks "Is this X?" rather than calling them new.
  const soundsLike = voiceMatcher(db);
  const everyone = db.select().from(people).all();
  // A heard name that is already the person's says nothing new ("Jojo" for Marie-Jo): no name.
  const news = (name: string | null, personId: string) => {
    const person = everyone.find((p) => p.id === personId);
    return name && person && isCalled(person, name) ? null : name;
  };
  const suggestions = [...Map.groupBy(voices, (v) => v.group)].flatMap(
    ([group, members]) => {
      const verdict = judge(group, members);
      return typeof verdict === "string"
        ? []
        : [
            ((): Suggestion => {
              const personId = verdict.personId ?? soundsLike(verdict.voices);
              return personId && verdict.kind !== "several"
                ? {
                    ...verdict,
                    kind: "known_person" as const,
                    name: news(verdict.name, personId),
                    personId,
                  }
                : verdict;
            })(),
          ];
    }
  );
  return suggestions.sort((a, b) => b.exchanges - a.exchanges);
}

// The voices to name: the unnamed voices of the last NAMING.queueDays that talked with the
// owner, one card per voice group across conversations and days, each with its clips. Its id is
// the group: the unnamed group recognition keeps, or the voice's own id. Cards with a clip to play
// come first, the most back-and-forth first, so "Who's this?" never opens on one it can't play.
// An answer leaves no state here: the owner's rows keep its voices out of the
// next build. Empty without an owner person.
export function namingQueue(db: Db, at = new Date()) {
  const owner = ownerOf(db);
  if (!owner) {
    return [];
  }
  const ids = db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        live,
        gt(
          conversations.captureStartedAt,
          new Date(at.getTime() - NAMING.queueDays * 86_400_000)
        )
      )
    )
    .all();
  const suggestions = suggest(db, voicesIn(db, ids, owner.id));
  const clipsOf = cardClips(db);
  const cards = suggestions.map((card) => ({ ...card, clips: clipsOf(card) }));
  const playable = (card: (typeof cards)[number]) =>
    card.clips.some((c) => c.audio || c.at);
  return [...cards.filter(playable), ...cards.filter((c) => !playable(c))];
}
type QueueItem = Awaited<ReturnType<typeof namingQueue>>[number];

// The queue, rebuilt once anything changed (the change log moved: conversations, speaker rows,
// summaries' chapters, people) or the day did (its window moves). After `invalidate` (an answer)
// the next read builds it again, so an answered voice never comes back.
// ponytail: in-process, like the other loops; one replica.
export type QueueCache = ReturnType<typeof queueCache>;

export function queueCache(db: Db) {
  let current: { at: string; items: QueueItem[] } | null = null;
  const fingerprint = () =>
    `${latestSeq(db)} ${new Date().toISOString().slice(0, 10)}`;
  return {
    invalidate() {
      current = null;
    },
    // A failed build throws and is retried by the next read.
    items() {
      const at = fingerprint();
      if (current?.at !== at) {
        current = { at, items: namingQueue(db) };
      }
      return current.items;
    },
  };
}

export type CardAnswer =
  | { kind: "confirm"; name: string }
  | { kind: "assign"; personId: string }
  | { kind: "ignore" }
  | { kind: "media" }
  | { kind: "several"; people: string[]; unknown: boolean };

// The person an answer already names: the one picked, or the one whose name or alias the owner
// typed, so a nickname never makes a second person.
function existingPerson(db: Db, action: CardAnswer) {
  if (action.kind === "assign") {
    return action.personId;
  }
  if (action.kind !== "confirm") {
    return null;
  }
  // ponytail: every person read to match in JS (Unicode case); a few hundred rows at most.
  const everyone = db.select().from(people).all();
  return everyone.find((p) => isCalled(p, action.name))?.id ?? null;
}

// The name the summaries heard becomes one of the person's names when the owner's answer didn't
// contradict the card: heard "Jojo", answered Marie-Jo. "No, it's X" against the card's own person
// teaches nothing; a name already theirs is skipped.
const learnHeardName = (
  db: Db,
  personId: string | null,
  card?: Pick<Suggestion, "name" | "personId">
) =>
  personId &&
  card?.name &&
  (card.personId === null || card.personId === personId)
    ? addAlias(db, personId, card.name)
    : false;

// "Several people": who, named passage by passage in place, and the one besides the owner to
// fall back on in a closed set (owner, Oct 15).
function severalTarget(
  db: Db,
  { people: ids, unknown }: Extract<CardAnswer, { kind: "several" }>
): Target {
  const chosen = db.select().from(people).where(inArray(people.id, ids)).all();
  const [other, more] = chosen.filter((p) => !p.isOwner);
  return {
    candidates: { people: chosen.map((p) => p.id).sort(), unknown },
    kind: "several",
    personId: unknown || more ? null : (other?.id ?? null),
  };
}

// The owner's answer for a group of voices: a new person named `name`, the person `personId`,
// nobody they know, a video or TV playing (left out of summaries and search, never evidence), or
// several people. Each voice becomes the owner's correction of a whole speaker, so voice evidence
// moves as it always does. Returns the person they went to, or
// null when no voice is a speaker of its transcript.
export function answerVoices(
  db: Db,
  voices: Pick<Suggestion["voices"][number], "jobId" | "speakerLabel">[],
  action: CardAnswer,
  card?: Pick<Suggestion, "name" | "personId">
) {
  const several = action.kind === "several" ? severalTarget(db, action) : null;
  let personId = existingPerson(db, action);
  let answered = 0;
  for (const voice of voices) {
    let target: Target = { kind: "unknown" };
    if (several) {
      target = several;
    } else if (action.kind === "media") {
      target = { kind: "media" };
    } else if (personId) {
      target = { kind: "person", personId };
    } else if (action.kind === "confirm") {
      target = { id: randomUUID(), kind: "new", name: action.name };
    }
    const rows = assign(db, {
      jobId: voice.jobId,
      speakerLabel: voice.speakerLabel,
      target,
      turnIndex: null,
    });
    if (!Array.isArray(rows)) {
      continue;
    }
    answered += 1;
    if (target.kind === "new") {
      personId =
        rows.find(
          (r) => r.speakerLabel === voice.speakerLabel && r.turnIndex === null
        )?.personId ?? null;
    }
  }
  const learned = learnHeardName(db, answered > 0 ? personId : null, card);
  record(db, "voices.answered", {
    action: action.kind,
    learned,
    voices: answered,
  });
  return answered > 0 ? { personId } : null;
}

// One clip a card plays: a clean turn of its voice, with the words said before it is cut. `audio`
// places it in the job's bucket audio (`GET /transcripts/{jobId}/audio`, seconds into that file):
// the server's own copy, for every job that has one. Only a job from before the bucket has none;
// then the phone plays `at` to `until` from its own recording. `words` time both, from `at`.
// The turn (`jobId`, `speakerLabel`, `turnIndex`) is what "several people" names in place, and
// `personId` who it reads as now.
export interface Clip {
  at: string | null;
  audio: { end: number; jobId: string; start: number } | null;
  conversationId: string;
  jobId: string;
  personId: string | null;
  speakerLabel: string | null;
  text: string;
  turnIndex: number;
  until: string | null;
  words: [number, number, number][];
}

// A turn as a card plays it: its words begun within NAMING.clipSeconds, from the first to the end
// of the last (never past the cut), so it stops where its voice does. With bucket audio it also
// stops where its stretch of kept speech does: the bucket audio has the silence after it cut out,
// so only inside one stretch do capture time and the file's time run together (docs/formats.md).
function clipOf(
  conversationId: string,
  turn: LoadedTurn,
  // The job's map when it has bucket audio.
  map: JobMap | null
): Clip {
  const at = turn.ref.capturedAt;
  const from = turn.startSeconds * 1000;
  const kept = map && keptAt(map, from);
  const cut = Math.min(
    from + NAMING.clipSeconds * 1000,
    kept?.end ?? Number.POSITIVE_INFINITY
  );
  const said = turn.words.filter((w) => w.start < cut);
  const end = Math.min(said.at(-1)?.end ?? turn.endSeconds * 1000, cut);
  return {
    at,
    audio: kept
      ? {
          end: (kept.prepared + end - from) / 1000,
          jobId: turn.ref.jobId,
          start: kept.prepared / 1000,
        }
      : null,
    conversationId,
    jobId: turn.ref.jobId,
    personId: turn.person?.id ?? null,
    speakerLabel: turn.speakerLabel,
    text: textOf(said),
    turnIndex: turn.ref.turnIndex,
    until: new Date(end).toISOString(),
    words: timedWords(said, from),
  };
}

// The clips of an open card, best first: the clean turns (samples) that clearly sound like its
// voice (RECOGNITION.matchThreshold), 5–20 s before other lengths, then the rest by likeness;
// each is cut to NAMING.clipSeconds. A turn the provider gave one speaker can hold several
// people: it sounds unlike the voice, so it comes late, and one that clearly is someone else
// (RECOGNITION.notThem) only when nothing else is left.
export function cardClips(db: Db) {
  const rank = sampleRanker(db);
  const loaded = new Map<string, LoadedTurn[]>();
  const turnsOf = (conversationId: string) => {
    const turns =
      loaded.get(conversationId) ?? loadTurns(db, conversationId)?.turns ?? [];
    loaded.set(conversationId, turns);
    return turns;
  };
  // The turn in the live conversations that hold its job now (a regroup can split a job).
  const turnOf = (jobId: string, turnIndex: number) => {
    const holders = db
      .select({ id: conversationJobs.conversationId })
      .from(conversationJobs)
      .where(eq(conversationJobs.jobId, jobId))
      .all();
    for (const { id } of holders) {
      const turn = turnsOf(id).find(
        (t) => t.ref.jobId === jobId && t.ref.turnIndex === turnIndex
      );
      if (turn) {
        return { conversationId: id, turn };
      }
    }
    return null;
  };
  // The job's map when it has bucket audio, which the map places in capture time.
  const bucketMap = (jobId: string) => {
    const row = db
      .select({ key: transcriptionJobs.objectKey, map: transcriptionJobs.map })
      .from(transcriptionJobs)
      .where(eq(transcriptionJobs.id, jobId))
      .get();
    return row?.key ? row.map : null;
  };
  return (card: Pick<Suggestion, "kind" | "personId" | "voices">): Clip[] => {
    const ranked = rank(
      card.voices,
      card.kind === "known_person" ? card.personId : null
    );
    const fit = ranked.filter((r) => r.score > RECOGNITION.notThem);
    const usable = fit.length > 0 ? fit : ranked;
    const fits = (seconds: number) =>
      seconds >= NAMING.clipMinSeconds && seconds <= NAMING.clipSeconds;
    const sure = usable.filter((r) => r.score >= RECOGNITION.matchThreshold);
    const ordered = [
      ...sure.filter((r) => fits(r.sample.durationSeconds)),
      ...sure.filter((r) => !fits(r.sample.durationSeconds)),
      ...usable.filter((r) => r.score < RECOGNITION.matchThreshold),
    ];
    // A voice with no sample yet (most turns before the server cut excerpts): its own turns with the
    // most words, never one named on its own, so the card still has something to hear.
    const picks =
      ordered.length > 0
        ? ordered.map((r) => r.sample)
        : db
            .select({ jobId: turnRows.jobId, turnIndex: turnRows.turnIndex })
            .from(turnRows)
            .where(
              and(
                or(
                  ...card.voices.map((v) =>
                    and(
                      eq(turnRows.jobId, v.jobId),
                      eq(turnRows.speakerLabel, v.speakerLabel)
                    )
                  )
                ),
                sql`not exists (select 1 from ${speakerAssignments} a
                  where a.job_id = ${turnRows.jobId} and a.turn_index = ${turnRows.turnIndex})`
              )
            )
            .orderBy(desc(sql`json_array_length(${turnRows.words})`))
            .limit(NAMING.clips * 3)
            .all();
    const clips: Clip[] = [];
    for (const sample of picks) {
      if (clips.length >= NAMING.clips) {
        break;
      }
      const found = turnOf(sample.jobId, sample.turnIndex);
      if (found) {
        clips.push(
          clipOf(found.conversationId, found.turn, bucketMap(sample.jobId))
        );
      }
    }
    return clips;
  };
}

// Once a morning, from NAMING.hour in the owner's zone: one notification with how many voices wait
// to be named, the queue's length, which is the number the app's badge shows. Nothing when none
// waits. Recorded as an event, so a restart the same morning sends nothing twice.
// ponytail: in-process, polled by the server's 5-minute loop; one replica, like the others.
export function morningPush(
  db: Db,
  push: Pusher | null,
  bundleId: string,
  queue: QueueCache
) {
  let busy = false;
  const notify = (day: string, count: number) =>
    sendPush(db, push, "people_digest", {
      body: JSON.stringify({
        aps: {
          alert: {
            body: `${count} ${count === 1 ? "voice" : "voices"} to name.`,
            title: "New people",
          },
          sound: "default",
        },
        peopleDigest: day,
      }),
      headers: {
        "apns-priority": "10",
        "apns-push-type": "alert",
        "apns-topic": bundleId,
      },
    });
  return {
    async morning(at = new Date()) {
      const { date, hour } = ownerClock(at);
      if (busy || hour < NAMING.hour) {
        return null;
      }
      busy = true;
      try {
        if (recordedOn(db, "voices.digest", date)) {
          return null;
        }
        const count = queue.items().length;
        record(db, "voices.digest", { count, day: date });
        if (count > 0) {
          await notify(date, count);
        }
        return { count };
      } finally {
        busy = false;
      }
    },
  };
}
export type MorningPush = ReturnType<typeof morningPush>;
