import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { clock } from "@life/server/src/core/clock";
import type { Db } from "@lifelog/db";
import {
  speakerAssignments as assignments,
  type Candidates,
  conversationJobs,
  people,
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
import { RECOGNITION } from "./config";
import { type NamingInput, parseNamingReadings } from "./inferred-speakers";
import {
  coveredByRow,
  holdingConversations,
  inferredRows,
  keepOwnerWhole,
  lastKnown,
  loadTranscript,
  modelKey,
  type NamingReconciliation,
  type Recognition,
  recognizedRows,
  speakerOf,
  speakerSample,
  unchanged,
  voiceId,
} from "./recognized-rows";
import {
  centroid,
  decide,
  likeness,
  NO_PROFILES,
  nearbyMatch,
  type Profile,
  type Profiles,
} from "./speakers";
import { averageLinkage } from "./voice-linkage";
import { cosine, type Vector } from "./voice-vectors";

type Assignment = typeof assignments.$inferSelect;
type Sample = typeof voiceSamples.$inferSelect;
type VoiceSample = Pick<
  Sample,
  "durationSeconds" | "embedding" | "modelId" | "modelRevision" | "turnIndex"
>;
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

// One exemplar per conversation: the centroid of its clips.
const exemplarsOf = (clips: Clip[]) =>
  [...Map.groupBy(clips, (r) => r.conversationId).values()].map((c) =>
    centroid(c.map((r) => r.embedding))
  );

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

export const readProfiles = (db: Db): ProfilesByModel =>
  weighProfiles(evidenceRows(db), strangerRows(db));

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
                    eq(assignments.source, "recognized"),
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
export function recognizeJob(
  tx: Db,
  jobId: string,
  profiles: ProfilesByModel,
  nearby = nearbyVoices(),
  pass?: NamingReconciliation
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
    (r) =>
      (r.source === "recognized" || r.source === "inferred") &&
      r.turnIndex !== null
  );
  const labels = new Set(
    transcript.parsed.turns.flatMap((t) => t.speakerId ?? [])
  );
  const jobSamples = tx
    .select({
      clean: sql<boolean>`not exists (select 1 from speaker_assignments a
      where a.job_id = ${voiceSamples}.${sql.identifier("job_id")}
      and a.turn_index = ${voiceSamples}.${sql.identifier("turn_index")}
      and a.source != 'inferred')`,
      sample: voiceSamples,
    })
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
    !(pass || kept.some((r) => r.source === "inferred")) &&
    unchanged(results, before) &&
    several.every((v) => v.turns.length === 0)
  ) {
    return false;
  }
  // Inferred turns remain through ordinary sweeps; a stronger voice decision replaces them.
  const decided = recognizedRows(jobId, results, [], several);
  const retained = kept.filter(
    (r) =>
      r.source !== "inferred" ||
      !speakerOf(decided, r.speakerLabel, r.turnIndex)?.personId
  );
  const inferred = retained.filter((r) => r.source === "inferred");
  let values: (typeof assignments.$inferInsert)[] = recognizedRows(
    jobId,
    results,
    retained,
    several
  ).filter(
    (r) =>
      r.source === "inferred" ||
      !inferred.some(
        (old) =>
          old.speakerLabel === r.speakerLabel && old.turnIndex === r.turnIndex
      )
  );
  if (pass) {
    values = inferredRows(jobId, values, rows, pass, (indices) => {
      const samples = jobSamples
        .filter((s) => indices.includes(s.sample.turnIndex))
        .map((s) => s.sample);
      const voice = speakerVoice(samples);
      const known = profiles.get(voice.model) ?? NO_PROFILES;
      return {
        profiles: known,
        result: {
          ...decide(voice, known),
          vector: samples.length
            ? centroid(samples.map((s) => s.embedding))
            : null,
        },
      };
    });
  }
  const shape = (r: typeof assignments.$inferInsert) => ({
    candidateId: r.candidateId ?? null,
    candidates: r.candidates ?? null,
    inference: r.inference ?? null,
    mixed: r.mixed ?? false,
    personId: r.personId ?? null,
    source: r.source,
    speakerLabel: r.speakerLabel,
    status: r.status,
    turnIndex: r.turnIndex ?? null,
  });
  const automatic = rows.filter((r) => !held(r)).map(shape);
  const wanted = values.map(shape);
  const ordered = (r: ReturnType<typeof shape>[]) =>
    r.sort(
      (a, b) =>
        a.speakerLabel.localeCompare(b.speakerLabel) ||
        (a.turnIndex ?? -1) - (b.turnIndex ?? -1)
    );
  if (isDeepStrictEqual(ordered(automatic), ordered(wanted))) {
    return false;
  }
  tx.delete(assignments)
    .where(
      and(
        eq(assignments.jobId, jobId),
        inArray(assignments.source, ["recognized", "inferred"]),
        eq(assignments.mixed, false)
      )
    )
    .run();
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

// No awaited work between this current-input check and the assignment writes.
export function reconcileNaming(
  db: Db,
  pass: Omit<NamingReconciliation, "resolvePerson">,
  readCurrent: (tx: Db) => NamingInput | null,
  resolvePerson: (tx: Db, id: string) => string | null
) {
  return db.transaction((tx) => {
    const current = readCurrent(tx);
    if (
      !current ||
      current.inputHash !== pass.input.inputHash ||
      (current.snapshotRevision !== pass.input.snapshotRevision &&
        current.snapshotHash !== pass.input.snapshotHash)
    ) {
      return false;
    }
    const readings = parseNamingReadings(
      JSON.stringify({ readings: pass.readings }),
      current
    );
    const profiles = readProfiles(tx);
    let changed = false;
    for (const jobId of new Set(current.scopes.map((s) => s.jobId))) {
      changed =
        recognizeJob(tx, jobId, profiles, undefined, {
          ...pass,
          input: current,
          readings,
          resolvePerson: (id) => resolvePerson(tx, id),
        }) === true || changed;
    }
    return changed;
  });
}
