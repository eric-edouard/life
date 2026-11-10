import { createHash } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { sha256Of } from "@life/server/src/core/hash";
import { APP_DATA } from "@life/server/src/core/platform";
import { connect, type Db } from "@lifelog/db";
import {
  conversationJobs,
  conversations,
  lifePeopleSnapshot,
  namingAttempts,
  people,
  speakerAssignments,
  transcriptionJobs,
  voiceProfiles,
  voiceSamples,
} from "@lifelog/db/schema";
import { eq, gt, inArray, or } from "drizzle-orm";
import { NAMING, RECOGNITION } from "../src/config";
import {
  isNamingGate,
  type NamingInput,
  namingPolicyHashOf,
  namingPromptHash,
  namingWorkHash,
  parseNamingReadings,
} from "../src/inferred-speakers";
import {
  canonicalOf,
  readLifePeople,
  resolveLifePerson,
} from "../src/life-people";
import { readNamingInput, readNamingInputs } from "../src/naming-pass";
import { speakerOf } from "../src/people";
import { loadTranscript, voiceId } from "../src/recognized-rows";
import {
  evidenceRows,
  match,
  nearbyVoices,
  type ProfilesByModel,
  readProfiles,
  recognizeJob,
  reconcileNaming,
  strangerRows,
  weighProfiles,
} from "../src/speaker-recognition";
import { likeness, type NamingCalibration } from "../src/speakers";
import { freezeVoiceSnapshot, withFrozenVoiceSnapshot } from "./frozen-voices";
import {
  installNamingGate,
  lowerBoundOf,
  namingCounts,
  namingUnitsOf,
} from "./naming-evaluation";
export type Export = ReturnType<typeof exportVoices> & {
  naming?: FrozenNamingEvaluation;
};
type Sample = Export["samples"][number];
const OUTCOMES = [
  "ownerRight",
  "ownerMissed",
  "otherRight",
  "nobodyRight",
  "falseOwner",
  "wrongPerson",
  "leftUnnamed",
] as const;
type Outcome = (typeof OUTCOMES)[number];
const voiceOf = (s: Sample) => voiceId(s.jobId, s.speakerLabel);

// His answer for a sampled turn, by the one read rule (`speakerOf`): for the turn, else for its
// voice; none when he never answered. A row of several people names a fallback, not who spoke. A
// row without a person is "Not anyone I know" or media (its `status`): nobody he knows.
export function answers(data: Pick<Export, "assignments">) {
  const byJob = Map.groupBy(
    data.assignments.filter((a) => !a.candidates),
    (a) => a.jobId
  );
  return (s: Pick<Sample, "jobId" | "speakerLabel" | "turnIndex">) =>
    speakerOf(byJob.get(s.jobId), s.speakerLabel, s.turnIndex);
}
function outcome(
  owner: string,
  truth: string | null,
  said: string | null
): Outcome {
  if (truth === owner) {
    return said === owner ? "ownerRight" : "ownerMissed";
  }
  if (said === truth) {
    return truth ? "otherRight" : "nobodyRight";
  }
  if (said === owner) {
    return "falseOwner";
  }
  return said ? "wrongPerson" : "leftUnnamed";
}
function scoreVoice(
  owner: string,
  judged: { s: Sample; truth: string | null }[],
  voice: Sample[],
  profiles: ProfilesByModel
) {
  const r = match(voice, profiles);
  const ownerProfile = profiles
    .get(r.model ?? "")
    ?.people.find((p) => p.isOwner);
  const credited = r.personId === owner;
  const holdsHim = judged.some((j) => j.truth === owner);
  return {
    another: holdsHim && judged.some((j) => j.truth !== owner),
    credited,
    holdsHim,
    turns: judged.map(({ s, truth }) => {
      const turn = r.turns.find((t) => t.turnIndex === s.turnIndex);
      return {
        his: truth === owner,
        likeness:
          credited && ownerProfile
            ? likeness(s.embedding, ownerProfile.exemplars)
            : null,
        outcome: outcome(owner, truth, turn ? turn.personId : r.personId),
      };
    }),
  };
}

// Profiles rebuilt without the evidence of the conversations `left` out. A job is judged without any conversation
// its samples were cut in: a sample keeps the conversation it was cut for, and a job's can differ.
export const profilesWithout = (
  { evidence, strangers }: Pick<Export, "evidence" | "strangers">,
  left: Set<string>
) =>
  weighProfiles(
    evidence.filter((e) => !left.has(e.conversationId)),
    strangers.filter((e) => !left.has(e.conversationId))
  );

// Every answered voice, each conversation's against profiles rebuilt without it.
function replay(data: Export) {
  const answerOf = answers(data);
  return [...Map.groupBy(data.samples, (s) => s.jobId).values()].flatMap(
    (inJob) => {
      const profiles = profilesWithout(
        data,
        new Set(inJob.map((s) => s.conversationId))
      );
      return [...Map.groupBy(inJob, voiceOf).values()].flatMap((voice) => {
        const judged = voice.flatMap((s) => {
          const answer = answerOf(s);
          return answer ? [{ s, truth: answer.personId }] : [];
        });
        return judged.length > 0
          ? [scoreVoice(data.owner, judged, voice, profiles)]
          : [];
      });
    }
  );
}
export function evaluate(data: Export) {
  const voices = replay(data);
  const turns = voices.flatMap((v) => v.turns);
  const counts = Object.fromEntries(
    OUTCOMES.map((o) => [o, turns.filter((t) => t.outcome === o).length])
  ) as Record<Outcome, number>;
  const inside = (his: boolean) =>
    turns.flatMap((t) =>
      t.likeness !== null && t.his === his ? [t.likeness] : []
    );
  return {
    clusters: {
      creditedWithAnother: voices.filter((v) => v.another && v.credited).length,
      holdingHim: voices.filter((v) => v.holdsHim).length,
      holdingHimAndAnother: voices.filter((v) => v.another).length,
    },
    counts,
    insideHim: { his: inside(true), others: inside(false) },
    turns: turns.length,
  };
}
export function exportVoices(db: Db) {
  return db.transaction((tx) => {
    const owner = tx.query.people
      .findFirst({
        columns: { id: true },
        where: (p, { eq: is }) => is(p.isOwner, true),
      })
      .sync();
    if (!owner) {
      throw new Error("no owner");
    }
    return {
      assignments: tx
        .select({
          candidates: speakerAssignments.candidates,
          jobId: speakerAssignments.jobId,
          personId: speakerAssignments.personId,
          speakerLabel: speakerAssignments.speakerLabel,
          status: speakerAssignments.status,
          turnIndex: speakerAssignments.turnIndex,
        })
        .from(speakerAssignments)
        .where(eq(speakerAssignments.source, "owner"))
        .all(),
      evidence: evidenceRows(tx),
      owner: owner.id,
      samples: tx
        .select()
        .from(voiceSamples)
        .all()
        .map(({ createdAt: _, ...sample }) => sample),
      strangers: strangerRows(tx),
    };
  });
}
export interface FrozenRecording {
  at: number;
  conversationId: string;
  jobId: string;
  recordingId: string;
}
export interface FrozenNamingCase {
  answers: {
    jobId: string;
    personId: string | null;
    speakerLabel: string;
    turnIndex: number;
  }[];
  archiveHash: string;
  at: number;
  call: ReturnType<typeof frozenNamingCall> | null;
  conversationId: string;
  identityEvidence: { personId: string; at: number; recordingIds: string[] }[];
  inputHash: string | null;
  partition: "calibration" | "held-out";
  recordings: FrozenRecording[];
}
export interface FrozenNamingEvaluation {
  calibration: NamingCalibration;
  cases: FrozenNamingCase[];
  model: string;
  policyHash: string;
  promptHash: string;
  snapshots: Record<string, string>;
}
const hashOf = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const recordingIds = (
  cases: FrozenNamingCase[],
  partition: FrozenNamingCase["partition"]
) => {
  const ids = new Set<string>();
  for (const item of cases.filter((c) => c.partition === partition)) {
    for (const recording of item.recordings.filter(
      (r) => r.conversationId === item.conversationId
    )) {
      ids.add(recording.recordingId);
    }
  }
  return [...ids].sort();
};
function removeNamingLeakage(
  db: Db,
  data: FrozenNamingEvaluation,
  item: FrozenNamingCase
) {
  if (
    !Number.isFinite(item.at) ||
    item.recordings.some((r) => !Number.isFinite(r.at))
  ) {
    throw new Error("recording instants must be finite");
  }
  const actual = readFrozenRecordings(db);
  const conversation = db
    .select()
    .from(conversations)
    .where(eq(conversations.id, item.conversationId))
    .get();
  if (
    conversation?.captureEndedAt.getTime() !== item.at ||
    !isDeepStrictEqual(actual, item.recordings)
  ) {
    throw new Error(
      "recording identity, capture time or conversation provenance mismatch"
    );
  }
  const held = new Set(
    data.cases.flatMap((c) =>
      c.recordings
        .filter((r) => r.conversationId === c.conversationId)
        .map((r) => r.recordingId)
    )
  );
  const identities = new Set(
    item.identityEvidence
      .filter(
        (e) =>
          Number.isFinite(e.at) &&
          e.at <= item.at &&
          e.recordingIds.every((id) => !held.has(id))
      )
      .map((e) => e.personId)
  );
  const recordings = new Map(item.recordings.map((r) => [r.jobId, r]));
  const excluded = new Set(
    item.recordings
      .filter((r) => held.has(r.recordingId) || r.at > item.at)
      .map((r) => r.jobId)
  );
  const futurePeople = new Set(
    db
      .select()
      .from(people)
      .all()
      .filter(
        (p) =>
          p.createdAt.getTime() > item.at ||
          p.updatedAt.getTime() > item.at ||
          !(
            identities.has(p.id) ||
            (p.lifeRef && identities.has(`life:${p.lifeRef}`))
          )
      )
      .map((p) => p.id)
  );
  const samples = db.select().from(voiceSamples).all();
  const unsafeSamples = new Set(
    samples
      .filter(
        (sample) =>
          !recordings.has(sample.jobId) ||
          excluded.has(sample.jobId) ||
          sample.createdAt.getTime() > item.at
      )
      .map((sample) => sample.id)
  );
  db.delete(voiceProfiles)
    .where(
      or(
        inArray(voiceProfiles.sampleId, [...unsafeSamples]),
        inArray(voiceProfiles.personId, [...futurePeople]),
        gt(voiceProfiles.createdAt, new Date(item.at))
      )
    )
    .run();
  for (const row of db.select().from(speakerAssignments).all()) {
    const record = recordings.get(row.jobId);
    if (
      !record ||
      record.at > item.at ||
      row.updatedAt.getTime() > item.at ||
      futurePeople.has(row.personId ?? "") ||
      (excluded.has(row.jobId) && !row.candidates) ||
      row.source === "inferred"
    ) {
      db.delete(speakerAssignments)
        .where(eq(speakerAssignments.id, row.id))
        .run();
    }
  }
  for (const id of futurePeople) {
    db.update(people)
      .set({
        creationSource: "inferred",
        lifeRef: null,
        nameSource: "inferred",
      })
      .where(eq(people.id, id))
      .run();
  }
  const snapshot = db.select().from(lifePeopleSnapshot).get();
  if (!snapshot || snapshot.updatedAt.getTime() > item.at) {
    throw new Error("missing historical candidate snapshot");
  }
  db.update(lifePeopleSnapshot)
    .set({
      people: snapshot.people.filter(
        (p) =>
          identities.has(`life:${p.ref}`) ||
          (p.personId !== null && identities.has(p.personId))
      ),
    })
    .run();
  return samples;
}
// Frozen answers and newly created replay people share their canonical Life identity.
function identitiesOf(
  rows: { id: string; lifeRef: string | null }[],
  snapshot: ReturnType<typeof readLifePeople>
) {
  const links = new Map([
    ...(snapshot?.people ?? []).flatMap((p) =>
      p.personId ? [[p.personId, p.ref] as const] : []
    ),
    ...rows.flatMap((p) => (p.lifeRef ? [[p.id, p.lifeRef] as const] : [])),
  ]);
  return (id: string | null | undefined) => {
    if (!id) {
      return null;
    }
    const ref = links.get(id) ?? (id.startsWith("life:") ? id.slice(5) : null);
    return ref ? `life:${canonicalOf(snapshot?.folds ?? {}, ref)}` : id;
  };
}
function readNamingReplay(
  data: FrozenNamingEvaluation,
  item: FrozenNamingCase & { attemptId?: string },
  isFreezing = false
) {
  return withFrozenVoiceSnapshot(data.snapshots, item.archiveHash, (db) => {
    const originalPeople = db.select().from(people).all();
    const snapshot = readLifePeople(db);
    const samples = removeNamingLeakage(db, data, item);
    const profiles = readProfiles(db);
    const nearby = nearbyVoices();
    const jobs = [
      ...new Set(
        item.recordings
          .filter((r) => r.conversationId === item.conversationId)
          .map((r) => r.jobId)
      ),
    ].sort();
    if (!jobs.length || item.answers.some((a) => !jobs.includes(a.jobId))) {
      throw new Error("answer without recording provenance");
    }
    for (const jobId of jobs) {
      recognizeJob(db, jobId, profiles, nearby);
    }
    const rowsBefore = db
      .select()
      .from(speakerAssignments)
      .where(inArray(speakerAssignments.jobId, jobs))
      .all();
    const attempt = item.attemptId
      ? db
          .select()
          .from(namingAttempts)
          .where(eq(namingAttempts.id, item.attemptId))
          .get()
      : null;
    const input =
      [...readNamingInputs(db, item.conversationId)].find((candidate) =>
        isFreezing
          ? !attempt ||
            namingWorkHash(candidate.inputHash, data.model) ===
              attempt.inputHash
          : candidate.inputHash === item.inputHash
      ) ?? null;
    if (
      !isFreezing &&
      ((input?.inputHash ?? null) !== item.inputHash || (input && !item.call))
    ) {
      throw new Error("input hash mismatch or missing call provenance");
    }
    if (input && item.call !== null) {
      const call = frozenNamingCall(
        db,
        data,
        item.conversationId,
        input,
        item.call.attemptId
      );
      if (!isDeepStrictEqual(call, item.call)) {
        throw new Error("cached naming call provenance mismatch");
      }
      const readings = parseNamingReadings(item.call.raw, input);
      reconcileNaming(
        db,
        {
          attemptId: "frozen-replay",
          calibration: data.calibration,
          input,
          readings,
        },
        (tx) => readNamingInput(tx, item.conversationId, input.inputHash),
        resolveLifePerson
      );
    }
    const rowsAfter = db
      .select()
      .from(speakerAssignments)
      .where(inArray(speakerAssignments.jobId, jobs))
      .all();
    const identityOf = identitiesOf(
      [...originalPeople, ...db.select().from(people).all()],
      snapshot
    );
    return {
      input,
      rows: item.answers.map((a) => {
        const before = speakerOf(
          rowsBefore.filter((r) => r.jobId === a.jobId),
          a.speakerLabel,
          a.turnIndex
        );
        const after = speakerOf(
          rowsAfter.filter((r) => r.jobId === a.jobId),
          a.speakerLabel,
          a.turnIndex
        );
        const sample = samples.find(
          (v) => v.jobId === a.jobId && v.turnIndex === a.turnIndex
        );
        const parsed = loadTranscript(db, a.jobId)?.parsed.turns[a.turnIndex];
        return {
          baselineCorrect:
            identityOf(before?.personId) === identityOf(a.personId),
          baselinePrediction: before?.personId ?? null,
          callId: item.call?.inputHash ?? null,
          context: after?.source === "inferred" && !before?.personId,
          contextOnly: !sample,
          correct: identityOf(after?.personId) === identityOf(a.personId),
          group: item.answers
            .filter((other) => other.jobId === a.jobId)
            .some((other) => other.personId !== a.personId),
          potentialContext: !before?.personId,
          prediction: after?.personId ?? null,
          recordingId:
            item.recordings.find((r) => r.jobId === a.jobId)?.recordingId ?? "",
          short:
            !!parsed &&
            parsed.end - parsed.start < RECOGNITION.shortTurnSeconds,
        };
      }),
    };
  });
}
function frozenNamingCall(
  db: Db,
  data: Omit<FrozenNamingEvaluation, "cases">,
  conversationId: string,
  input: NamingInput | null,
  attemptId: string
) {
  const cached = db
    .select()
    .from(namingAttempts)
    .where(eq(namingAttempts.id, attemptId))
    .get();
  const raw = (cached?.call as { text?: string } | null)?.text;
  if (
    cached === undefined ||
    cached.engine !== "codex" ||
    !input ||
    !raw ||
    cached.conversationId !== conversationId ||
    cached.model !== data.model ||
    cached.promptHash !== data.promptHash ||
    cached.policyHash !== data.policyHash ||
    cached.inputHash !== namingWorkHash(input.inputHash, data.model)
  ) {
    throw new Error("cached naming call provenance mismatch");
  }
  return {
    attemptId: cached.id,
    inputHash: cached.inputHash,
    model: cached.model,
    policyHash: cached.policyHash,
    promptHash: cached.promptHash,
    raw,
    snapshotHash: input.snapshotHash,
    snapshotRevision: cached.snapshotRevision,
  };
}
export function readFrozenRecordings(db: Db): FrozenRecording[] {
  return db
    .select({
      at: transcriptionJobs.captureEnd,
      conversationId: conversationJobs.conversationId,
      jobId: transcriptionJobs.id,
      recordingId: transcriptionJobs.audioSha256,
    })
    .from(conversationJobs)
    .innerJoin(
      transcriptionJobs,
      eq(transcriptionJobs.id, conversationJobs.jobId)
    )
    .orderBy(conversationJobs.jobId, conversationJobs.conversationId)
    .all()
    .flatMap((r) => (r.at ? [{ ...r, at: r.at.getTime() }] : []));
}
export function freezeNamingCase(
  db: ReturnType<typeof connect>,
  data: Omit<FrozenNamingEvaluation, "cases"> & { cases?: FrozenNamingCase[] },
  item: Omit<
    FrozenNamingCase,
    "archiveHash" | "inputHash" | "call" | "recordings"
  > & {
    attemptId?: string;
    archiveHash?: string;
  }
) {
  const archiveHash =
    item.archiveHash ?? freezeVoiceSnapshot(db, data.snapshots);
  const frozen = {
    ...item,
    archiveHash,
    call: null,
    inputHash: null,
    recordings: readFrozenRecordings(db),
  };
  const prepared = readNamingReplay(
    { ...data, cases: [...(data.cases ?? []), frozen] },
    frozen,
    true
  );
  return {
    ...frozen,
    call: item.attemptId
      ? frozenNamingCall(
          db,
          data,
          item.conversationId,
          prepared.input,
          item.attemptId
        )
      : null,
    input: prepared.input,
    inputHash: prepared.input?.inputHash ?? null,
  };
}
type NamingScoreRow = ReturnType<typeof readNamingReplay>["rows"][number];
function readNamingRows(data: FrozenNamingEvaluation, reasons: string[]) {
  const rows: NamingScoreRow[] = [];
  const inputHashes: string[] = [];
  for (const item of data.cases.filter((c) => c.partition === "held-out")) {
    try {
      const replayed = readNamingReplay(data, item);
      rows.push(...replayed.rows);
      if (item.call) {
        inputHashes.push(item.call.inputHash);
      }
    } catch (error) {
      reasons.push(
        `${item.conversationId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return { inputHashes, rows };
}
export function readNamingEvaluation(data: FrozenNamingEvaluation) {
  const reasons: string[] = [];
  const calibrationRecordingIds = recordingIds(data.cases, "calibration");
  const heldOutRecordingIds = recordingIds(data.cases, "held-out");
  const calibrationConversations = new Set(
    data.cases
      .filter((c) => c.partition === "calibration")
      .map((c) => c.conversationId)
  );
  if (
    calibrationRecordingIds.some((id) => heldOutRecordingIds.includes(id)) ||
    data.cases.some(
      (c) =>
        c.partition === "held-out" &&
        calibrationConversations.has(c.conversationId)
    )
  ) {
    reasons.push(
      "calibration and held-out recordings or conversations overlap"
    );
  }
  if (!(calibrationRecordingIds.length && heldOutRecordingIds.length)) {
    reasons.push("both independent partitions are required");
  }
  if (
    data.promptHash !== namingPromptHash() ||
    data.policyHash !== namingPolicyHashOf() ||
    hashOf(data.calibration) !== hashOf(NAMING.calibration)
  ) {
    reasons.push("model policy, prompt or calibrated cutoffs differ");
  }
  const { rows, inputHashes } = readNamingRows(data, reasons);
  const overall = namingCounts(rows);
  const addedContext = namingCounts(
    rows
      .filter((r) => r.potentialContext)
      .map((r) => ({ ...r, prediction: r.context ? r.prediction : null }))
  );
  const independent = namingUnitsOf(rows);
  const contextIndependent = namingUnitsOf(rows.filter((r) => r.context));
  const lowerBound = lowerBoundOf(
    overall,
    independent.recordings,
    independent.calls
  );
  const contextLowerBound = lowerBoundOf(
    addedContext,
    contextIndependent.recordings,
    contextIndependent.calls
  );
  const receipt = {
    calibration: data.calibration,
    calibrationRecordingIds,
    callPredictions: independent.calls.predictions,
    contextCallPredictions: contextIndependent.calls.predictions,
    contextCorrect: addedContext.correct,
    contextLowerBound,
    contextPredictions: addedContext.predictions,
    contextRecordingPredictions: contextIndependent.recordings.predictions,
    correct: overall.correct,
    datasetHash: hashOf(data),
    heldOutRecordingIds,
    inputHashes: [...new Set(inputHashes)].sort(),
    lowerBound,
    model: data.model,
    passed: reasons.length === 0,
    policyHash: data.policyHash,
    precision: overall.precision,
    predictions: overall.predictions,
    promptHash: data.promptHash,
    recordingPredictions: independent.recordings.predictions,
  };
  if (!isNamingGate(receipt, data.model)) {
    reasons.push("insufficient held-out precision or predictions");
  }
  receipt.passed = reasons.length === 0;

  return {
    addedContext,
    baseline: namingCounts(
      rows.map((r) => ({
        ...r,
        correct: r.baselineCorrect,
        prediction: r.baselinePrediction,
      }))
    ),
    contextIndependent,
    independent,
    overall,
    reasons,
    receipt,
    strata: {
      contextOnly: namingCounts(rows.filter((r) => r.contextOnly)),
      group: namingCounts(rows.filter((r) => r.group)),
      short: namingCounts(rows.filter((r) => r.short)),
    },
  };
}
const ANSWERED = join(APP_DATA, "lifelog", "answered-voices.json");
const BASELINE = `${import.meta.dir}/../fixtures/voice-eval-baseline.json`;
if (import.meta.main) {
  if (Bun.argv.includes("export")) {
    const url = process.env.DATABASE_PATH;
    if (!url) {
      throw new Error("DATABASE_PATH is not set");
    }
    await Bun.write(
      ANSWERED,
      JSON.stringify(exportVoices(connect(url, { readonly: true })))
    );
  }
  if (!(await Bun.file(ANSWERED).exists())) {
    console.log(`voice eval: skipped, no ${ANSWERED}`);
    process.exit(0);
  }
  const answered = await sha256Of(ANSWERED);
  const frozen: Export = await Bun.file(ANSWERED).json();
  if (Bun.argv.includes("--naming")) {
    if (!frozen.naming) {
      throw new Error("no frozen naming corpus; model reads use naming-pass");
    }
    const report = readNamingEvaluation(frozen.naming);
    console.log(JSON.stringify(report, null, 2));
    if (Bun.argv.includes("--install")) {
      await installNamingGate(report.receipt);
    }
    process.exit(
      Bun.argv.includes("--check") && !report.receipt.passed ? 1 : 0
    );
  }
  const { clusters, counts, insideHim, turns } = evaluate(frozen);
  const result = { answered, clusters, counts, turns };
  if (Bun.argv.includes("--check")) {
    const baseline = await Bun.file(BASELINE).json();
    if (baseline.answered !== answered) {
      console.log(
        "voice eval: skipped, the baseline was made from other answers"
      );
    } else if (JSON.stringify(baseline) !== JSON.stringify(result)) {
      console.error(
        `voice eval: the replay moved; run eval:voices to rewrite the baseline\nbefore ${JSON.stringify(baseline)}\nafter  ${JSON.stringify(result)}`
      );
      process.exit(1);
    }
    process.exit(0);
  }
  await Bun.write(BASELINE, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ clusters, counts, turns }, null, 2));
  console.log("his likeness inside his voices, 10/25/50/75/90%:");
  for (const [label, values] of [
    ["his turns", insideHim.his],
    ["others'", insideHim.others],
  ] as const) {
    const sorted = values.toSorted((a, b) => a - b);
    const quantiles = [0.1, 0.25, 0.5, 0.75, 0.9].map((q) =>
      (sorted[Math.floor(q * (sorted.length - 1))] ?? Number.NaN).toFixed(2)
    );
    console.log(`  ${label} (${values.length})`, quantiles.join(" "));
  }
}
