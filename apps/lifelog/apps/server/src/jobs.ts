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
} from "@lifelog/db/schema";
import { and, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core";
import type { z } from "zod";

import type { AudioStore } from "./audio-store";
import { logChange } from "./change-log";
import { type Config, singleFlight } from "./config";
import { cut, touchesQuiet, withdrawJob } from "./cutter";
import { ownerZoneAt, reportError } from "./diagnostics";
import {
  failureReason,
  fetchTranscript,
  isTranscript,
  PARSER_VERSION,
  parseTranscript,
  type SubmitOutcome,
  safeJson,
  submit,
  WebhookEvent,
  webhookMetadata,
} from "./elevenlabs";
import { record } from "./events";
import { markDirty, regroupAfterCommit } from "./grouping";
import { hearRouted } from "./hear-routed";
import { back, fail, MAX_ATTEMPTS, onSend, retry } from "./job-sends";
import { type MacSocket, macSocket } from "./mac-socket";
import { barOf, type Route, routeTurns } from "./route-turns";
import { creditsWatch } from "./scribe-credits";
import {
  atScribe,
  LOST_AFTER_MS,
  type Priority,
  scribeSlots,
} from "./scribe-slots";
import { speechServiceSet, transcribeBlock } from "./speech-service";
import { switches } from "./switches";
import { rebuildTurnsIn } from "./turns";

export type Job = typeof jobs.$inferSelect;

export const getJob = (db: Db, id: string) =>
  db.query.transcriptionJobs.findFirst({ where: eq(jobs.id, id) }).sync();

interface ProviderMatch {
  jobId?: string | null;
  requestId?: string | undefined;
  // The send the webhook answers: its POST's instant, absent before 20 Nov 2026.
  sentAt?: number | null;
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
// attempt; one of an earlier send (its POST is not the job's) changes nothing, so a late
// failure never sends again a job already back at ElevenLabs. One from before 20 Nov names no POST:
// it counts only under the job's current request id; in doubt it changes nothing, and reconcile
// settles the job. A send that may have been billed is never sent again: its failure fails it.
function noTranscript(db: Db, match: ProviderMatch, failed: string | null) {
  const job = findJob(db, match);
  if (!job) {
    return "unknown_job";
  }
  if (!failed) {
    return "kept";
  }
  const current =
    typeof match.sentAt === "number"
      ? match.sentAt === job.requestSentAt?.getTime()
      : Boolean(match.requestId) && match.requestId === job.providerRequestId;
  if (!current) {
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
// A block at the speech service is done well within this from its claim (its audio read, its
// answer, a wait for a Scribe slot), and its routed turns within this from their POST; still
// submitted after it, a restart cut it off.
const SPEECH_CUT_OFF_MS = 10 * 60 * 1000;
// A block heard there stops waiting for a Scribe slot this long before that, so reconcile never takes
// a live wait for a send cut off.
const SLOT_WAIT_MARGIN_MS = 60 * 1000;

// What the 5-minute tick settles about one submitted job, without buying anything: "applied" when
// its transcript came, "retried" or "failed" when it left submitted, null while it waits.
// - With a transcription id, it is fetched. One ElevenLabs doesn't know LOST_AFTER_MS after it was
//   sent was lost there (it bills only the transcripts it makes: Oct 13, 3 lost jobs, 44 min,
//   absent from its usage) and goes again. One sent before 20 Nov has no POST clock to say so
//   (marked maybe billed by the migration `legacy_scribe_sends`): it waits the day below instead.
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
  const unanswered = () =>
    age > UNANSWERED_MS &&
    onSend(db, job, {
      error:
        "no answer from ElevenLabs in a day: it may have billed it, so it is not sent again",
      maybeBilled: true,
      state: "failed",
    })
      ? ("failed" as const)
      : null;
  if (!job.providerTranscriptionId) {
    return unanswered();
  }
  const raw = await fetchTranscript(config, job.providerTranscriptionId);
  if (raw === "not_found") {
    if (job.maybeBilled) {
      return unanswered();
    }
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

// `settled` runs after each job it settles, so a slot it frees is granted at once.
async function reconcile(
  db: Db,
  config: Config,
  onCompleted: OnCompleted,
  settled: () => void
) {
  const pending = db
    .select()
    .from(jobs)
    .where(eq(jobs.state, "submitted"))
    .all();
  // ponytail: all pending jobs fetched at once; fine for one owner's backlog.
  const outcomes = await Promise.all(
    pending.map((job) =>
      settle(db, config, job, onCompleted)
        .then((outcome) => {
          if (outcome) {
            settled();
          }
          return outcome;
        })
        .catch((error: unknown) => {
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

// The one sender. `work()` first closes the blocks that are due (cutter.ts `cut`), then sends queued jobs
// whose next attempt is due, oldest first, each read from the bucket: to Scribe while it has a slot
// (scribe-slots.ts, shared with every other Scribe send), to the speech service one at a time. A stored fragment, the phone's timeline, a webhook, a freed Scribe slot, every state the Mac sends,
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
  const plan = creditsWatch(db, config, now);
  // Scribe takes sends while its credits last.
  const mayScribe = () => plan.level() !== "out";
  // Set once by services.ts; nothing follows in tests that build a worker alone.
  let onCompleted: OnCompleted = () => Promise.resolve();
  const completed: OnCompleted = (job) => onCompleted(job);
  // A slot that frees (a send's end, a settled job, dictation done) sends what is queued.
  const slots = scribeSlots(
    config.ELEVENLABS_SLOTS,
    () => atScribe(db),
    () => poke()
  );

  // Every paid send of the server (and of dictation): `slots.send`, with the switch and the credits
  // checked again once it holds its slot, before the caller's own claim (`claimSend`).
  const paidSend = <T>(
    key: string,
    until: { priority: Priority; signal?: AbortSignal; waitMs: number },
    claimSend: () => string | null,
    post: () => Promise<T>
  ) =>
    slots.send(
      key,
      until,
      () => {
        if (!switches().transcription) {
          return "transcription is switched off";
        }
        return mayScribe() ? claimSend() : "ElevenLabs credits are used up";
      },
      post
    );

  // How long a job may wait for its slot: a block heard at the speech service, what is left of its
  // time since its claim (reconcile never takes a live wait for a send cut off); a queued job picked
  // for Scribe, none (it was picked for a free slot, and is picked again once one frees).
  const slotWaitOf = (job: Job) =>
    job.requestSentAt
      ? Math.max(
          0,
          job.requestSentAt.getTime() +
            SPEECH_CUT_OFF_MS -
            SLOT_WAIT_MARGIN_MS -
            clock().getTime()
        )
      : 0;

  // A job's send to Scribe leaves now, holding its slot: still the job that was read and no quiet range
  // touching it, its row records the POST (`requestSentAt`, which reconcile's clocks run from), with
  // `set`. The send to use from here, or why not.
  function dispatch(job: Job, set: SQLiteUpdateSetSource<typeof jobs>) {
    if (job.map && touchesQuiet(db, job.map)) {
      return "a quiet range touches it";
    }
    const sent = {
      ...job,
      requestSentAt: clock(),
      state: "submitted" as const,
    };
    return onSend(db, job, {
      ...set,
      requestSentAt: sent.requestSentAt,
      state: "submitted",
    })
      ? sent
      : "it moved on";
  }

  // Queued jobs due to go, as many as there is room for, oldest first. The speech service takes one
  // block at a time and no Scribe slot: it is claimed here, `requestSentAt` its claim, so a send cut
  // off by a restart is known (reconcile). One for Scribe stays queued until its audio is read and it
  // holds its slot (`toScribe`). Each is still queued, ends where the Mac vouches and has no quiet
  // range touching it: the cutter checks the same before a job exists, on purpose: there a late range
  // withdraws one fragment; here it withdraws the whole job, which a range coming after its block
  // closed (the phone's playback) still needs.
  const claim = () => {
    const vouched = mac.vouchedThrough();
    const at = clock();
    const transcriber = transcriberNow(config);
    const room = transcriber === "speech" ? 1 : slots.room();
    if (room <= 0) {
      return { picked: [], quiet: [], transcriber };
    }
    return db.transaction((tx) => {
      const due = tx
        .select()
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
      const go = due.filter((j) => !quiet.includes(j.id));
      if (transcriber === "scribe" || go.length === 0) {
        return { picked: go, quiet, transcriber };
      }
      const claimed = tx
        .update(jobs)
        .set({ requestSentAt: at, state: "submitted", transcriber })
        .where(
          and(
            inArray(
              jobs.id,
              go.map((j) => j.id)
            ),
            eq(jobs.state, "queued")
          )
        )
        .returning()
        .all();
      logChange(
        tx,
        "job",
        claimed.map((j) => j.id)
      );
      return { picked: claimed, quiet, transcriber };
    });
  };

  async function send(job: Job, transcriber: Job["transcriber"]) {
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
    // Checked again once read: a quiet range that came meanwhile keeps it from the speech service
    // too, and a switched transcriber sends it the new way (a queued job is left for the next claim).
    let why: string | null = null;
    if (job.map && touchesQuiet(db, job.map)) {
      why = "a quiet range touches it";
    } else if (transcriberNow(config) !== transcriber) {
      why = "the transcriber changed";
    }
    if (why) {
      if (job.state === "submitted") {
        back(db, job, why);
      }
      return;
    }
    if (transcriber === "speech") {
      await hear(job, bytes);
      return;
    }
    await toScribe(job, bytes);
  }

  // A block to Scribe whole, through the one paid path, as a Scribe job; its attempts go on from the
  // speech service's, so a block never gets more than MAX_ATTEMPTS sends. Not sent, a block heard
  // there is queued again (not an attempt); a queued one is left as it is.
  async function toScribe(job: Job, bytes: Uint8Array) {
    let sent = job;
    const outcome = await paidSend(
      job.id,
      { priority: "ordinary", waitMs: slotWaitOf(job) },
      () => {
        const left = dispatch(job, { transcriber: "scribe" });
        if (typeof left === "string") {
          return left;
        }
        sent = { ...left, transcriber: "scribe" };
        return null;
      },
      () => submitWhole(sent, bytes)
    );
    if ("unsent" in outcome && job.state === "submitted") {
      back(db, job, `not sent to Scribe: ${outcome.unsent}`);
    }
  }

  async function submitWhole(job: Job, bytes: Uint8Array) {
    const started = performance.now();
    const outcome = await submit(config, job, new Blob([bytes.slice()]));
    record(db, `elevenlabs.${outcome.kind}`, {
      job: job.id,
      ms: Math.round(performance.now() - started),
      // A refusal's words are the provider's (its HTTP body): its kind says what happened.
      ...("error" in outcome ? { ok: false } : {}),
      ...(outcome.kind === "accepted" ? { requestId: outcome.requestId } : {}),
    });
    answered(db, job, outcome, completed);
    return outcome;
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
      await toScribe(job, bytes);
      return;
    }
    let sent = job;
    const routed = await hearRouted(
      { config, db },
      bytes,
      said.heard,
      route.routed,
      {
        keyterms: job.settings.keyterms,
        ref: { job: job.id },
        // A send that may be billed leaves, only while it is still this send: from here it is never
        // sent again (`settle`).
        send: (post) =>
          paidSend(
            job.id,
            { priority: "ordinary", waitMs: slotWaitOf(job) },
            () => {
              const left = dispatch(job, { maybeBilled: true });
              if (typeof left === "string") {
                return left;
              }
              sent = { ...left, maybeBilled: true };
              return null;
            },
            post
          ),
        settle: (outcome) => {
          if (outcome.kind === "later") {
            onSend(db, sent, { maybeBilled: false });
            back(db, sent, outcome.error);
            return;
          }
          complete(db, { jobId: job.id }, outcome.transcript, completed);
          db.update(jobs)
            .set({
              billableSeconds: outcome.billableSeconds,
              error: outcome.error,
              maybeBilled: outcome.maybeBilled,
            })
            .where(eq(jobs.id, job.id))
            .run();
        },
      }
    );
    if (routed.kind === "unsent") {
      back(db, job, `not sent to Scribe: ${routed.error}`);
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
    !(plan.level() === "out" && scribeTranscribes());

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
      const { picked, quiet, transcriber } = claim();
      if (picked.length + quiet.length === 0) {
        break;
      }
      // biome-ignore lint/performance/noAwaitInLoops: each round fills the room the last one left
      await Promise.all([
        ...quiet.map((id) => withdrawJob(db, audio, id)),
        ...picked.map((job) =>
          send(job, transcriber).catch((error: unknown) =>
            reportError(db, "send", error)
          )
        ),
      ]);
    }
  });
  // `work` for a caller that doesn't wait; a failure is logged.
  const poke = () => {
    work().catch((error: unknown) => reportError(db, "job worker", error));
  };

  return {
    checkCredits: plan.check,
    // The plan's credits as last read; null until read.
    credits: plan.read,
    // Credits used up while Scribe transcribes: every block waits (the feed's reason). With the
    // speech service, a conversation says so only for its blocks waiting for credits.
    creditsOut: () => plan.level() === "out" && scribeTranscribes(),
    // What follows every stored transcript (services.ts).
    onCompleted(then: OnCompleted) {
      onCompleted = then;
    },
    // A paid send outside the jobs (a chat voice note's, routes/voice-notes.ts; dictation's).
    paidSend,
    poke,
    // Every 5 minutes: the credits, what reconcile settles, then whatever can go.
    tick: async () => {
      await plan.check();
      const result = await reconcile(db, config, completed, slots.wake);
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
