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
import { and, eq, gte, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { NAMING, RECOGNITION } from "./config";
import { reportError } from "./diagnostics";
import {
  boundNamingInputs,
  isNamingGate,
  type NamingInput,
  namingBacklogClass,
  namingPolicyHash,
  namingPromptHash,
  namingWorkHash,
  parseNamingReadings,
  readInferredSpeakers,
  type ScopeReading,
} from "./inferred-speakers";
import { resolveLifePerson } from "./life-people";
import type { MacSocket } from "./mac-socket";
import { assignmentsByJob, speakerOf, uncleanTurn } from "./people";
import { type ModelReply, macProvider, type Provider } from "./providers";
import { loadTranscript, modelKey } from "./recognized-rows";
import { readProfiles, reconcileNaming } from "./speaker-recognition";
import { NO_PROFILES } from "./speakers";
import { subscriptions } from "./subscriptions";
import { loadTurns } from "./transcript";

interface NamingRequest {
  archiveAuthorized?: boolean;
  engine?: string;
  mode: NamingMode;
}
type Rollout = typeof namingRollout.$inferSelect;
export type NamingMode = "evaluation" | "pilot" | "archive" | "arrivals";
type Attempt = typeof namingAttempts.$inferSelect;
export interface NamingWork {
  arrivedAt: number;
  attempt: Attempt | null;
  backlogClass: number;
  conversationId: string;
  input: NamingInput;
  isFresh: boolean;
}

// An owner/direct-voice name is context, never an inferred or nearby-derived name.
export function readNamingInputs(
  db: Db,
  conversationId: string
): NamingInput[] {
  const conversation = db
    .select()
    .from(conversations)
    .where(
      and(eq(conversations.id, conversationId), isNull(conversations.retiredAt))
    )
    .get();
  const snapshot = db.select().from(lifePeopleSnapshot).get();
  if (!(conversation && snapshot)) {
    return [];
  }
  const loaded = loadTurns(db, conversationId)?.turns ?? [];
  const jobIds = [...new Set(loaded.map((t) => t.ref.jobId))];
  if (!jobIds.length) {
    return [];
  }
  const rows = db
    .select()
    .from(speakerAssignments)
    .where(inArray(speakerAssignments.jobId, jobIds))
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
    .where(inArray(voiceSamples.jobId, jobIds))
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
    const parsed = loadTranscript(db, t.jobId)?.parsed;
    return [
      {
        candidates: row?.candidates,
        clean: !!parsed && uncleanTurn(parsed, t.turnIndex) === null,
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
  if (!targets.length) {
    return [];
  }
  return boundNamingInputs({
    conversationId,
    people: [...candidates.values()],
    snapshotHash: snapshot.hash,
    snapshotRevision: snapshot.revision,
    targets,
    turns,
  });
}

export function readNamingInput(
  db: Db,
  conversationId: string,
  inputHash?: string
) {
  return (
    readNamingInputs(db, conversationId).find(
      (input) => !inputHash || input.inputHash === inputHash
    ) ?? null
  );
}

export function selectNamingWork(
  work: NamingWork[],
  now = clock().getTime(),
  writes = false
) {
  return (
    work
      .filter(
        (w) =>
          !w.attempt ||
          (writes &&
            w.attempt.state === "named" &&
            !(w.attempt.result as { applied?: boolean } | null)?.applied) ||
          ((w.attempt.state === "failed" ||
            w.attempt.state === "abstained" ||
            w.attempt.state === "queued") &&
            w.attempt.attempts < NAMING.retryMaxAttempts &&
            (!w.attempt.nextEligibleAt ||
              w.attempt.nextEligibleAt.getTime() <= now))
      )
      .sort(
        (a, b) =>
          Number(!a.isFresh) - Number(!b.isFresh) ||
          (a.isFresh && b.isFresh ? 0 : a.backlogClass - b.backlogClass) ||
          b.arrivedAt - a.arrivedAt ||
          a.conversationId.localeCompare(b.conversationId)
      )[0] ?? null
  );
}

export function namingQuota(db: Db, now = clock().getTime()) {
  const usage = subscriptions(db).codex;
  if (
    !usage ||
    now / 1000 < usage.observedAt ||
    now - usage.observedAt * 1000 > NAMING.quotaMaxAgeMs
  ) {
    return null;
  }
  return [usage.fiveHour, usage.sevenDay].every(
    (window) =>
      window &&
      window.resetsAt * 1000 > now &&
      window.usedPercent < NAMING.quotaMaxPercent
  )
    ? usage
    : null;
}

function workFor(
  db: Db,
  provider: Provider,
  startedAt: Date,
  mode: NamingMode
) {
  const attempts = db.select().from(namingAttempts).all();
  return db
    .select()
    .from(conversations)
    .where(
      and(
        isNull(conversations.retiredAt),
        mode === "arrivals"
          ? gte(conversations.createdAt, startedAt)
          : undefined
      )
    )
    .all()
    .flatMap((c): NamingWork[] => {
      let inputs: NamingInput[];
      try {
        inputs = readNamingInputs(db, c.id);
      } catch {
        return [];
      }
      return inputs.map((input) => ({
        arrivedAt: c.createdAt.getTime(),
        attempt:
          attempts.find(
            (a) =>
              a.conversationId === c.id &&
              a.inputHash === namingWorkHash(input.inputHash, provider.model)
          ) ?? null,
        backlogClass: namingBacklogClass(input),
        conversationId: c.id,
        input,
        isFresh:
          c.createdAt >= startedAt &&
          !attempts.some((a) => a.conversationId === c.id),
      }));
    });
}

// Only an offline scorer's bound receipt may open the gate; this never runs a measurement.
export function storeNamingGate(db: Db, receipt: unknown, model: string) {
  if (!isNamingGate(receipt, model)) {
    throw new Error("insufficient or mismatched naming gate");
  }
  const policyHash = namingPolicyHash();
  db.insert(namingRollout)
    .values({
      gate: receipt,
      model,
      policyHash,
      promptHash: namingPromptHash(),
    })
    .onConflictDoUpdate({
      set: { gate: receipt },
      target: namingRollout.policyHash,
    })
    .run();
}

// Both measured subscription windows constrain sustainable archive throughput.
export function namingPilotPace(rollout: Rollout, now = clock().getTime()) {
  if (
    rollout.pilotCalls !== NAMING.pilotMaxCalls ||
    !rollout.inputTokens ||
    !rollout.latencyMs
  ) {
    return null;
  }
  let pace = rollout.latencyMs / rollout.pilotCalls;
  for (const raw of [rollout.shortWindow, rollout.longWindow]) {
    const pair = z
      .object({
        after: z.object({ resetsAt: z.number(), usedPercent: z.number() }),
        before: z.object({ resetsAt: z.number(), usedPercent: z.number() }),
      })
      .safeParse(raw).data;
    if (
      !pair ||
      pair.before.resetsAt !== pair.after.resetsAt ||
      pair.after.resetsAt * 1000 <= now ||
      pair.after.usedPercent <= pair.before.usedPercent ||
      pair.after.usedPercent >= NAMING.quotaMaxPercent
    ) {
      return null;
    }
    pace = Math.max(
      pace,
      ((pair.after.resetsAt * 1000 - now) *
        (pair.after.usedPercent - pair.before.usedPercent)) /
        (rollout.pilotCalls * (NAMING.quotaMaxPercent - pair.after.usedPercent))
    );
  }
  return pace;
}
function finishNamingPilot(db: Db, rollout: Rollout) {
  const usage = namingQuota(db);
  if (!usage) {
    return rollout;
  }
  const updated = {
    ...rollout,
    longWindow: { ...(rollout.longWindow as object), after: usage.sevenDay },
    shortWindow: { ...(rollout.shortWindow as object), after: usage.fiveHour },
  };
  const calls = db
    .select()
    .from(namingAttempts)
    .where(eq(namingAttempts.policyHash, rollout.policyHash))
    .all()
    .flatMap(
      (a) =>
        (a.call as { history?: { pilot: boolean; valid: boolean }[] } | null)
          ?.history ?? []
    )
    .filter((c) => c.pilot);
  updated.pilotPassed =
    calls.length === NAMING.pilotMaxCalls &&
    calls.some((c) => c.valid) &&
    namingPilotPace(updated) !== null;
  db.update(namingRollout)
    .set({
      longWindow: updated.longWindow,
      pilotPassed: updated.pilotPassed,
      shortWindow: updated.shortWindow,
    })
    .where(eq(namingRollout.policyHash, rollout.policyHash))
    .run();
  return updated;
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
  const { policyHash, usage } = context;
  const progress = db
    .select()
    .from(namingRollout)
    .where(eq(namingRollout.policyHash, policyHash))
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
    .where(eq(namingRollout.policyHash, policyHash))
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
      { attemptId, calibration: NAMING.calibration, input, readings },
      (tx) => readNamingInput(tx, work.conversationId, input.inputHash),
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
  const policyHash = namingPolicyHash();
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
      .where(eq(namingRollout.policyHash, policyHash))
      .run();
  }
  const keep = (reply: ModelReply) =>
    keepNamingCall(
      db,
      {
        attemptId,
        callNumber: attempt.attempts + 1,
        input,
        pilot: isPilotCall,
        policyHash,
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
  const pace = rollout && namingPilotPace(rollout);
  const latest = db
    .select()
    .from(namingAttempts)
    .all()
    .reduce((at, a) => Math.max(at, a.updatedAt.getTime()), 0);
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
    const policyHash = namingPolicyHash();
    const promptHash = namingPromptHash();
    db.insert(namingRollout)
      .values({ model: selected.model, policyHash, promptHash })
      .onConflictDoNothing()
      .run();
    let rollout = db
      .select()
      .from(namingRollout)
      .where(eq(namingRollout.policyHash, policyHash))
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
    const running = db
      .select()
      .from(namingAttempts)
      .where(eq(namingAttempts.state, "running"))
      .all();
    for (const a of running) {
      db.update(namingAttempts)
        .set({
          error: "interrupted call",
          nextEligibleAt: new Date(clock().getTime() + NAMING.retryBackoffMs),
          state: "failed",
        })
        .where(eq(namingAttempts.id, a.id))
        .run();
    }
    const writes = request.mode === "archive" || request.mode === "arrivals";
    const work = selectNamingWork(
      workFor(db, selected, rollout.createdAt, request.mode),
      clock().getTime(),
      writes
    );
    if (!work) {
      return "idle";
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
export type NamingPass = ReturnType<typeof namingPass>;
