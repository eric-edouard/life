// Speaker recognition and owner corrections: only owner actions create people or evidence.
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { clock } from "@life/server/src/core/clock";
import type { Db } from "@lifelog/db";
import {
  speakerAssignments as assignments,
  type Candidates,
  conversationJobs,
  type ParsedTranscript,
  people,
  transcripts,
  voiceProfiles,
  voiceSamples,
} from "@lifelog/db/schema";
import {
  and,
  type Column,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { logChange, turnRef } from "./change-log";
import { ownerClock, RECOGNITION } from "./config";
import { reportError } from "./diagnostics";
import { type Fields, record, recordedOn } from "./events";
import {
  keepOwnerWhole,
  lastKnown,
  type Recognition,
  recognizedRows,
  unchanged,
} from "./recognized-rows";
import {
  centroid,
  decide,
  exemplarsOf,
  likeness,
  NO_PROFILES,
  nearbyMatch,
  type Profiles,
} from "./speakers";
import { averageLinkage } from "./voice-linkage";
import { cosine, type Vector } from "./voice-vectors";

type Assignment = typeof assignments.$inferSelect;

// Rejected for sampling or naming, not merely already named: candidates still need their clips.
export const isRejected = (
  assignment: Pick<Assignment, "source" | "status" | "candidates"> | undefined
) =>
  assignment?.status === "stranger" ||
  (assignment?.source === "owner" &&
    !assignment.candidates &&
    (assignment.status === "unknown" || assignment.status === "media"));
type Sample = typeof voiceSamples.$inferSelect;
// What recognition reads of a sample.
type VoiceSample = Pick<
  Sample,
  "durationSeconds" | "embedding" | "modelId" | "modelRevision" | "turnIndex"
>;

// One job's speaker label: the same voice id in the queue, fetch and assign_speaker.
export const voiceId = (jobId: string, label: string | null) =>
  `${jobId}/${label ?? ""}`;

export const modelKey = (s: Pick<Sample, "modelId" | "modelRevision">) =>
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
      .set({ excerptsAt: clock() })
      .where(eq(transcripts.jobId, jobId))
      .run();
    if (kept.length > 0) {
      logChange(tx, "job", jobId);
    }
  });

// New evidence requires the owner's person assignment of the turn or its speaker.
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

// Per-model profiles from each person's evidence and the strangers' references.
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
    [...new Set([...known.keys(), ...unknown.keys()])].map((model) => {
      const references = exemplarsOf(unknown.get(model) ?? []);
      return [
        model,
        {
          people: [
            ...Map.groupBy(known.get(model) ?? [], (r) => r.personId).values(),
          ].map((clips) => ({
            ...exemplarsOf(clips),
            isOwner: clips[0]?.isOwner ?? false,
            personId: clips[0]?.personId ?? "",
          })),
          strangerConversations: references.conversations,
          strangers: references.exemplars,
        },
      ] as const;
    })
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

export const readProfiles = (db: Db): ProfilesByModel =>
  weighProfiles(evidenceRows(db), strangerRows(db));

// One job's speaker: its turn's own row, else its label's row (turn null).
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

// Turns with their own row belong to that row, never to their label's voice; SQL form: ofItsSpeaker.
export const readOwnTurns = (
  db: Db,
  rows = db.select().from(assignments).all()
) =>
  new Set(
    rows.flatMap((r) =>
      r.turnIndex === null ? [] : [turnRef(r.jobId, r.turnIndex)]
    )
  );

// Same rule as readOwnTurns; explicit identifiers keep SELECT from stripping the outer table.
export const ofItsSpeaker = (
  job: Column,
  turn: Column
) => sql<boolean>`not exists (select 1 from ${assignments} t
  where t.job_id = ${job.table}.${sql.identifier(job.name)}
  and t.turn_index = ${turn.table}.${sql.identifier(turn.name)})`;

const speakerSample = ofItsSpeaker(voiceSamples.jobId, voiceSamples.turnIndex);

// An assignment covers its turn, or its speaker's turns without their own row.
export const coveredByRow = and(
  eq(voiceSamples.jobId, assignments.jobId),
  eq(voiceSamples.speakerLabel, assignments.speakerLabel),
  or(
    eq(voiceSamples.turnIndex, assignments.turnIndex),
    and(isNull(assignments.turnIndex), speakerSample)
  )
);

// isRejected's owner unknown subset supplies negative references; media is expired instead.
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
            speakerSample,
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

// One queue build shares decoded samples and profiles between suggestions, clips and projection.
export function readVoices(db: Db) {
  const profiles = readProfiles(db);
  const kept = new Map<string, Sample[]>();
  const samples = (voices: { jobId: string; speakerLabel: string }[]) => {
    const missing = voices.filter(
      (v) => !kept.has(voiceId(v.jobId, v.speakerLabel))
    );
    const found = Map.groupBy(samplesOf(db, missing), (s) =>
      voiceId(s.jobId, s.speakerLabel)
    );
    for (const v of missing) {
      const key = voiceId(v.jobId, v.speakerLabel);
      kept.set(key, found.get(key) ?? []);
    }
    return [
      ...new Set(voices.map((v) => kept.get(voiceId(v.jobId, v.speakerLabel)))),
    ].flatMap((rows) => rows ?? []);
  };
  return {
    match: (voices: { jobId: string; speakerLabel: string }[]) =>
      match(samples(voices), profiles).personId,
    profiles,
    rank(
      voices: { jobId: string; speakerLabel: string }[],
      personId: string | null
    ) {
      const [model] = [...Map.groupBy(samples(voices), modelKey)].sort(
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
    },
    samples,
  };
}

// One model's samples and their centroid once clean speech reaches minSpeakerSeconds.
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
    .innerJoin(voiceSamples, coveredByRow)
    .where(where)
    .all();
  return [
    ...Map.groupBy(rows, (r) =>
      r.assignment.turnIndex === null
        ? r.assignment.id
        : `${r.assignment.jobId}/${r.assignment.speakerLabel}/${r.assignment.candidateId ?? r.assignment.personId ?? r.assignment.id}`
    ).values(),
  ].flatMap((group) => {
    const { model, vector } = speakerVoice(group.map((g) => g.sample));
    const assignment = group[0]?.assignment;
    return vector && assignment
      ? [
          {
            assignment,
            model,
            rows: [
              ...new Map(
                group.map((g) => [g.assignment.id, g.assignment])
              ).values(),
            ],
            vector,
          },
        ]
      : [];
  });
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
  source: Assignment["source"];
  vector: Vector;
}

// Voices named in the same conversation, from owner answers and direct profile matches only.
// Cached per job for one pass; a nearby-derived name never becomes a reference.
export function nearbyVoices() {
  const kept = new Map<string, NearbyVoice[]>();
  return {
    forget: (jobId: string) => kept.delete(jobId),
    read(db: Db, jobId: string) {
      const holders = holdingConversations(db, jobId);
      const ids =
        holders.length > 0
          ? db
              .selectDistinct({ id: conversationJobs.jobId })
              .from(conversationJobs)
              .where(inArray(conversationJobs.conversationId, holders))
              .all()
              .map((r) => r.id)
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
          source: assignment.source,
          vector,
        });
      }
      return ids.flatMap((id) =>
        (kept.get(id) ?? []).filter((v) => id !== jobId || v.source === "owner")
      );
    },
  };
}
type Nearby = ReturnType<typeof nearbyVoices>;

// Nearby matches keep profile scores/margins, so they never become references (docs/processing.md).
function nameFromNearby(
  db: Db,
  jobId: string,
  results: Recognition[],
  profiles: ProfilesByModel,
  nearby: Nearby
) {
  const missed = results.filter(
    (r): r is Recognition & { vector: Vector } =>
      !(r.personId || r.isStranger) && r.vector !== null
  );
  if (missed.length === 0) {
    return;
  }
  // Freeze direct matches before assigning any nearby names: no chaining within the job.
  const voices = [
    ...nearby.read(db, jobId),
    ...results.flatMap((r) =>
      r.personId &&
      r.vector &&
      r.model &&
      !r.isStranger &&
      (r.score ?? 0) >= RECOGNITION.nearbyReference &&
      (r.margin ?? 0) >= RECOGNITION.margin
        ? [
            {
              model: r.model,
              personId: r.personId,
              source: "recognized" as const,
              vector: r.vector,
            },
          ]
        : []
    ),
  ];
  for (const r of missed) {
    const nearbyPeople = new Set(
      voices.filter((n) => n.model === r.model).map((n) => n.personId)
    );
    r.personId =
      nearbyMatch(
        r.vector,
        (profiles.get(r.model ?? "") ?? NO_PROFILES).people,
        nearbyPeople
      ) ?? nearbyPerson(r, voices);
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
// changed; null without a transcript. `nearby` is the pass's, when it is one of many.
export function recognize(db: Db, jobId: string, nearby = nearbyVoices()) {
  return db.transaction((tx) =>
    recognizeJob(tx, jobId, readProfiles(tx), nearby)
  );
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
    .select({ clean: speakerSample, sample: voiceSamples })
    .from(voiceSamples)
    .where(eq(voiceSamples.jobId, jobId))
    .all();
  const clean = (label: string) =>
    jobSamples.flatMap((s) =>
      s.clean && s.sample.speakerLabel === label ? [s.sample] : []
    );
  const results = [...labels]
    .filter((label) => !answered.some((r) => r.speakerLabel === label))
    .flatMap((label): Recognition[] => {
      const old = before.get(label);
      if (old && !jobSamples.some((s) => s.sample.speakerLabel === label)) {
        return [lastKnown(old)];
      }
      const matched = match(clean(label), profiles);
      const splits = [
        ...Map.groupBy(
          matched.turns.filter((t) => t.voice),
          (t) => t.voice
        ).entries(),
      ];
      return [
        {
          ...matched,
          candidateId: old?.candidateId ?? null,
          label,
          turns: matched.turns.filter((t) => !t.voice),
        },
        ...splits.flatMap(([voice, turns]) =>
          voice
            ? [
                {
                  ...voice,
                  candidateId: randomUUID(),
                  label,
                  model: matched.model,
                  turnIndices: turns.map((t) => t.turnIndex),
                },
              ]
            : []
        ),
      ];
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

// ---- Upkeep -----------------------------------------------------------------

// Matches every live transcript again against today's profiles, then rebuilds the unnamed
// groups. Owner rows are never touched; only rows whose result changes are rewritten.
export async function sweep(db: Db) {
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
  return { changed, jobs: jobs.length, regrouped: await regroup(db) };
}

// The groups of `voices` (one model), each with an id: the one most of its voices already
// had, unless a bigger group took it, else a new one.
async function groupIds(voices: UnnamedVoice[]) {
  const used = new Set<string>();
  const grouped = await averageLinkage(
    voices.map((v) => v.vector),
    RECOGNITION.candidateThreshold
  );
  return grouped
    .filter((indices) => indices.length > 1)
    .map((indices) => {
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
export async function regroup(db: Db) {
  const voices = unnamedVoices(db);
  const wanted = new Map<string, string | null>(
    voices.flatMap((v) =>
      v.rows.map(
        (r) => [r.id, r.turnIndex === null ? null : r.candidateId] as const
      )
    )
  );
  for (const sameModel of Map.groupBy(voices, (v) => v.model).values()) {
    for (const [id, members] of await groupIds(sameModel)) {
      for (const v of members) {
        for (const row of v.rows) {
          wanted.set(row.id, id);
        }
      }
    }
  }
  // A correction or new sample while grouping yielded makes this snapshot obsolete.
  if (!isDeepStrictEqual(voices, unnamedVoices(db))) {
    return 0;
  }
  const changes = voices
    .flatMap((v) => v.rows)
    .filter((r) => r.candidateId !== wanted.get(r.id));
  return db.transaction((tx) => {
    for (const v of changes) {
      const candidateId = wanted.get(v.id) ?? null;
      tx.update(assignments)
        .set({ candidateId, status: candidateId ? "candidate" : "unknown" })
        .where(eq(assignments.id, v.id))
        .run();
    }
    logChange(
      tx,
      "assignment",
      changes.map((v) => v.jobId)
    );
    return changes.length;
  });
}

// Deletes non-evidence embeddings: effective owner media rows now, retired jobs after a day.
// Other samples and recognized labels stay; audio and transcripts are never removed.
export function expire(db: Db) {
  const days = (n: number) => clock().getTime() - n * 86_400_000;
  const removed = db.all<{ id: string }>(sql`
    delete from ${voiceSamples} as s
    where not exists (select 1 from ${voiceProfiles} p where p.sample_id = s.id)
      and (
        (s.created_at < ${days(1)}
          and not exists (select 1 from ${conversationJobs} j where j.job_id = s.job_id))
        or exists (
          select 1 from ${assignments} a
          where a.job_id = s.job_id and a.speaker_label = s.speaker_label
            and a.source = 'owner' and a.status = 'media' and a.candidates is null
            and (a.turn_index = s.turn_index or (a.turn_index is null
              and not exists (select 1 from ${assignments} t
                where t.job_id = s.job_id and t.turn_index = s.turn_index))))
      )
    returning id`);
  return removed.length;
}

const UPKEEP_HOUR = 3;
const AFTER_CORRECTION_MS = 60_000;

// Voice upkeep, guarded so one run at a time: every night after 03:00 in the owner's zone the
// sweep, then expiry; a minute after the owner's last correction, the sweep alone, so a name given
// today reaches old conversations without waiting for the night.
// ponytail: in-process state and timer; assumes one server replica, like the other loops.
export function voiceUpkeep(db: Db) {
  let lastNight = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = Promise.resolve();
  const run = (work: () => Promise<Fields | null>) => {
    running = running.then(async () => {
      try {
        const fields = await work();
        if (fields) {
          record(db, "voices.upkeep", fields);
        }
      } catch (error: unknown) {
        reportError(db, "voice upkeep", error);
      }
    });
    return running;
  };
  return {
    nightly(at = clock()) {
      const { date, hour } = ownerClock(at);
      if (hour < UPKEEP_HOUR || date === lastNight) {
        return null;
      }
      lastNight = date;
      // Once a day across restarts too: a deploy after 03:00 finds the night's event.
      return run(async () =>
        recordedOn(db, "voices.upkeep", date)
          ? null
          : { ...(await sweep(db)), day: date, expired: expire(db) }
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

// Replaces the owner row for a speaker or turn (a second answer of his is `rechecked`) and moves
// that scope's evidence in this transcript to the person (or drops it: several are nobody's).
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
  const previous = tx.select().from(assignments).where(scoped).get();
  tx.delete(assignments).where(scoped).run();
  const [row] = tx
    .insert(assignments)
    .values({
      candidates,
      jobId,
      personId,
      rechecked: previous?.source === "owner",
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
