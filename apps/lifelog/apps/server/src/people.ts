// Speaker recognition and the owner's corrections (docs/brief.md, "Speakers and people").
//
// - Only owner actions create people or add voice evidence. Recognition writes
//   assignments with source "recognized" and nothing else.
// - A match needs a likeness >= matchThreshold to a person's profile AND a lead of at least
//   `margin` over the runner-up person. Anything else stays unknown.
// - A turn whose own voice is nearest the owner's is his, whoever the speaker (speakers.ts).
// - A speaker matching no profile may take a person named in another recording within
//   `nearbyMinutes` (`nameFromNearby`): its nearest profile among the people named there, or the
//   person of a voice that sounds the same. Only from the owner's names and profile matches,
//   never from a voice named that way.
// - Owner rows (source "owner") survive every later recognition run. Several people: his row holds
//   them (`candidates`), and each sampled turn is decided among them once.
// - A profile is one exemplar per conversation of clean evidence, clips of at least 3 s
//   (`weighProfiles`); a voice is scored against the person's closest conversations.
// - A voice that sounds more like the strangers (voices he answered "Not anyone I know" for: people
//   he doesn't care about) than like its match, and as like them as an unnamed group's voices are
//   alike (`candidateThreshold`), is a stranger too (speakers.ts `decide`): status
//   `stranger`, never named from nearby, grouped or asked about. The strangers' clips are read from
//   his answers (`strangerRows`) and go with the rest of the unnamed voice data after 30 days.
// - `sweep` matches every live transcript again when profiles change, so old conversations
//   learn names given later. `regroup` alone groups the unnamed voices, from scratch each night,
//   and `expire` deletes voice data that is nobody's evidence after 30 days.
// - Nothing here calls the transcription provider.
import { randomUUID } from "node:crypto";
import type { Db } from "@lifelog/db";
import {
  speakerAssignments as assignments,
  type Candidates,
  conversationJobs,
  type ParsedTranscript,
  people,
  transcriptionJobs,
  transcripts,
  voiceProfiles,
  voiceSamples,
} from "@lifelog/db/schema";
import {
  and,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { logChange } from "./change-log";
import { ownerClock, RECOGNITION } from "./config";
import { type Fields, record, recordedOn } from "./events";
import {
  centroid,
  cosine,
  decide,
  likeness,
  NO_PROFILES,
  nearbyMatch,
  type Profile,
  type Profiles,
  type Vector,
} from "./speakers";

type Assignment = typeof assignments.$inferSelect;
type Sample = typeof voiceSamples.$inferSelect;
// What recognition reads of a sample.
type VoiceSample = Pick<
  Sample,
  "durationSeconds" | "embedding" | "modelId" | "modelRevision" | "turnIndex"
>;

// A voice is a speaker label of one job, and is named so everywhere: the naming queue, `fetch`'s
// Speakers line, `assign_speaker`.
export const voiceId = (jobId: string, label: string | null) =>
  `${jobId}/${label ?? ""}`;

const modelKey = (s: Pick<Sample, "modelId" | "modelRevision">) =>
  `${s.modelId}@${s.modelRevision}`;

// A job's transcript, null before it has one.
export const loadTranscript = (db: Db, jobId: string) =>
  db
    .select({ parsed: transcripts.parsed })
    .from(transcripts)
    .where(eq(transcripts.jobId, jobId))
    .get() ?? null;

// The live conversations that hold the job (`conversation_jobs`; a job over a boundary is in two),
// none while it waits for grouping. Read by the view's own `where`, so SQLite seeks the job's
// turns; a join on the view builds all of it (70 ms a call on a month's archive).
export const holdingConversations = (db: Db, jobId: string) =>
  db
    .select({ id: conversationJobs.conversationId })
    .from(conversationJobs)
    .where(eq(conversationJobs.jobId, jobId))
    .all()
    .map((c) => c.id);

// ---- Samples ----------------------------------------------------------------

// Why a turn can't be a voice sample, or null when it's clean: a speaker, long enough, no
// overlap with another speaker, no stretched word.
export function uncleanTurn(parsed: ParsedTranscript, index: number) {
  const { turns, words = [] } = parsed;
  const turn = turns[index];
  if (!turn?.speakerId) {
    return "turn has no speaker";
  }
  if (turn.end - turn.start < RECOGNITION.minTurnSeconds) {
    return "turn is too short";
  }
  const overlaps = turns.some(
    (o) =>
      o.speakerId !== turn.speakerId && o.start < turn.end && turn.start < o.end
  );
  if (overlaps) {
    return "turn overlaps another speaker";
  }
  const stretched = words.some(
    (w) =>
      w.start >= turn.start &&
      w.start < turn.end &&
      w.end - w.start > RECOGNITION.maxWordSeconds
  );
  return stretched ? "turn holds a stretched word" : null;
}

// Stores the server's embeddings of a job's clean turns (excerpts.ts) and marks the job cut. A
// turn already sampled, by the phone before the rebuild, keeps its sample.
export const keepServerSamples = (
  db: Db,
  jobId: string,
  samples: (typeof voiceSamples.$inferInsert)[]
) =>
  db.transaction((tx) => {
    const kept =
      samples.length > 0
        ? tx
            .insert(voiceSamples)
            .values(samples)
            .onConflictDoNothing()
            .returning()
            .all()
        : [];
    for (const sample of kept) {
      evidenceForNew(tx, sample);
    }
    tx.update(transcripts)
      .set({ excerptsAt: new Date() })
      .where(eq(transcripts.jobId, jobId))
      .run();
  });

// A new sample becomes evidence only if the owner already assigned its turn or its speaker to a
// person.
function evidenceForNew(tx: Db, sample: Sample) {
  const owner = speakerOf(
    tx
      .select()
      .from(assignments)
      .where(
        and(
          eq(assignments.jobId, sample.jobId),
          eq(assignments.source, "owner")
        )
      )
      .all(),
    sample.speakerLabel,
    sample.turnIndex
  );
  if (owner?.personId && !owner.candidates) {
    setEvidence(tx, [sample.id], owner.personId);
  }
}

function setEvidence(db: Db, sampleIds: string[], personId: string | null) {
  if (sampleIds.length === 0) {
    return;
  }
  db.delete(voiceProfiles)
    .where(inArray(voiceProfiles.sampleId, sampleIds))
    .run();
  if (personId) {
    db.insert(voiceProfiles)
      .values(sampleIds.map((sampleId) => ({ personId, sampleId })))
      .run();
  }
}

// ---- Recognition ------------------------------------------------------------

// Who one speaker of a transcript is (`match`), with its unnamed group kept from its row before.
type Recognition = ReturnType<typeof match> & {
  candidateId: string | null;
  label: string;
};

export interface EvidenceRow {
  conversationId: string;
  durationSeconds: number;
  embedding: Vector;
  isOwner: boolean;
  modelId: string;
  modelRevision: string;
  personId: string;
  sampleId: string;
}

type Clip = Pick<
  EvidenceRow,
  | "conversationId"
  | "durationSeconds"
  | "embedding"
  | "modelId"
  | "modelRevision"
>;

// One exemplar per conversation: the centroid of its clips.
const exemplarsOf = (clips: Clip[]) =>
  [...Map.groupBy(clips, (r) => r.conversationId).values()].map((c) =>
    centroid(c.map((r) => r.embedding))
  );

// The voices recognition weighs, per embedding model (speakers.ts `Profiles`): each person's from
// their evidence, and the strangers'.
export function weighProfiles(
  rows: EvidenceRow[],
  strangers: Clip[]
): ProfilesByModel {
  const byModel = <T extends Clip>(clips: T[]) =>
    Map.groupBy(
      clips.filter((r) => r.durationSeconds >= RECOGNITION.minEvidenceSeconds),
      modelKey
    );
  const known = byModel(rows);
  const unknown = byModel(strangers);
  return new Map(
    [...new Set([...known.keys(), ...unknown.keys()])].map((model) => [
      model,
      {
        people: [
          ...Map.groupBy(known.get(model) ?? [], (r) => r.personId).values(),
        ].map(
          (clips): Profile => ({
            exemplars: exemplarsOf(clips),
            isOwner: clips[0]?.isOwner ?? false,
            personId: clips[0]?.personId ?? "",
          })
        ),
        strangers: exemplarsOf(unknown.get(model) ?? []),
      },
    ])
  );
}
export type ProfilesByModel = Map<string, Profiles>;

// The evidence that counts, one row per clip: its voice and whose it is.
export const evidenceRows = (db: Db) =>
  db
    .select({
      conversationId: voiceSamples.conversationId,
      durationSeconds: voiceSamples.durationSeconds,
      embedding: voiceSamples.embedding,
      isOwner: people.isOwner,
      modelId: voiceSamples.modelId,
      modelRevision: voiceSamples.modelRevision,
      personId: voiceProfiles.personId,
      sampleId: voiceSamples.id,
    })
    .from(voiceProfiles)
    .innerJoin(voiceSamples, eq(voiceSamples.id, voiceProfiles.sampleId))
    .innerJoin(people, eq(people.id, voiceProfiles.personId))
    .all();

// The voices recognition weighs, per embedding model, from his answers.
const readProfiles = (db: Db): ProfilesByModel =>
  weighProfiles(evidenceRows(db), strangerRows(db));

// The one read rule for who spoke: a turn's own row (the owner's correction, or one of his turns
// moved to him by speakers.ts `decide`), else its speaker's (`turn` null: the speaker's). `rows`
// are one job's.
export const speakerOf = <
  R extends { speakerLabel: string; turnIndex: number | null },
>(
  rows: R[] | undefined,
  label: string | null,
  turn: number | null
) => {
  const mine = rows?.filter((r) => r.speakerLabel === label) ?? [];
  return (
    mine.find((r) => r.turnIndex === turn) ??
    mine.find((r) => r.turnIndex === null)
  );
};

// Its other half: a sample of a turn named on its own isn't its speaker's voice.
// Spelled out: Drizzle leaves the table off a column inside a single-table select, and `t`'s own
// column would answer.
const ofItsSpeaker = sql<boolean>`not exists (select 1 from ${assignments} t
  where t.job_id = voice_samples.job_id and t.turn_index = voice_samples.turn_index)`;

// The samples an owner row covers: its turn's, or for a speaker row, its turns without a row of
// their own. His answer moves their evidence (`writeOwnerRow`); "Not anyone I know" makes them a
// stranger's clips (`strangerRows`).
const coveredByRow = and(
  eq(voiceSamples.jobId, assignments.jobId),
  eq(voiceSamples.speakerLabel, assignments.speakerLabel),
  or(
    eq(voiceSamples.turnIndex, assignments.turnIndex),
    and(isNull(assignments.turnIndex), ofItsSpeaker)
  )
);

// The clips of the voices he answered "Not anyone I know" for. They go with the rest of the unnamed voice
// data, 30 days after they were cut (`expire`).
export const strangerRows = (db: Db): Clip[] =>
  db
    .select({
      conversationId: voiceSamples.conversationId,
      durationSeconds: voiceSamples.durationSeconds,
      embedding: voiceSamples.embedding,
      modelId: voiceSamples.modelId,
      modelRevision: voiceSamples.modelRevision,
    })
    .from(voiceSamples)
    .innerJoin(
      assignments,
      and(
        coveredByRow,
        eq(assignments.source, "owner"),
        eq(assignments.status, "unknown"),
        isNull(assignments.candidates)
      )
    )
    .all();

// Every sample of these voices (job and speaker label).
const samplesOf = (
  db: Db,
  voices: { jobId: string; speakerLabel: string }[]
) =>
  voices.length === 0
    ? []
    : db
        .select()
        .from(voiceSamples)
        .where(
          and(
            ofItsSpeaker,
            or(
              ...voices.map((v) =>
                and(
                  eq(voiceSamples.jobId, v.jobId),
                  eq(voiceSamples.speakerLabel, v.speakerLabel)
                )
              )
            )
          )
        )
        .all();

// Who several unnamed voices sound like together, by the usual rule (threshold and margin):
// a group spread over conversations often matches where none of its voices does alone. Only
// a hint for the naming queue's cards; it never assigns anyone.
export function voiceMatcher(db: Db) {
  const profiles = readProfiles(db);
  return (voices: { jobId: string; speakerLabel: string }[]) =>
    match(samplesOf(db, voices), profiles).personId;
}

// A naming card's samples ranked by how much each sounds like the card's voice: `personId`'s
// profile when the card asks "Is this X?", else the samples together. A turn the provider gave
// one speaker can hold several people; it sounds unlike the voice and ranks low. Only a ranking
// for the card's clips; it assigns nothing.
export function sampleRanker(db: Db) {
  const profiles = readProfiles(db);
  return (
    voices: { jobId: string; speakerLabel: string }[],
    personId: string | null
  ) => {
    const samples = samplesOf(db, voices);
    const [model] = [...Map.groupBy(samples, modelKey)].sort(
      (a, b) => b[1].length - a[1].length
    );
    if (!model) {
      return [];
    }
    const [key, same] = model;
    const exemplars = (profiles.get(key) ?? NO_PROFILES).people.find(
      (p) => p.personId === personId
    )?.exemplars ?? [centroid(same.map((s) => s.embedding))];
    return same
      .map((sample) => ({
        sample,
        score: likeness(sample.embedding, exemplars),
      }))
      .sort((a, b) => b.score - a.score);
  };
}

// A speaker's voice: its samples of one embedding model (the first one's), and their centroid when
// there is at least `minSpeakerSeconds` of clean speech.
function speakerVoice(speakerSamples: VoiceSample[]) {
  const model = speakerSamples[0] ? modelKey(speakerSamples[0]) : "";
  const samples = speakerSamples.filter((s) => modelKey(s) === model);
  const seconds = samples.reduce((sum, s) => sum + s.durationSeconds, 0);
  const vector =
    samples.length > 0 && seconds >= RECOGNITION.minSpeakerSeconds
      ? centroid(samples.map((s) => s.embedding))
      : null;
  return { model, samples, vector };
}

// Who a speaker is, and its turns that are someone else's (speakers.ts `decide`), from its
// samples of one model.
export function match(
  speakerSamples: VoiceSample[],
  profiles: ProfilesByModel,
  candidates?: Candidates | null
) {
  const voice = speakerVoice(speakerSamples);
  return {
    ...decide(voice, profiles.get(voice.model) ?? NO_PROFILES, candidates),
    model: voice.vector ? voice.model : null,
  };
}

// The voices of the speaker rows `where` picks, one per row with enough clean speech.
function voicesWhere(db: Db, where: SQL | undefined) {
  const rows = db
    .select({ assignment: assignments, sample: voiceSamples })
    .from(assignments)
    .innerJoin(
      voiceSamples,
      and(
        eq(voiceSamples.jobId, assignments.jobId),
        eq(voiceSamples.speakerLabel, assignments.speakerLabel)
      )
    )
    .where(and(isNull(assignments.turnIndex), ofItsSpeaker, where))
    .all();
  return [...Map.groupBy(rows, (r) => r.assignment.id).values()].flatMap(
    (group) => {
      const { model, vector } = speakerVoice(group.map((g) => g.sample));
      const assignment = group[0]?.assignment;
      return vector && assignment ? [{ assignment, model, vector }] : [];
    }
  );
}

// Every unnamed recognized speaker (unknown or in a group) with enough clean speech.
const unnamedVoices = (db: Db) =>
  voicesWhere(
    db,
    and(
      eq(assignments.source, "recognized"),
      inArray(assignments.status, ["unknown", "candidate"])
    )
  );
type UnnamedVoice = ReturnType<typeof unnamedVoices>[number];

interface NearbyVoice {
  model: string;
  personId: string;
  vector: Vector;
}

// The voices named in other recordings within `nearbyMinutes` of a job, per person. Only the
// owner's names and clear profile matches (`nearbyReference`) count, never a name given by
// `nameFromNearby`: its stored score stays under the threshold, so a mistake can't spread
// through an evening. Each recording's voices are read once and kept for the pass (`sweep`), and
// read again once it is recognized again (`forget`).
function nearbyVoices() {
  const near = RECOGNITION.nearbyMinutes * 60_000;
  const kept = new Map<string, NearbyVoice[]>();
  let ranges: { end: number; id: string; start: number }[] | null = null;
  return {
    forget: (jobId: string) => kept.delete(jobId),
    of(db: Db, jobId: string) {
      ranges ??= db
        .select({
          end: transcriptionJobs.captureEnd,
          id: transcriptionJobs.id,
          start: transcriptionJobs.captureStart,
        })
        .from(transcriptionJobs)
        .all()
        .flatMap(({ end, id, start }) =>
          start && end
            ? [{ end: end.getTime(), id, start: start.getTime() }]
            : []
        );
      const own = ranges.find((j) => j.id === jobId);
      const ids = own
        ? ranges
            .filter(
              (j) =>
                j.id !== jobId &&
                j.start <= own.end + near &&
                j.end >= own.start - near
            )
            .map((j) => j.id)
        : [];
      const unread = ids.filter((id) => !kept.has(id));
      for (const id of unread) {
        kept.set(id, []);
      }
      const read =
        unread.length > 0
          ? voicesWhere(
              db,
              and(
                inArray(assignments.jobId, unread),
                isNotNull(assignments.personId),
                isNull(assignments.candidates),
                eq(assignments.mixed, false),
                or(
                  eq(assignments.source, "owner"),
                  and(
                    gte(assignments.score, RECOGNITION.nearbyReference),
                    gte(assignments.margin, RECOGNITION.margin)
                  )
                )
              )
            )
          : [];
      for (const { assignment, model, vector } of read) {
        kept.get(assignment.jobId)?.push({
          model,
          personId: assignment.personId as string,
          vector,
        });
      }
      return ids.flatMap((id) => kept.get(id) ?? []);
    },
  };
}
type Nearby = ReturnType<typeof nearbyVoices>;

// A voice that matched no profile takes a person named minutes before or after, in another
// recording: its nearest profile when only the people named nearby are weighed (`nearbyMatch`),
// else the person of a voice `nearbyVoice` alike and `margin` ahead of the next person's (a
// profile mixes many rooms, while the same evening sounds the same). Its score and margin stay
// the profile's, so it never becomes a nearby voice itself.
function nameFromNearby(
  db: Db,
  jobId: string,
  results: Recognition[],
  profiles: ProfilesByModel,
  nearbyOf: Nearby
) {
  const missed = results.filter(
    (r) => !(r.personId || r.isStranger) && r.vector
  );
  if (missed.length === 0) {
    return;
  }
  const nearby = nearbyOf.of(db, jobId);
  const nearbyPeople = new Set(nearby.map((n) => n.personId));
  for (const r of missed) {
    r.personId =
      nearbyMatch(
        r.vector ?? [],
        (profiles.get(r.model ?? "") ?? NO_PROFILES).people,
        nearbyPeople
      ) ?? nearbyPerson(r, nearby);
  }
}

// The person whose nearby voice is most like `r`, if alike enough and ahead of anyone else's.
function nearbyPerson(
  r: { model: string | null; vector: Vector | null },
  nearby: NearbyVoice[]
) {
  const scores = nearby
    .filter((n) => n.model === r.model)
    .map((n) => ({
      personId: n.personId,
      score: cosine(n.vector, r.vector ?? []),
    }))
    .sort((a, b) => b.score - a.score);
  const [best] = scores;
  const runnerUp = scores.find((s) => s.personId !== best?.personId);
  return best &&
    best.score >= RECOGNITION.nearbyVoice &&
    best.score - (runnerUp?.score ?? 0) >= RECOGNITION.margin
    ? best.personId
    : null;
}

// The owner's id, from his profile.
const ownerIn = (profiles: ProfilesByModel) =>
  [...profiles.values()].flatMap((v) => v.people).find((p) => p.isOwner)
    ?.personId;

// Re-matches every speaker of a transcript that the owner hasn't assigned, from the
// samples already stored. Safe to run any number of times; never transcribes. Whether anything
// changed; null without a transcript.
export function recognize(db: Db, jobId: string) {
  return db.transaction((tx) => recognizeJob(tx, jobId, readProfiles(tx)));
}

// A speaker whose voice data expired: what it was last recognized as.
const lastKnown = (old: Assignment): Recognition => ({
  candidateId: old.candidateId,
  isStranger: old.status === "stranger",
  label: old.speakerLabel,
  margin: old.margin,
  model: null,
  personId: old.personId,
  score: old.score,
  turns: [],
  vector: null,
});

// Whether `results` say what the stored rows already say (scores aside).
const unchanged = (results: Recognition[], before: Map<string, Assignment>) =>
  results.length === before.size &&
  results.every((r) => {
    const old = before.get(r.label);
    return (
      r.turns.length === 0 &&
      old?.personId === r.personId &&
      old.candidateId === groupOf(r) &&
      old.status === statusOf(r)
    );
  });

// A speaker that is the owner needs none of his turns moved.
function keepOwnerWhole(results: Recognition[], ownerId: string | undefined) {
  for (const r of results) {
    if (r.personId && r.personId === ownerId) {
      r.turns = [];
    }
  }
}

// The rows recognition writes for one transcript: a row per speaker, the turns found before
// (`kept`, as they were) and those found now, in its speakers and its `several` voices.
function recognizedRows(
  jobId: string,
  results: Recognition[],
  kept: Assignment[],
  several: Pick<Recognition, "label" | "turns">[]
) {
  return [
    ...results.map((r) => ({
      candidateId: groupOf(r),
      jobId,
      margin: r.margin,
      personId: r.personId,
      score: r.score,
      source: "recognized" as const,
      speakerLabel: r.label,
      status: statusOf(r),
    })),
    ...kept.map(({ id: _, updatedAt: __, ...r }) => r),
    ...[...results, ...several].flatMap((r) =>
      r.turns.map((t) => ({
        jobId,
        personId: t.personId,
        score: t.score,
        source: "recognized" as const,
        speakerLabel: r.label,
        status: "person" as const,
        turnIndex: t.turnIndex,
      }))
    ),
  ];
}

// Writes one transcript's recognized rows, and only when they change (the phone reads every
// row of a changed job). A speaker whose voice data expired keeps what it was last recognized
// as; every speaker keeps its unnamed group (`regroup` redoes them each night). Whether anything
// changed; null without a transcript.
function recognizeJob(
  tx: Db,
  jobId: string,
  profiles: ProfilesByModel,
  nearby = nearbyVoices()
) {
  const transcript = loadTranscript(tx, jobId);
  if (!transcript) {
    return null;
  }
  const rows = tx
    .select()
    .from(assignments)
    .where(eq(assignments.jobId, jobId))
    .all();
  // The owner's answers, and the voices he called several people before the multi-select
  // (`mixed`), which wait for him as they are.
  const held = (r: Assignment) => r.source === "owner" || r.mixed;
  const answered = rows.filter((r) => held(r) && r.turnIndex === null);
  const before = new Map(
    rows
      .filter((r) => !held(r) && r.turnIndex === null)
      .map((r) => [r.speakerLabel, r])
  );
  // The turns recognition found before: they stay as they were.
  const kept = rows.filter(
    (r) => r.source === "recognized" && r.turnIndex !== null
  );
  const labels = new Set(
    transcript.parsed.turns.flatMap((t) => t.speakerId ?? [])
  );
  const jobSamples = tx
    .select({ clean: ofItsSpeaker, sample: voiceSamples })
    .from(voiceSamples)
    .where(eq(voiceSamples.jobId, jobId))
    .all();
  const clean = (label: string) =>
    jobSamples.flatMap((s) =>
      s.clean && s.sample.speakerLabel === label ? [s.sample] : []
    );
  const results = [...labels]
    .filter((label) => !answered.some((r) => r.speakerLabel === label))
    .map((label): Recognition => {
      const old = before.get(label);
      if (old && !jobSamples.some((s) => s.sample.speakerLabel === label)) {
        return lastKnown(old);
      }
      return {
        ...match(clean(label), profiles),
        candidateId: old?.candidateId ?? null,
        label,
      };
    });
  const several = answered.flatMap((r) =>
    r.candidates
      ? [
          {
            label: r.speakerLabel,
            turns: match(clean(r.speakerLabel), profiles, r.candidates).turns,
          },
        ]
      : []
  );
  nameFromNearby(tx, jobId, results, profiles, nearby);
  const ownerId = ownerIn(profiles);
  keepOwnerWhole(results, ownerId);
  if (
    unchanged(results, before) &&
    several.every((v) => v.turns.length === 0)
  ) {
    return false;
  }
  tx.delete(assignments)
    .where(
      and(
        eq(assignments.jobId, jobId),
        eq(assignments.source, "recognized"),
        eq(assignments.mixed, false)
      )
    )
    .run();
  const values = recognizedRows(jobId, results, kept, several);
  if (values.length > 0) {
    tx.insert(assignments).values(values).run();
  }
  nearby.forget(jobId);
  logChange(tx, "assignment", jobId);
  return true;
}

// A named voice or a stranger is in no unnamed group.
const groupOf = (r: Recognition) =>
  r.personId || r.isStranger ? null : r.candidateId;

const statusOf = (r: Recognition) => {
  if (r.personId) {
    return "person" as const;
  }
  if (r.isStranger) {
    return "stranger" as const;
  }
  return r.candidateId ? ("candidate" as const) : ("unknown" as const);
};

// ---- Upkeep -----------------------------------------------------------------

// Matches every live transcript again against today's profiles, then rebuilds the unnamed
// groups. Owner rows are never touched; only rows whose result changes are rewritten.
export function sweep(db: Db) {
  const profiles = readProfiles(db);
  // Only transcripts with voice samples: before that there is nothing to match, and rows written
  // then ("unknown", no score) let summaries start before recognition (Oct 14: 34 jobs). The
  // excerpts' own recognition writes their first rows (excerpts.ts).
  const jobs = db
    .selectDistinct({ jobId: conversationJobs.jobId })
    .from(conversationJobs)
    .innerJoin(transcripts, eq(transcripts.jobId, conversationJobs.jobId))
    .where(
      sql`exists (select 1 from voice_samples s where s.job_id = ${conversationJobs.jobId})`
    )
    .all();
  const nearby = nearbyVoices();
  let changed = 0;
  for (const { jobId } of jobs) {
    // One transcript per transaction keeps each write short.
    const done = db.transaction((tx) =>
      recognizeJob(tx, jobId, profiles, nearby)
    );
    changed += done ? 1 : 0;
  }
  return { changed, jobs: jobs.length, regrouped: regroup(db) };
}

// Indices of `vectors` in groups of two or more, by average linkage: the two groups whose
// voices are most alike on average merge, while that average is at least `threshold`. Of equal
// pairs, the last (by first group, then second) merges. Each group keeps its best later group
// (`Best`), so a merge searches again only the rows it touched.
// ponytail: O(n²) memory and O(n³) at worst on the unnamed voices of 30 days (a few thousand).
export function averageLinkage(vectors: Vector[], threshold: number) {
  const groups: (number[] | null)[] = vectors.map((_, i) => [i]);
  // sum[a][b]: the summed cosines between the voices of groups a and b.
  const sum = vectors.map((x) => vectors.map((y) => cosine(x, y)));
  const average = (a: number, b: number) =>
    (sum[a]?.[b] ?? 0) / ((groups[a]?.length ?? 1) * (groups[b]?.length ?? 1));
  const best = groups.map((_, a) => bestOf(groups, average, a));
  for (let a = nextMerge(best, groups, threshold); a >= 0; ) {
    const b = best[a]?.b ?? -1;
    groups[a]?.push(...(groups[b] ?? []));
    groups[b] = null;
    for (const [k, row] of sum.entries()) {
      const merged = (sum[a]?.[k] ?? 0) + (sum[b]?.[k] ?? 0);
      row[a] = merged;
      (sum[a] ?? [])[k] = merged;
    }
    afterMerge(best, groups, average, [a, b]);
    a = nextMerge(best, groups, threshold);
  }
  return groups.filter((g): g is number[] => !!g && g.length > 1);
}

// A group's most alike later group, the last of equals; -1 for none.
interface Best {
  b: number;
  score: number;
}

function bestOf(
  groups: unknown[],
  average: (a: number, b: number) => number,
  a: number
) {
  let best: Best = { b: -1, score: Number.NEGATIVE_INFINITY };
  for (let b = a + 1; b < groups.length; b += 1) {
    const score = average(a, b);
    if (groups[b] && score >= best.score) {
      best = { b, score };
    }
  }
  return best;
}

// The group whose best pair merges next: the most alike at `threshold` or more, the last of equals;
// -1 for none.
function nextMerge(best: Best[], groups: unknown[], threshold: number) {
  let pick = -1;
  let score = threshold;
  for (const [a, { b, score: alike }] of best.entries()) {
    if (groups[a] && b >= 0 && alike >= score) {
      pick = a;
      score = alike;
    }
  }
  return pick;
}

// After group `b` merged into `a`: the rows whose best was either, and `a`'s own, are searched
// again; a row before `a` takes `a` if it is now as alike as its best. Rows after `b` only reach
// groups after it: unchanged.
function afterMerge(
  best: Best[],
  groups: unknown[],
  average: (a: number, b: number) => number,
  [a, b]: [number, number]
) {
  for (let k = 0; k <= b; k += 1) {
    const row = best[k];
    const score = k < a ? average(k, a) : Number.NEGATIVE_INFINITY;
    if (!(row && groups[k])) {
      continue;
    }
    if (k === a || row.b === a || row.b === b) {
      best[k] = bestOf(groups, average, k);
    } else if (score > row.score || (score === row.score && a > row.b)) {
      best[k] = { b: a, score };
    }
  }
}

// The groups of `voices` (one model), each with an id: the one most of its voices already
// had, unless a bigger group took it, else a new one.
function groupIds(voices: UnnamedVoice[]) {
  const used = new Set<string>();
  return averageLinkage(
    voices.map((v) => v.vector),
    RECOGNITION.candidateThreshold
  ).map((indices) => {
    const members = indices.flatMap((i) => voices[i] ?? []);
    const [kept] = [
      ...Map.groupBy(
        members.flatMap((m) => m.assignment.candidateId ?? []),
        (x) => x
      ).entries(),
    ]
      .filter(([existing]) => !used.has(existing))
      .sort((x, y) => y[1].length - x[1].length);
    const id = kept?.[0] ?? randomUUID();
    used.add(id);
    return [id, members] as const;
  });
}

// Rebuilds every unnamed group from scratch (`averageLinkage`), so groups that drifted come
// apart. A group keeps the id most of its voices already had. Returns the rows it changed.
export function regroup(db: Db) {
  return db.transaction((tx) => {
    const voices = unnamedVoices(tx);
    const wanted = new Map<string, string | null>(
      voices.map((v) => [v.assignment.id, null])
    );
    for (const sameModel of Map.groupBy(voices, (v) => v.model).values()) {
      for (const [id, members] of groupIds(sameModel)) {
        for (const v of members) {
          wanted.set(v.assignment.id, id);
        }
      }
    }
    const changes = voices.filter(
      (v) => v.assignment.candidateId !== wanted.get(v.assignment.id)
    );
    for (const v of changes) {
      const candidateId = wanted.get(v.assignment.id) ?? null;
      tx.update(assignments)
        .set({ candidateId, status: candidateId ? "candidate" : "unknown" })
        .where(eq(assignments.id, v.assignment.id))
        .run();
    }
    logChange(
      tx,
      "assignment",
      changes.map((v) => v.assignment.jobId)
    );
    return changes.length;
  });
}

// Deletes voice data (embeddings only; never audio or transcripts) that is nobody's evidence:
// a speaker the owner marked as media at once, a retired job's after a day, everything else
// after `keepDays`. Recognized labels stay as they were (recognizeJob keeps them).
export function expire(db: Db) {
  const days = (n: number) => Date.now() - n * 86_400_000;
  const removed = db.all<{ id: string }>(sql`
    delete from ${voiceSamples} as s
    where not exists (select 1 from ${voiceProfiles} p where p.sample_id = s.id)
      and (
        s.created_at < ${days(RECOGNITION.keepDays)}
        or (s.created_at < ${days(1)}
          and not exists (select 1 from ${conversationJobs} j where j.job_id = s.job_id))
        or exists (
          select 1 from ${assignments} a
          where a.job_id = s.job_id and a.speaker_label = s.speaker_label
            and a.source = 'owner' and a.status = 'media'
            and (a.turn_index is null or a.turn_index = s.turn_index))
      )
    returning id`);
  return removed.length;
}

const UPKEEP_HOUR = 3;
const AFTER_CORRECTION_MS = 60_000;

// Voice upkeep, synchronous so one run at a time: every night after 03:00 in the owner's zone the
// sweep, then expiry; a minute after the owner's last correction, the sweep alone, so a name given
// today reaches old conversations without waiting for the night.
// ponytail: in-process state and timer; assumes one server replica, like the other loops.
export function voiceUpkeep(db: Db) {
  let lastNight = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = (work: () => Fields | null) => {
    try {
      const fields = work();
      if (fields) {
        record(db, "voices.upkeep", fields);
      }
    } catch (error: unknown) {
      console.error(`voice upkeep: ${String(error)}`);
    }
  };
  return {
    nightly(at = new Date()) {
      const { date, hour } = ownerClock(at);
      if (hour < UPKEEP_HOUR || date === lastNight) {
        return null;
      }
      lastNight = date;
      // Once a day across restarts too: a deploy after 03:00 finds the night's event.
      return run(() =>
        recordedOn(db, "voices.upkeep", date)
          ? null
          : { ...sweep(db), day: date, expired: expire(db) }
      );
    },
    soon() {
      clearTimeout(timer);
      timer = setTimeout(() => run(() => sweep(db)), AFTER_CORRECTION_MS);
    },
  };
}
export type VoiceUpkeep = ReturnType<typeof voiceUpkeep>;

// ---- Owner actions ----------------------------------------------------------

export type Target =
  | { kind: "person"; personId: string }
  | { id: string; kind: "new"; name: string }
  | { kind: "unknown" }
  | { kind: "media" }
  // Several people (who exist), and the one to fall back on.
  | { candidates: Candidates; kind: "several"; personId: string | null };

// Names, assigns or corrects a speaker (turnIndex null) or a single turn. The evidence
// that came from that scope in this transcript moves to the new person, or is removed
// when the target is unknown. Turns the owner corrected individually keep their own. Every
// caller then calls `voices.soon()`: the sweep re-matches the rest, this transcript included.
export function assign(
  db: Db,
  input: {
    jobId: string;
    speakerLabel: string;
    target: Target;
    turnIndex: number | null;
  }
) {
  const { jobId, speakerLabel, target, turnIndex } = input;
  return db.transaction((tx) => {
    const turns = loadTranscript(tx, jobId)?.parsed.turns ?? [];
    const exists =
      turnIndex === null
        ? turns.some((t) => t.speakerId === speakerLabel)
        : turns[turnIndex]?.speakerId === speakerLabel;
    if (!exists) {
      return {
        error: "not_found" as const,
        message: "no such speaker or turn",
      };
    }
    const personId = resolveTarget(tx, target);
    if (personId === undefined) {
      return { error: "not_found" as const, message: "no such person" };
    }

    writeOwnerRow(tx, {
      ...input,
      candidates: target.kind === "several" ? target.candidates : null,
      media: target.kind === "media",
      personId,
    });
    logChange(tx, "assignment", jobId);
    if (personId && target.kind === "new") {
      logChange(tx, "person", personId);
    }
    return assignmentRows(tx, eq(assignments.jobId, jobId));
  });
}

// Replaces the owner row for a speaker or turn and moves that scope's evidence in this
// transcript to the person (or drops it: several people are nobody's evidence).
function writeOwnerRow(
  tx: Db,
  scope: {
    candidates: Candidates | null;
    jobId: string;
    media: boolean;
    personId: string | null;
    speakerLabel: string;
    turnIndex: number | null;
  }
) {
  const { candidates, jobId, media, personId, speakerLabel, turnIndex } = scope;
  const scoped = and(
    eq(assignments.jobId, jobId),
    eq(assignments.speakerLabel, speakerLabel),
    turnIndex === null
      ? isNull(assignments.turnIndex)
      : eq(assignments.turnIndex, turnIndex)
  );
  tx.delete(assignments).where(scoped).run();
  const [row] = tx
    .insert(assignments)
    .values({
      candidates,
      jobId,
      personId,
      source: "owner",
      speakerLabel,
      status: ownerStatus(personId, media),
      turnIndex,
    })
    .returning({ id: assignments.id })
    .all();
  const samples = tx
    .select({ id: voiceSamples.id })
    .from(voiceSamples)
    .innerJoin(assignments, coveredByRow)
    .where(eq(assignments.id, row?.id ?? ""))
    .all();
  setEvidence(
    tx,
    samples.map((s) => s.id),
    candidates ? null : personId
  );
  if (candidates) {
    // Its turns decided among them now, before the summaries the phone asks for.
    recognizeJob(tx, jobId, readProfiles(tx));
  }
}

const ownerStatus = (personId: string | null, media: boolean) => {
  if (personId) {
    return "person" as const;
  }
  return media ? ("media" as const) : ("unknown" as const);
};

// The person a target names (created for kind "new"), null for unknown or media,
// undefined if the person doesn't exist.
function resolveTarget(db: Db, target: Target) {
  if (target.kind === "unknown" || target.kind === "media") {
    return null;
  }
  if (target.kind === "several") {
    return target.personId;
  }
  if (target.kind === "person") {
    return db
      .select({ id: people.id })
      .from(people)
      .where(eq(people.id, target.personId))
      .get()?.id;
  }
  // The phone chose the id: a replay finds the person made the first time.
  db.insert(people)
    .values({ id: target.id, name: target.name })
    .onConflictDoNothing()
    .run();
  return target.id;
}

// Moves every piece of evidence and every assignment of `fromId` to `intoId`, then
// deletes `fromId`. A replay, `fromId` gone and `intoId` there, answers `intoId` as it is.
export function merge(db: Db, intoId: string, fromId: string) {
  return db.transaction((tx) => {
    const found = tx
      .select()
      .from(people)
      .where(inArray(people.id, [intoId, fromId]))
      .all();
    const into = found.find((p) => p.id === intoId);
    const from = found.find((p) => p.id === fromId);
    if (into && !from) {
      return personRow(into);
    }
    if (!(into && from) || intoId === fromId) {
      return null;
    }
    // The merged person's names stay findable: "Mari" merged into Marie-Jo is one of hers.
    const merged = tx
      .update(people)
      .set({
        aliases: aliasesOf(into.name, [
          ...into.aliases,
          from.name,
          ...from.aliases,
        ]),
      })
      .where(eq(people.id, intoId))
      .returning()
      .get();
    tx.update(voiceProfiles)
      .set({ personId: intoId })
      .where(eq(voiceProfiles.personId, fromId))
      .run();
    const moved = tx
      .update(assignments)
      .set({ personId: intoId })
      .where(eq(assignments.personId, fromId))
      .returning({ jobId: assignments.jobId })
      .all();
    // A voice of several people holds them under the id they merged into, once.
    const several = tx
      .select({ candidates: assignments.candidates, id: assignments.id })
      .from(assignments)
      .where(
        sql`exists (select 1 from json_each(${assignments.candidates}, '$.people') where value = ${fromId})`
      )
      .all();
    for (const { candidates, id } of several) {
      if (!candidates) {
        continue;
      }
      const ids = candidates.people.map((p) => (p === fromId ? intoId : p));
      tx.update(assignments)
        .set({
          candidates: { ...candidates, people: [...new Set(ids)].sort() },
        })
        .where(eq(assignments.id, id))
        .run();
    }
    tx.delete(people).where(eq(people.id, fromId)).run();
    logChange(tx, "person", [intoId, fromId]);
    logChange(
      tx,
      "assignment",
      moved.map((m) => m.jobId)
    );
    return merged ? personRow(merged) : null;
  });
}

// ---- Reads ------------------------------------------------------------------

// Each job's rows, by job.
export const assignmentsByJob = (db: Db, jobIds: Iterable<string>) =>
  Map.groupBy(
    assignmentRows(db, inArray(assignments.jobId, [...new Set(jobIds)])),
    (r) => r.jobId
  );

// Who each speaker or turn is, as the feed and the routes send it.
export function assignmentRows(db: Db, where: SQL) {
  const rows = db
    .select({ assignment: assignments, personName: people.name })
    .from(assignments)
    .leftJoin(people, eq(people.id, assignments.personId))
    .where(where)
    .orderBy(
      assignments.jobId,
      assignments.speakerLabel,
      sql`${assignments.turnIndex} asc nulls first`
    )
    .all();
  return rows.map(({ assignment: a, personName }) => ({
    jobId: a.jobId,
    personId: a.personId,
    personName,
    speakerLabel: a.speakerLabel,
    status: a.status,
    turnIndex: a.turnIndex,
  }));
}

// A person as the feed and the routes send them.
export const personRow = (p: typeof people.$inferSelect) => ({
  aliases: p.aliases,
  id: p.id,
  isOwner: p.isOwner,
  name: p.name,
});

// ---- Names ------------------------------------------------------------------

// A person by any name the owner uses for them: theirs or an alias, case aside.
export const isCalled = (
  person: { aliases: string[]; name: string },
  word: string
) => {
  const wanted = word.trim().toLowerCase();
  return (
    wanted !== "" &&
    [person.name, ...person.aliases].some((n) => n.toLowerCase() === wanted)
  );
};

// Aliases trimmed, each once (case aside), never the name itself.
export function aliasesOf(name: string, aliases: string[]) {
  const seen = new Set([name.trim().toLowerCase()]);
  return aliases.flatMap((a) => {
    const alias = a.trim();
    const key = alias.toLowerCase();
    if (!alias || seen.has(key)) {
      return [];
    }
    seen.add(key);
    return [alias];
  });
}
