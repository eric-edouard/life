import { clock } from "@life/server/src/core/clock";
import type { Db } from "@lifelog/db";
import {
  conversations,
  intelligenceRuns,
  lifePeopleSnapshot,
  namingAttempts,
  namingRollout,
  people,
  speakerAssignments,
  voiceProfiles,
  voiceSamples,
} from "@lifelog/db/schema";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { NAMING, RECOGNITION } from "./config";
import { reportError } from "./diagnostics";
import {
  boundedNamingInputsOf,
  isNamingGate,
  type NamingInput,
  namingPolicyHashOf,
  namingPromptHash,
  namingWorkHash,
  parseNamingReadings,
  readInferredSpeakers,
  type ScopeReading,
} from "./inferred-speakers";
import { resolveLifePerson } from "./life-people";
import type { MacSocket } from "./mac-socket";
import {
  finishNamingPilot,
  namingPilotPace,
  namingQuota,
  type Rollout,
  rolloutWhere,
} from "./naming-rollout";
import { type NamingWork, namingSelectionOf } from "./naming-selection";
import { assignmentsByJob, speakerOf } from "./people";
import { type ModelReply, macProvider, type Provider } from "./providers";
import { modelKey } from "./recognized-rows";
import { readProfiles, reconcileNaming } from "./speaker-recognition";
import { NO_PROFILES } from "./speakers";
import { subscriptions } from "./subscriptions";
import { loadTurns } from "./transcript";

interface NamingRequest {
  archiveAuthorized?: boolean;
  engine?: string;
  mode: NamingMode;
}

export type NamingMode = "evaluation" | "pilot" | "archive" | "arrivals";
type Attempt = typeof namingAttempts.$inferSelect;
const inputOffsets = new WeakMap<NamingInput, number>();

// An owner/direct-voice name is context, never an inferred or nearby-derived name.
function* readNamingWindows(
  db: Db,
  conversationId: string,
  fromOffset = 0
): Generator<NamingInput | null> {
  const conversation = db
    .select()
    .from(conversations)
    .where(
      and(eq(conversations.id, conversationId), isNull(conversations.retiredAt))
    )
    .get();
  const snapshot = db.select().from(lifePeopleSnapshot).get();
  if (!(conversation && snapshot)) {
    return;
  }
  for (let offset: number | null = fromOffset; offset !== null; ) {
    const currentOffset = offset;
    const view = loadTurns(db, conversationId, {
      limit: NAMING.contextMaxTurns,
      offset,
    });
    offset = view?.nextOffset ?? null;
    const loaded = view?.turns ?? [];
    const jobIds = [...new Set(loaded.map((t) => t.ref.jobId))];
    if (!jobIds.length) {
      yield null;
      continue;
    }
    const refs = loaded.map((t) => `${t.ref.jobId}/${t.ref.turnIndex}`);
    const rows = db
      .select({
        candidates: speakerAssignments.candidates,
        jobId: speakerAssignments.jobId,
        margin: speakerAssignments.margin,
        mixed: speakerAssignments.mixed,
        personId: speakerAssignments.personId,
        score: speakerAssignments.score,
        source: speakerAssignments.source,
        speakerLabel: speakerAssignments.speakerLabel,
        status: speakerAssignments.status,
        turnIndex: speakerAssignments.turnIndex,
      })
      .from(speakerAssignments)
      .where(
        and(
          inArray(speakerAssignments.jobId, jobIds),
          or(
            isNull(speakerAssignments.turnIndex),
            inArray(
              sql`${speakerAssignments.jobId} || '/' || ${speakerAssignments.turnIndex}`,
              refs
            )
          )
        )
      )
      .all();
    const byJob = Map.groupBy(rows, (r) => r.jobId);
    const localPeople = db.select().from(people).all();
    const confirmed = new Set(
      [
        ...db
          .select({ id: speakerAssignments.personId })
          .from(speakerAssignments)
          .where(eq(speakerAssignments.source, "owner"))
          .all(),
        ...db.select({ id: voiceProfiles.personId }).from(voiceProfiles).all(),
      ].flatMap((p) => p.id ?? [])
    );
    const candidates = new Map(
      localPeople
        .filter((p) => p.nameSource === "owner" || confirmed.has(p.id))
        .map((p) => [
          p.id,
          {
            aliases: p.aliases,
            canonicalRef: p.lifeRef ?? `lifelog:${p.id}`,
            name: p.name,
            personId: p.id,
          },
        ])
    );
    for (const p of snapshot.people) {
      const linked = localPeople.find(
        (l) => l.lifeRef === p.ref || l.id === p.personId
      );
      const id = linked?.id ?? `life:${p.ref}`;
      candidates.set(id, {
        aliases: linked?.nameSource === "owner" ? linked.aliases : p.aliases,
        canonicalRef: p.ref,
        name: linked?.name ?? p.name,
        personId: id,
      });
    }
    const profiles = readProfiles(db);
    const samples = db
      .select()
      .from(voiceSamples)
      .where(
        inArray(
          sql`${voiceSamples.jobId} || '/' || ${voiceSamples.turnIndex}`,
          refs
        )
      )
      .all();
    const turns = loaded.flatMap((t) => {
      if (!t.speakerLabel) {
        return [];
      }
      const row = speakerOf(
        byJob.get(t.ref.jobId),
        t.speakerLabel,
        t.ref.turnIndex
      );
      return [
        {
          isDirectMatch:
            row?.source === "recognized" &&
            (row.score ?? 0) >= RECOGNITION.nearbyReference &&
            (row.margin ?? 0) >= RECOGNITION.margin,
          jobId: t.ref.jobId,
          personId: row?.candidates || row?.mixed ? null : row?.personId,
          source: row?.source,
          speakerLabel: t.speakerLabel,
          text: t.text,
          turnIndex: t.ref.turnIndex,
        },
      ];
    });
    // Each unchecked turn is a scope, including turns with no embedding. No label guess fans out.
    const targets = turns.flatMap((t) => {
      const row = speakerOf(byJob.get(t.jobId), t.speakerLabel, t.turnIndex);
      if (
        row &&
        (row.source === "owner" ||
          row.mixed ||
          row.status === "stranger" ||
          row.personId)
      ) {
        return [];
      }
      const sample = samples.find(
        (s) => s.jobId === t.jobId && s.turnIndex === t.turnIndex
      );
      return [
        {
          id: `${t.jobId}/${t.turnIndex}`,
          jobId: t.jobId,
          profiles: sample
            ? (profiles.get(modelKey(sample)) ?? NO_PROFILES)
            : NO_PROFILES,
          speakerLabel: t.speakerLabel,
          turnIndices: [t.turnIndex],
          vector: sample?.embedding ?? null,
        },
      ];
    });
    for (const input of boundedNamingInputsOf({
      conversationId,
      ownerId: localPeople.find((p) => p.isOwner)?.id ?? null,
      people: [...candidates.values()],
      snapshotHash: snapshot.hash,
      snapshotRevision: snapshot.revision,
      targets,
      turns,
    })) {
      inputOffsets.set(input, currentOffset);
      yield input;
    }
    yield null;
  }
}

export function* readNamingInputs(db: Db, conversationId: string) {
  for (const input of readNamingWindows(db, conversationId)) {
    if (input) {
      yield input;
    }
  }
}

export function readNamingInput(
  db: Db,
  conversationId: string,
  inputHash?: string
) {
  for (const input of readNamingInputs(db, conversationId)) {
    if (!inputHash || input.inputHash === inputHash) {
      return input;
    }
  }
  return null;
}

export function readCurrentNamingInput(db: Db, input: NamingInput) {
  const offset = inputOffsets.get(input);
  if (offset === undefined) {
    return null;
  }
  for (const current of readNamingWindows(db, input.conversationId, offset)) {
    if (!current) {
      return null;
    }
    if (current.inputHash === input.inputHash) {
      return current;
    }
  }
  return null;
}

function rolloutStatus(
  request: NamingRequest,
  selected: Provider,
  rollout: Rollout | undefined
) {
  const pilotPassed = rollout?.pilotPassed === true;
  if (
    request.mode !== "evaluation" &&
    !isNamingGate(rollout?.gate, selected.model)
  ) {
    return "gate_required";
  }
  if (
    (request.mode === "archive" || request.mode === "arrivals") &&
    !pilotPassed
  ) {
    return "pilot_required";
  }
  if (request.mode === "archive" && request.archiveAuthorized !== true) {
    return "archive_authorization_required";
  }
  if (
    request.mode === "pilot" &&
    (rollout?.pilotCalls ?? 0) >= NAMING.pilotMaxCalls
  ) {
    return "pilot_complete";
  }
  return null;
}

function keepNamingCall(
  db: Db,
  context: {
    attemptId: string;
    input: NamingInput;
    policyHash: string;
    model: string;
    promptHash: string;
    pilot: boolean;
    usage: ReturnType<typeof namingQuota>;
    started: number;
    callNumber: number;
  },
  reply: ModelReply
) {
  const { attemptId, input, pilot, started, callNumber } = context;
  const latencyMs = Math.round(performance.now() - started);
  let result: unknown = null;
  try {
    result = {
      applied: false,
      readings: parseNamingReadings(reply.text, input),
    };
  } catch {
    // Invalid replies keep their raw call and usage; only usable replies enter the cache.
  }
  const prior = db
    .select()
    .from(namingAttempts)
    .where(eq(namingAttempts.id, attemptId))
    .get();
  const history =
    (
      prior?.call as {
        history?: {
          number: number;
          inputTokens: number;
          outputTokens: number;
          latencyMs: number;
        }[];
      } | null
    )?.history ?? [];
  if (history.some((call) => call.number === callNumber)) {
    return;
  }
  db.update(namingAttempts)
    .set({
      call: {
        ...reply,
        history: [
          ...history,
          {
            completedAt: clock().getTime(),
            inputTokens: reply.inputTokens,
            latencyMs,
            number: callNumber,
            outputTokens: reply.outputTokens,
            pilot,
            valid: result !== null,
          },
        ],
        latencyMs,
      },
      result,
    })
    .where(eq(namingAttempts.id, attemptId))
    .run();
  if (pilot) {
    recordPilotCall(db, context, reply, latencyMs);
  }
}

function recordPilotCall(
  db: Db,
  context: Parameters<typeof keepNamingCall>[1],
  reply: ModelReply,
  latencyMs: number
) {
  const { usage } = context;
  const progress = db
    .select()
    .from(namingRollout)
    .where(rolloutWhere(context))
    .get();
  const usageAfter = subscriptions(db).codex;
  db.update(namingRollout)
    .set({
      inputTokens: (progress?.inputTokens ?? 0) + reply.inputTokens,
      latencyMs: (progress?.latencyMs ?? 0) + latencyMs,
      longWindow: {
        after: usageAfter?.sevenDay,
        before:
          (progress?.longWindow as { before?: unknown } | null)?.before ??
          usage?.sevenDay,
      },
      outputTokens: (progress?.outputTokens ?? 0) + reply.outputTokens,
      shortWindow: {
        after: usageAfter?.fiveHour,
        before:
          (progress?.shortWindow as { before?: unknown } | null)?.before ??
          usage?.fiveHour,
      },
    })
    .where(rolloutWhere(context))
    .run();
}

function finishNamingWork(
  db: Db,
  work: NamingWork,
  attempt: Attempt,
  readings: ScopeReading[],
  mode: NamingMode
) {
  const { input } = work;
  const attemptId = attempt.id;
  let named = readings.some((r) => r.personId !== null);
  db.update(namingAttempts)
    .set({
      error: null,
      nextEligibleAt: new Date(
        clock().getTime() + NAMING.retryBackoffMs * (attempt.attempts + 1)
      ),
      result: { applied: false, readings },
      state: named ? "named" : "abstained",
    })
    .where(eq(namingAttempts.id, attemptId))
    .run();
  if (mode === "archive" || mode === "arrivals") {
    const changed = reconcileNaming(
      db,
      {
        attemptId,
        calibration: NAMING.calibration,
        input,
        readings,
      },
      (tx) => readCurrentNamingInput(tx, input),
      resolveLifePerson
    );
    const rows = assignmentsByJob(
      db,
      input.scopes.map((s) => s.jobId)
    );
    named =
      changed &&
      input.scopes.some((s) =>
        s.turnIndices.some(
          (turn) => speakerOf(rows.get(s.jobId), s.speakerLabel, turn)?.personId
        )
      );
    db.update(namingAttempts)
      .set({
        result: { applied: named, readings },
        state: named ? "named" : "abstained",
      })
      .where(eq(namingAttempts.id, attemptId))
      .run();
  }
  return named ? "named" : "abstained";
}

async function executeNamingWork(
  db: Db,
  mac: Pick<MacSocket, "idle">,
  work: NamingWork,
  selected: Provider,
  request: NamingRequest,
  rollout: Rollout
) {
  const policyHash = namingPolicyHashOf();
  const promptHash = namingPromptHash();
  const cached = (
    work.attempt?.result as { readings?: unknown; applied?: boolean } | null
  )?.readings;
  const { input } = work;
  const isPilotCall = request.mode === "pilot" && !cached;
  const key = namingWorkHash(
    input.inputHash,
    selected.model,
    promptHash,
    policyHash
  );
  let { attempt } = work;
  if (!attempt) {
    attempt =
      db
        .insert(namingAttempts)
        .values({
          conversationId: work.conversationId,
          inputHash: key,
          model: selected.model,
          policyHash,
          promptHash,
          snapshotRevision: input.snapshotRevision,
        })
        .returning()
        .get() ?? null;
  }
  if (!attempt) {
    return "idle";
  }
  // The only admission point. This check and provider.call enqueue synchronously, without an await.
  if (
    !mac.idle() ||
    db
      .select()
      .from(intelligenceRuns)
      .where(eq(intelligenceRuns.state, "running"))
      .get()
  ) {
    return "summaries_first";
  }
  const attemptId = attempt.id;
  const started = performance.now();
  const usage = namingQuota(db);
  db.update(namingAttempts)
    .set({ attempts: attempt.attempts + 1, error: null, state: "running" })
    .where(eq(namingAttempts.id, attemptId))
    .run();
  if (isPilotCall) {
    db.update(namingRollout)
      .set({
        longWindow: rollout.longWindow ?? { before: usage?.sevenDay },
        pilotCalls: rollout.pilotCalls + 1,
        shortWindow: rollout.shortWindow ?? { before: usage?.fiveHour },
      })
      .where(rolloutWhere({ model: selected.model, policyHash, promptHash }))
      .run();
  }
  const keep = (reply: ModelReply) =>
    keepNamingCall(
      db,
      {
        attemptId,
        callNumber: attempt.attempts + 1,
        input,
        model: selected.model,
        pilot: isPilotCall,
        policyHash,
        promptHash,
        started,
        usage,
      },
      reply
    );
  try {
    const readings = cached
      ? parseNamingReadings(JSON.stringify({ readings: cached }), input)
      : (await readInferredSpeakers(selected, input, keep)).readings;
    return finishNamingWork(db, work, attempt, readings, request.mode);
  } catch (error) {
    db.update(namingAttempts)
      .set({
        error: error instanceof Error ? error.message : String(error),
        nextEligibleAt: new Date(
          clock().getTime() + NAMING.retryBackoffMs * (attempt.attempts + 1)
        ),
        state: "failed",
      })
      .where(eq(namingAttempts.id, attemptId))
      .run();
    return "failed";
  }
}

function isNamingPaced(
  db: Db,
  request: NamingRequest,
  rollout: Rollout | undefined
) {
  if (request.mode !== "archive" && request.mode !== "arrivals") {
    return false;
  }
  const pace =
    rollout &&
    namingPilotPace(rollout, clock().getTime(), namingQuota(db) ?? undefined);
  const latest =
    db
      .select({ at: sql<number | null>`max(${namingAttempts.updatedAt})` })
      .from(namingAttempts)
      .where(
        rollout
          ? and(
              eq(namingAttempts.model, rollout.model),
              eq(namingAttempts.promptHash, rollout.promptHash),
              eq(namingAttempts.policyHash, rollout.policyHash)
            )
          : undefined
      )
      .get()?.at ?? 0;
  if (!pace || clock().getTime() - latest < pace) {
    return true;
  }
  return false;
}

// Serialized across simultaneous REST requests, without another transport or polling loop.
export function namingPass(
  db: Db,
  mac: Pick<MacSocket, "able" | "llm" | "idle">,
  provider = macProvider(
    mac,
    () => false,
    () => "codex"
  )
) {
  const readWork = namingSelectionOf(db, readNamingWindows);
  let active: Promise<string> | null = null;
  async function once(request: NamingRequest) {
    if (request.engine !== "codex") {
      return "off";
    }
    const selected = provider.snapshot?.() ?? provider;
    if (
      selected.name !== "codex" ||
      selected.ready?.() === false ||
      !namingQuota(db)
    ) {
      return "paused";
    }
    const policyHash = namingPolicyHashOf();
    const promptHash = namingPromptHash();
    db.insert(namingRollout)
      .values({ model: selected.model, policyHash, promptHash })
      .onConflictDoNothing()
      .run();
    let rollout = db
      .select()
      .from(namingRollout)
      .where(rolloutWhere({ model: selected.model, policyHash, promptHash }))
      .get();
    if (!rollout) {
      return "off";
    }
    if (rollout.pilotCalls === NAMING.pilotMaxCalls && !rollout.pilotPassed) {
      rollout = finishNamingPilot(db, rollout);
    }
    const paused = rolloutStatus(request, selected, rollout);
    if (paused) {
      return paused;
    }
    if (isNamingPaced(db, request, rollout)) {
      return "paced";
    }
    // A prior process died during this work. Count already charged; never spin on it.
    db.update(namingAttempts)
      .set({
        error: "interrupted call",
        nextEligibleAt: new Date(clock().getTime() + NAMING.retryBackoffMs),
        state: "failed",
      })
      .where(eq(namingAttempts.state, "running"))
      .run();
    const writes = request.mode === "archive" || request.mode === "arrivals";
    const work = readWork(
      selected.model,
      rollout.createdAt,
      request.mode,
      writes
    );
    if (!work || work === "advancing") {
      return work ?? "idle";
    }
    return await executeNamingWork(db, mac, work, selected, request, rollout);
  }

  const run = (request: Parameters<typeof once>[0]) => {
    if (active) {
      return Promise.resolve("busy");
    }
    active = once(request).finally(() => {
      active = null;
    });
    return active;
  };
  return {
    run,
    start(request: Parameters<typeof once>[0]) {
      if (active) {
        return "busy";
      }
      run(request).catch((error: unknown) =>
        reportError(db, "naming pass", error)
      );
      return "accepted";
    },
  };
}
