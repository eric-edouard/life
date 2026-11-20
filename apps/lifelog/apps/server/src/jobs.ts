// The transcription jobs: one worker that sends them to ElevenLabs, or to the speech service with
// Scribe for the turns it routes (after the cutter made them), and what comes back. A job's audio
// is in the bucket (audio-store.ts) before the job exists, and every send reads it from there, so a
// retry never needs the phone. ElevenLabs keeps its own copy under its retention policy.

import { clock } from "@life/server/src/core/clock";
import type { Db } from "@lifelog/db";
import {
  transcriptionJobs as jobs,
  transcripts,
  UNTIL_CREDITS,
  waitsForCredits,
} from "@lifelog/db/schema";
import { and, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core";
import type { z } from "zod";
import { emailOwner } from "./alert";
import type { AudioStore } from "./audio-store";
import { logChange } from "./change-log";
import { type Config, singleFlight } from "./config";
import { cut, touchesQuiet, withdrawJob } from "./cutter";
import { ownerZoneAt, reportError } from "./diagnostics";
import {
  credits,
  failureReason,
  fetchTranscript,
  isTranscript,
  PARSER_VERSION,
  parseTranscript,
  QUICK_TIMEOUT_MS,
  type SubmitOutcome,
  safeJson,
  submit,
  WebhookEvent,
  webhookMetadata,
} from "./elevenlabs";
import { record } from "./events";
import { markDirty, regroupAfterCommit } from "./grouping";
import { hearRouted } from "./hear-routed";
import { type MacSocket, macSocket } from "./mac-socket";
import { barOf, type Route, routeTurns } from "./route-turns";
import {
  atScribe,
  LOST_AFTER_MS,
  type Priority,
  type Release,
  scribeSlots,
} from "./scribe-slots";
import {
  SPEECH_TIMEOUT_MS,
  speechServiceSet,
  transcribeBlock,
} from "./speech-service";
import { switches } from "./switches";
import { rebuildTurnsIn } from "./turns";

export type Job = typeof jobs.$inferSelect;

export const getJob = (db: Db, id: string) =>
  db.query.transcriptionJobs.findFirst({ where: eq(jobs.id, id) }).sync();

// One send of a job: the row as it was read, `requestSentAt` set when it left (`claim`).
type Send = Pick<Job, "attempts" | "id" | "requestSentAt">;

// The one way a submitted job changes: only while it is still the send that was read, so a stale
// reader (a reconcile that read before a retry, a late webhook) never moves a newer
// send; the feed hears of it. False when the job had moved on.
function onSend(db: Db, send: Send, set: SQLiteUpdateSetSource<typeof jobs>) {
  return db.transaction((tx) => {
    const moved = tx
      .update(jobs)
      .set(set)
      .where(
        and(
          eq(jobs.id, send.id),
          eq(jobs.state, "submitted"),
          send.requestSentAt
            ? eq(jobs.requestSentAt, send.requestSentAt)
            : isNull(jobs.requestSentAt)
        )
      )
      .returning({ id: jobs.id })
      .get();
    if (moved) {
      logChange(tx, "job", send.id);
    }
    return Boolean(moved);
  });
}

// Not sent after all (ElevenLabs busy, the bucket unreachable): queued again, not an attempt.
const BUSY_RETRY_MINUTES = 1;
const back = (db: Db, send: Send, error: string | null) =>
  onSend(db, send, {
    error,
    nextAttemptAt: new Date(clock().getTime() + BUSY_RETRY_MINUTES * 60_000),
    requestSentAt: null,
    state: "queued",
  });

// Never sent again: ElevenLabs refused this audio, the bucket lost it, a send that may have been
// billed was never answered or reported failed, or every attempt failed. Its pages stay with the
// job (`holderOf`), so nothing buys them again.
const fail = (db: Db, send: Send, error: string) =>
  onSend(db, send, { error, state: "failed" });

// A send that surely bought nothing (lost by ElevenLabs, a failure it reported) goes again, from
// the bucket, after 1 then 2 minutes; the third such failure fails it, so a failure that repeats
// never loops. Its provider ids are cleared, so nothing about the earlier send is taken for the next
// one's.
const MAX_ATTEMPTS = 3;
function retry(db: Db, send: Send, error: string) {
  const attempts = send.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    return onSend(db, send, {
      attempts,
      error: `${error} (${attempts} attempts: not sent again)`,
      state: "failed",
    })
      ? ("failed" as const)
      : null;
  }
  return onSend(db, send, {
    attempts,
    error,
    nextAttemptAt: new Date(clock().getTime() + 2 ** send.attempts * 60_000),
    providerRequestId: null,
    providerTranscriptionId: null,
    requestSentAt: null,
    state: "queued",
  })
    ? ("retried" as const)
    : null;
}

interface ProviderMatch {
  // The send the webhook answers (`attempts` when it went), absent from sends before it was kept.
  attempt?: number | null;
  jobId?: string | null;
  requestId?: string | undefined;
}

const findJob = (db: Db, match: ProviderMatch) =>
  (match.requestId
    ? db.query.transcriptionJobs
        .findFirst({
          where: eq(jobs.providerRequestId, match.requestId),
        })
        .sync()
    : undefined) ?? (match.jobId ? getJob(db, match.jobId) : undefined);

const NO_WORDS = { language_code: "und", language_probability: 0, words: [] };

// What follows a stored transcript beyond its words and grouping (services.ts: the voices read,
// the phone's push, waiting reasons). Not awaited: a failure there is logged and left to the
// 5-minute sweeps.
export type OnCompleted = (job: Job) => Promise<void>;

// Stores a provider transcript once, from whichever path brings it (the send's answer, a webhook,
// reconcile), with its turns in the same transaction, then its source's grouping and
// `onCompleted`. Replays find the job already completed and change nothing. A transcript also
// completes a failed job: it was bought.
function complete(
  db: Db,
  match: ProviderMatch,
  raw: unknown,
  onCompleted: OnCompleted
): "applied" | "duplicate" | "unknown_job" {
  const { transcript, transcriptionId } = parseTranscript(raw);
  const job = findJob(db, match);
  if (!job) {
    return "unknown_job";
  }
  const outcome = db.transaction((tx) => {
    const updated = tx
      .update(jobs)
      .set({
        completedAt: clock(),
        error: null,
        providerRequestId: sql`coalesce(${jobs.providerRequestId}, ${match.requestId ?? null})`,
        providerTranscriptionId: sql`coalesce(${jobs.providerTranscriptionId}, ${transcriptionId})`,
        state: "completed",
      })
      .where(and(eq(jobs.id, job.id), ne(jobs.state, "completed")))
      .returning({ id: jobs.id })
      .get();
    if (!updated) {
      return "duplicate" as const;
    }
    tx.insert(transcripts)
      .values({
        jobId: job.id,
        languageCode: transcript.languageCode,
        parsed: transcript,
        parserVersion: PARSER_VERSION,
        raw,
      })
      .run();
    if (job.sourceId && job.captureStart && job.captureEnd) {
      markDirty(tx, [job.sourceId], [job.captureStart, job.captureEnd]);
    }
    rebuildTurnsIn(tx, job.id);
    logChange(tx, "job", job.id);
    return "applied" as const;
  });
  if (outcome === "applied") {
    // Its words landed: the range marked dirty above is regrouped once committed.
    if (job.sourceId) {
      regroupAfterCommit(db, [job.sourceId]);
    }
    onCompleted(job).catch((error: unknown) =>
      reportError(db, "after a transcript", error)
    );
  }
  return outcome;
}

// A callback without a usable transcript. A reported failure of the job's current send is an
// attempt; one of an earlier send (its `attempt` is not the job's) changes nothing, so a late
// failure never sends again a job already back at ElevenLabs. A send that may have been billed is
// never sent again: its failure fails it.
function noTranscript(db: Db, match: ProviderMatch, failed: string | null) {
  const job = findJob(db, match);
  if (!job) {
    return "unknown_job";
  }
  if (!failed) {
    return "kept";
  }
  if (typeof match.attempt === "number" && match.attempt !== job.attempts) {
    return "stale";
  }
  if (job.maybeBilled) {
    return fail(db, job, failed) ? "failed" : "duplicate";
  }
  return retry(db, job, failed) ?? "duplicate";
}

// A webhook naming no job, recorded by its type and field names only, never its content.
function ignore(db: Db, payload: unknown, type: string | null) {
  const fields = (value: unknown) =>
    value && typeof value === "object"
      ? Object.keys(value).sort().join(",")
      : null;
  record(db, "elevenlabs.webhook", {
    dataFields: fields((payload as { data?: unknown } | null)?.data),
    fields: fields(payload),
    result: "ignored",
    type,
  });
  return { jobId: null, result: "ignored" as const };
}

// What a webhook says went wrong, or null when it doesn't say it failed.
function failureOf(data: NonNullable<z.infer<typeof WebhookEvent>["data"]>) {
  const reason = failureReason(data);
  return data.status === "failed" || reason
    ? `refused by the provider: ${reason ?? "it reported the transcription failed"}`
    : null;
}

// A verified ElevenLabs webhook body, applied to the job it names. A transcript completes it; a
// reported failure sends it again (an attempt); on anything else reconcile fetches the transcript
// by its id.
function applyWebhook(db: Db, body: string, onCompleted: OnCompleted) {
  const { data, match, payload, type } = readWebhook(body);
  if (!(data && (match.jobId || match.requestId))) {
    return ignore(db, payload, type);
  }
  const failed = failureOf(data);
  const result =
    isTranscript(data.transcription) && !failed
      ? complete(db, match, data.transcription, onCompleted)
      : noTranscript(db, match, failed);
  record(db, "elevenlabs.webhook", {
    job: match.jobId,
    requestId: match.requestId ?? null,
    result,
    status: data.status ?? null,
    type,
  });
  return { jobId: match.jobId, result };
}

// A webhook body: what it says, and the job and send it names.
function readWebhook(body: string) {
  const payload = safeJson(body);
  const event = WebhookEvent.safeParse(payload).data;
  const data = event?.data ?? null;
  return {
    data,
    match: {
      ...webhookMetadata(data?.webhook_metadata),
      requestId: data?.request_id ?? undefined,
    },
    payload,
    type: event?.type ?? null,
  };
}

// A send ElevenLabs may have taken without giving an id to ask by waits this long for its webhook.
const UNANSWERED_MS = 24 * 3600 * 1000;
// A block at the speech service is done well within this (its answer, a wait for a Scribe slot,
// then Scribe's for the routed turns); still submitted after it, a restart cut it off.
const SPEECH_CUT_OFF_MS = 10 * 60 * 1000;
// A block heard at the speech service waits at most this for a Scribe slot, so reconcile never takes
// a live waiter for one cut off: the service's answer, this wait and Scribe's fit in the cut-off.
export const SLOT_WAIT_MS =
  SPEECH_CUT_OFF_MS - SPEECH_TIMEOUT_MS - QUICK_TIMEOUT_MS - 60_000;

// What the 5-minute tick settles about one submitted job, without buying anything: "applied" when
// its transcript came, "retried" or "failed" when it left submitted, null while it waits.
// - With a transcription id, it is fetched. One ElevenLabs doesn't know LOST_AFTER_MS after it was
//   sent was lost there (it bills only the transcripts it makes: Oct 13, 3 lost jobs, 44 min,
//   absent from its usage) and goes again.
// - Without one (a send cut off by a restart, a 5xx, a timeout, a 202 without ids), ElevenLabs may
//   have it, and only its webhook can say: it is never sent again. A day without a webhook fails
//   it, marked maybe billed; a webhook after that still completes it. A host without a webhook
//   waits the same day, though nothing will answer.
// - At the speech service, one cut off goes again unless Scribe may have billed its routed turns.
async function settle(
  db: Db,
  config: Config,
  job: Job,
  onCompleted: OnCompleted
) {
  const age = clock().getTime() - (job.requestSentAt?.getTime() ?? 0);
  if (job.transcriber === "speech") {
    return settleSpeech(db, job, age);
  }
  if (!job.providerTranscriptionId) {
    if (age <= UNANSWERED_MS) {
      return null;
    }
    return onSend(db, job, {
      error:
        "no answer from ElevenLabs in a day: it may have billed it, so it is not sent again",
      maybeBilled: true,
      state: "failed",
    })
      ? "failed"
      : null;
  }
  const raw = await fetchTranscript(config, job.providerTranscriptionId);
  if (raw === "not_found") {
    return age > LOST_AFTER_MS
      ? retry(db, job, "lost by the provider: no transcript and no callback")
      : null;
  }
  return raw ? complete(db, { jobId: job.id }, raw, onCompleted) : null;
}

function settleSpeech(db: Db, job: Job, age: number) {
  if (age <= SPEECH_CUT_OFF_MS) {
    return null;
  }
  return job.maybeBilled
    ? fail(
        db,
        job,
        "cut off while Scribe heard its Thai turns: it may have billed them, so it is not sent again"
      ) && ("failed" as const)
    : back(db, job, "cut off at the speech service") && ("retried" as const);
}

async function reconcile(db: Db, config: Config, onCompleted: OnCompleted) {
  const pending = db
    .select()
    .from(jobs)
    .where(eq(jobs.state, "submitted"))
    .all();
  // ponytail: all pending jobs fetched at once; fine for one owner's backlog.
  const outcomes = await Promise.all(
    pending.map((job) =>
      settle(db, config, job, onCompleted).catch((error: unknown) => {
        reportError(db, "reconcile", error);
        return null;
      })
    )
  );
  const result = {
    checked: pending.length,
    completed: outcomes.filter((o) => o === "applied").length,
    failed: outcomes.filter((o) => o === "failed").length,
    retried: outcomes.filter((o) => o === "retried").length,
  };
  if (result.completed + result.failed + result.retried > 0) {
    record(db, "elevenlabs.reconcile", result);
  }
  return result;
}

interface Credits {
  checkedAt: string;
  limit: number;
  used: number;
}

// What ElevenLabs answered a send.
function answered(
  db: Db,
  send: Job,
  outcome: SubmitOutcome,
  onCompleted: OnCompleted
) {
  const jobId = send.id;
  switch (outcome.kind) {
    case "accepted":
      // The ids reconcile and the webhook find it by.
      onSend(db, send, {
        providerRequestId: outcome.requestId,
        providerTranscriptionId: outcome.transcriptionId,
      });
      return;
    case "completed":
      complete(db, { jobId }, outcome.raw, onCompleted);
      return;
    case "later":
      // Not taken, so not billed.
      back(db, send, outcome.error);
      return;
    case "refused":
      // Audio the provider can't read never becomes readable. It is kept as a gap, a transcript
      // with no words and nothing billed.
      if (outcome.error.includes("invalid_audio")) {
        complete(db, { jobId }, NO_WORDS, onCompleted);
        db.update(jobs)
          .set({
            billableSeconds: 0,
            error: `kept as a gap: ${outcome.error}`,
          })
          .where(eq(jobs.id, jobId))
          .run();
        return;
      }
      fail(db, send, outcome.error);
      return;
    default:
      // ElevenLabs may have it: it stays submitted, for its webhook (`settle`).
      onSend(db, send, { error: outcome.error, maybeBilled: true });
  }
}

// Who transcribes the next blocks: the speech service when switched to it and set up, else Scribe.
const transcriberNow = (config: Config) =>
  switches().transcriber === "speech" && speechServiceSet(config)
    ? ("speech" as const)
    : ("scribe" as const);

// Under 20 % of the plan left is "low"; the owner hears of it, and of "out", at most this often.
const CREDITS_LOW_SHARE = 0.2;
const CREDITS_ALERT_EVERY_MS = 12 * 3600 * 1000;
const CREDITS_EMAIL = {
  low: "ElevenLabs credits are under 20 %",
  out: "ElevenLabs credits are used up: what needs Scribe waits",
} as const;
const levelOf = (plan: Credits | null) => {
  if (!plan) {
    return "ok" as const;
  }
  if (plan.used >= plan.limit) {
    return "out" as const;
  }
  return plan.limit - plan.used < plan.limit * CREDITS_LOW_SHARE
    ? ("low" as const)
    : ("ok" as const);
};

// The one sender. `work()` first closes the blocks that are due (cutter.ts `cut`), then sends queued jobs
// whose next attempt is due, oldest first, each read from the bucket: to Scribe while it has a slot
// (scribe-slots.ts, shared with every other Scribe send), to the speech service one at a time. A stored fragment, the phone's timeline, a webhook, every state the Mac sends,
// the switch turned back on, the 5-minute tick and the time the next block may close start it
// (`poke`); a call while it runs makes it go round once more.
// Nothing is sent while transcription is switched off. Credits used up, nothing goes to ElevenLabs
// (it would answer 202 and never transcribe): Scribe's jobs wait queued, and the speech service's
// blocks still go, those needing Scribe then waiting for the credits.
// ponytail: in-process loop, one process: each claim is a synchronous transaction, so two never
// count the room or take a job at once.
export function jobWorker(
  db: Db,
  config: Config,
  audio: AudioStore,
  // Its vouched mark: the live socket's view first, else the stored row.
  mac: Pick<MacSocket, "vouchedThrough"> = macSocket(db),
  now = () => clock().getTime()
) {
  let wake: ReturnType<typeof setTimeout> | undefined;
  let plan: Credits | null = null;
  // Scribe takes sends while its credits last.
  const mayScribe = () => levelOf(plan) !== "out";
  // Set once by services.ts; nothing follows in tests that build a worker alone.
  let onCompleted: OnCompleted = () => Promise.resolve();
  const completed: OnCompleted = (job) => onCompleted(job);
  const alerted: Partial<Record<"low" | "out", number>> = {};
  const slots = scribeSlots(config.ELEVENLABS_SLOTS, () => atScribe(db));

  // A Scribe slot for the send `key`, or why there is none: none came within `waitMs`, or at its grant
  // transcription is off, the credits are used up or `excluded` says why not (each checked again then,
  // after the wait). The caller sends, then releases it.
  async function scribeSlot(
    key: string,
    {
      excluded = () => null,
      ...wait
    }: {
      excluded?: () => string | null;
      priority: Priority;
      signal?: AbortSignal;
      waitMs: number;
    }
  ): Promise<Release | string> {
    const release = await slots.wait(key, wait);
    if (!release) {
      return wait.signal?.aborted ? "canceled" : "no Scribe slot came in time";
    }
    let why: string | null = "transcription is switched off";
    if (switches().transcription) {
      why = mayScribe() ? excluded() : "ElevenLabs credits are used up";
    }
    if (why) {
      release();
      return why;
    }
    return release;
  }

  // A slot for a job heard at the speech service; none, the job is queued again. A quiet range that
  // came while it was heard sends it back too, and the next claim withdraws it.
  const jobSlot = async (job: Job) => {
    const slot = await scribeSlot(job.id, {
      excluded: () =>
        job.map && touchesQuiet(db, job.map)
          ? "a quiet range touches it"
          : null,
      priority: "ordinary",
      waitMs: SLOT_WAIT_MS,
    });
    if (typeof slot === "string") {
      back(db, job, `not sent to Scribe: ${slot}`);
    }
    return slot;
  };

  // Queued jobs move to submitted, as many as there is room for; requestSentAt is set as they
  // leave, so a send cut off by a restart is known (reconcile). The one way to ElevenLabs, so its
  // gate is the last word: still queued, ending where the Mac vouches, and no quiet range touching
  // it. The cutter checks the same before a job exists, on purpose: there a late range withdraws
  // one fragment; here it withdraws the whole job, which a range coming after its block closed
  // (the phone's playback) still needs. The speech service takes one block at a time, so it gets one
  // and no Scribe slot; a Scribe job's claim is its slot, held from here until ElevenLabs answers.
  const claim = () => {
    const vouched = mac.vouchedThrough();
    const at = clock();
    const transcriber = transcriberNow(config);
    const room = transcriber === "speech" ? 1 : slots.room();
    if (room <= 0) {
      return { claimed: [], quiet: [] };
    }
    return db.transaction((tx) => {
      const due = tx
        .select({ id: jobs.id, map: jobs.map })
        .from(jobs)
        .where(
          and(
            eq(jobs.state, "queued"),
            // Jobs from before the bucket have no audio to send.
            sql`${jobs.objectKey} is not null`,
            or(isNull(jobs.captureEnd), lte(jobs.captureEnd, vouched)),
            or(isNull(jobs.nextAttemptAt), lte(jobs.nextAttemptAt, at))
          )
        )
        .orderBy(jobs.createdAt)
        .limit(room)
        .all();
      const quiet = due
        .filter((job) => job.map && touchesQuiet(tx, job.map))
        .map((job) => job.id);
      const go = due.filter((j) => !quiet.includes(j.id)).map((j) => j.id);
      const claimed =
        go.length > 0
          ? tx
              .update(jobs)
              .set({ requestSentAt: at, state: "submitted", transcriber })
              .where(and(inArray(jobs.id, go), eq(jobs.state, "queued")))
              .returning()
              .all()
          : [];
      logChange(
        tx,
        "job",
        claimed.map((j) => j.id)
      );
      return { claimed, quiet };
    });
  };

  async function send(job: Job) {
    let bytes: Uint8Array | null;
    try {
      bytes = job.objectKey ? await audio.get(job.objectKey) : null;
    } catch (error) {
      back(db, job, `the bucket is unreachable: ${String(error)}`);
      return;
    }
    if (!bytes) {
      fail(db, job, "its audio is not in the bucket");
      return;
    }
    if (job.transcriber === "speech") {
      await hear(job, bytes);
      return;
    }
    await toScribe(job, bytes);
  }

  async function toScribe(job: Job, bytes: Uint8Array) {
    const started = performance.now();
    const outcome = await submit(config, job, new Blob([bytes.slice()]));
    record(db, `elevenlabs.${outcome.kind}`, {
      job: job.id,
      ms: Math.round(performance.now() - started),
      ...("error" in outcome ? { error: outcome.error.slice(0, 120) } : {}),
      ...(outcome.kind === "accepted" ? { requestId: outcome.requestId } : {}),
    });
    answered(db, job, outcome, completed);
  }

  // A block through the speech service: its words, and Scribe's for the turns it routes, cut from
  // the block's own audio and sent once, without a webhook; a block mostly Thai goes to Scribe
  // whole, as a Scribe job. Routed by the zone the owner was in when it was recorded. The service busy: queued again. Down or failing: an attempt, and a block
  // it fails the last time goes to Scribe whole too, so a failure that repeats never loops.
  async function hear(job: Job, bytes: Uint8Array) {
    const started = performance.now();
    const said = await transcribeBlock(config, bytes);
    if (putBack(job, said)) {
      return;
    }
    const zone = ownerZoneAt(db, job.captureStart ?? undefined);
    const route =
      "heard" in said
        ? routeTurns(said.heard, barOf(zone))
        : { kind: "whole" as const };
    record(db, "speech.heard", {
      bar: barOf(zone),
      job: job.id,
      ms: Math.round(performance.now() - started),
      route: route.kind,
      routed: route.kind === "turns" ? route.routed.length : null,
      zone,
    });
    if (waitForCredits(job, route)) {
      return;
    }
    if (route.kind === "whole" || !("heard" in said)) {
      await wholeToScribe(job, bytes);
      return;
    }
    const routed = await hearRouted(
      { config, db },
      bytes,
      said.heard,
      route.routed,
      {
        // A send that may be billed leaves, only while it is still this send: from here it is never
        // sent again (`settle`).
        claim: () => onSend(db, job, { maybeBilled: true }),
        keyterms: job.settings.keyterms,
        ref: { job: job.id },
        slot: () => jobSlot(job),
      }
    );
    if (!routed || routed.kind === "unsent") {
      return;
    }
    if (routed.kind === "later") {
      onSend(db, job, { maybeBilled: false });
      back(db, job, routed.error);
      return;
    }
    complete(db, { jobId: job.id }, routed.transcript, completed);
    db.update(jobs)
      .set({
        billableSeconds: routed.billableSeconds,
        error: routed.error,
        maybeBilled: routed.maybeBilled,
      })
      .where(eq(jobs.id, job.id))
      .run();
  }

  // A block the speech service leaves to Scribe whole, once it has a slot, and only while it is still
  // this send: a moved job is never bought again. Scribe gets its own attempts; the slot passes to the
  // Scribe job by its id.
  async function wholeToScribe(job: Job, bytes: Uint8Array) {
    const slot = await jobSlot(job);
    if (typeof slot === "string") {
      return;
    }
    const scribe = { attempts: 0, transcriber: "scribe" as const };
    try {
      if (onSend(db, job, scribe)) {
        await toScribe({ ...job, ...scribe }, bytes);
      }
    } finally {
      slot();
    }
  }

  // Credits used up, a block that needs Scribe waits for them. True when it went back.
  function waitForCredits(job: Job, route: Route) {
    if (mayScribe() || (route.kind === "turns" && route.routed.length === 0)) {
      return false;
    }
    onSend(db, job, {
      error: "waits for ElevenLabs credits",
      nextAttemptAt: UNTIL_CREDITS,
      requestSentAt: null,
      state: "queued",
    });
    return true;
  }

  // The speech service busy: queued again; down with attempts left: an attempt. True when the job
  // went back.
  function putBack(
    job: Job,
    said: Awaited<ReturnType<typeof transcribeBlock>>
  ) {
    if (!("error" in said)) {
      return false;
    }
    if (said.error === "identity_busy") {
      back(db, job, "the speech service is busy");
      return true;
    }
    if (
      said.error === "identity_unavailable" &&
      job.attempts + 1 < MAX_ATTEMPTS
    ) {
      retry(db, job, `the speech service: ${said.message.slice(0, 200)}`);
      return true;
    }
    return false;
  }

  // Credits used up, sends stop only while Scribe transcribes; the speech service still hears every
  // block. What waits for the credits, for the feed's reason: every block then, else the blocks
  // waiting for them.
  const scribeTranscribes = () => transcriberNow(config) === "scribe";
  const sendable = () =>
    switches().transcription &&
    !(levelOf(plan) === "out" && scribeTranscribes());

  // The blocks that are due close first, and the worker wakes when the next may; a failure there
  // (the bucket down) is logged and never holds back a send.
  async function closeDue() {
    try {
      const at = await cut(db, audio, mac.vouchedThrough(), now());
      clearTimeout(wake);
      if (at !== null) {
        wake = setTimeout(poke, at - now());
        wake.unref();
      }
    } catch (error) {
      reportError(db, "cutter", error);
    }
  }

  const work = singleFlight(async () => {
    await closeDue();
    while (sendable()) {
      const { claimed, quiet } = claim();
      if (claimed.length + quiet.length === 0) {
        break;
      }
      // biome-ignore lint/performance/noAwaitInLoops: each round fills the room the last one left
      await Promise.all([
        ...quiet.map((id) => withdrawJob(db, audio, id)),
        ...claimed.map((job) =>
          send(job).catch((error: unknown) => reportError(db, "send", error))
        ),
      ]);
    }
  });
  // `work` for a caller that doesn't wait; a failure is logged.
  const poke = () => {
    work().catch((error: unknown) => reportError(db, "job worker", error));
  };

  // Reads the plan's credits; the owner gets an email when they fall under 20 % and when they
  // run out, at most once per 12 h each.
  async function checkCredits() {
    const read = await credits(config);
    if (!read) {
      return;
    }
    const before = levelOf(plan);
    plan = { ...read, checkedAt: new Date(now()).toISOString() };
    const level = levelOf(plan);
    if (level !== "out") {
      // The blocks waiting for credits go now (after a restart too).
      const due = db
        .update(jobs)
        .set({ error: null, nextAttemptAt: null })
        .where(waitsForCredits())
        .returning({ id: jobs.id })
        .all();
      logChange(
        db,
        "job",
        due.map((j) => j.id)
      );
    }
    if (level === before) {
      return;
    }
    record(db, "elevenlabs.quota", { level, ...read });
    if (
      level === "ok" ||
      now() - (alerted[level] ?? Number.NEGATIVE_INFINITY) <
        CREDITS_ALERT_EVERY_MS
    ) {
      return;
    }
    alerted[level] = now();
    const status = await emailOwner(config, {
      key: `credits-${level}-${Math.floor(now() / CREDITS_ALERT_EVERY_MS)}`,
      subject: `Lifelog: ${CREDITS_EMAIL[level]}`,
      text: `ElevenLabs: ${read.used} of ${read.limit} credits used. Used up, nothing goes to ElevenLabs until the plan is upgraded or renews: blocks the Mac transcribes alone still complete, the rest wait queued; nothing is lost.`,
    });
    record(db, "elevenlabs.quota_alert", { level, status });
  }

  return {
    checkCredits,
    // The plan's credits as last read; null until read.
    credits: () => plan,
    // Credits used up while Scribe transcribes: every block waits (the feed's reason). With the
    // speech service, a conversation says so only for its blocks waiting for credits.
    creditsOut: () => levelOf(plan) === "out" && scribeTranscribes(),
    // What follows every stored transcript (services.ts).
    onCompleted(then: OnCompleted) {
      onCompleted = then;
    },
    poke,
    // A Scribe slot for a send outside the jobs (a chat voice note's, routes/voice-notes.ts).
    scribeSlot,
    // Every 5 minutes: the credits, what reconcile settles, then whatever can go.
    tick: async () => {
      await checkCredits();
      const result = await reconcile(db, config, completed);
      slots.wake();
      await work();
      return result;
    },
    // A verified ElevenLabs webhook; it ended a transcription there, or queued a job again, so
    // whatever can go goes.
    webhook(body: string) {
      const applied = applyWebhook(db, body, completed);
      slots.wake();
      poke();
      return applied;
    },
    work,
  };
}

export type JobWorker = ReturnType<typeof jobWorker>;
