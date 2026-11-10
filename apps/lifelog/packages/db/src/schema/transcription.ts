import { clock } from "@life/server/src/core/clock";
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import {
  boolean,
  createdAt,
  instant,
  json,
  newId,
  updatedAt,
  uuid,
} from "./columns";

// Pendant pages: [[first, last], …] inclusive, sorted, touching ones joined. Admission never buys a
// page a job or fragment already holds, failed or not (cutter.ts `holderOf`, under the one writer).
export type PageRanges = [number, number][];
// Sorted ranges with touching ones joined.
export const joinTouching = (pages: PageRanges) =>
  pages.reduce<PageRanges>((joined, [first, last]) => {
    const previous = joined.at(-1);
    if (previous && first === previous[1] + 1) {
      previous[1] = last;
    } else {
      joined.push([first, last]);
    }
    return joined;
  }, []);
const pageRanges = (name: string) => json<PageRanges>(name);
// The first and last page `pages` holds, derived (never written): the paid-once guard
// (cutter.ts `holderOf`) seeks by them instead of reading a source's whole history.
const pageBounds = () => ({
  firstPage: integer("first_page").generatedAlwaysAs(sql`pages ->> '$[0][0]'`, {
    mode: "virtual",
  }),
  lastPage: integer("last_page").generatedAlwaysAs(sql`pages ->> '$[#-1][1]'`, {
    mode: "virtual",
  }),
});

// Rebuild (docs/sync.md).
export const conversationKinds = [
  "conversation",
  "dictation",
  "silent",
  "imported",
] as const;
export const waitingReasons = [
  "macAway",
  "creditsOut",
  "transcriptionOff",
  "phoneQuiet",
] as const;
// Where a conversation stands (conversation-state.ts); the phone adds only "Not uploaded yet".
export const conversationStates = [
  "uploaded",
  "transcribing",
  "transcribed",
  "summarized",
  "failed",
] as const;
export type ConversationState = (typeof conversationStates)[number];
export const ownerEditKinds = [
  "split",
  "merge",
  "undo",
  "dismissSplit",
] as const;
export const editSources = ["owner", "ai"] as const;

// Transcription job lifecycle (jobs.ts). Shared with the client through the OpenAPI document.
//   queued      admitted, waiting for the worker (or its next attempt not due yet)
//   submitted   sent to ElevenLabs or the speech service (requestSentAt), waiting for its transcript
//   completed   transcript stored
//   failed      never sent again: the audio was refused or left the bucket, or a send that may
//               have been billed went unanswered for a day. Its pages stay its own.
export const jobStates = [
  "queued",
  "submitted",
  "completed",
  "failed",
] as const;
export type JobState = (typeof jobStates)[number];
// Named, never `not in` the others: `in` seeks the state index, `not in` reads every job.
export const unfinishedJobStates = ["queued", "submitted"] as const;

// Who transcribes a block: ElevenLabs Scribe whole, or the speech service with Scribe for the turns
// it routes (route-turns.ts). The owner's switch picks it; a job keeps the one it was sent with.
export const transcribers = ["scribe", "speech"] as const;
export type Transcriber = (typeof transcribers)[number];

export interface TranscriptionSettings {
  keyterms: string[];
  languageCode: string | null;
  numSpeakers: number | null;
}

export interface Word {
  end: number;
  logprob: number | null;
  // What came before this word in the provider text: " ", "" (Thai), or more.
  spacing: string;
  speakerId: string | null;
  start: number;
  text: string;
}

export interface Turn {
  end: number;
  speakerId: string | null;
  start: number;
  text: string;
}

export interface ParsedTranscript {
  languageCode: string;
  languageProbability: number;
  turns: Turn[];
  words: Word[];
}

// The ledger. Usage is computed from it (state <> 'failed'), by admittedAt.
export const transcriptionJobs = sqliteTable(
  "transcription_jobs",
  {
    admittedAt: instant("admitted_at").notNull().$defaultFn(clock),
    // Sends that bought nothing and went again (the backoff, and which send a webhook answers).
    attempts: integer("attempts").notNull().default(0),
    audioSha256: text("audio_sha256").notNull(),
    billableSeconds: real("billable_seconds").notNull(),
    // The capture range of the job's map, so a time finds its jobs. Its end is the job's last
    // instant of speech, where latency starts (`latency`).
    captureEnd: instant("capture_end"),
    captureStart: instant("capture_start"),
    completedAt: instant("completed_at"),
    createdAt,
    // True: the cutter closed its block after 30 s with no kept speech (cutter.ts rule 3), so
    // nothing said follows it closely. False: the cap or a pause closed it, whatever followed.
    // Null on jobs from before 22 Oct 2026 and imports.
    endedOnSilence: boolean("ended_on_silence"),
    error: text("error"),
    id: uuid("id").primaryKey().$defaultFn(newId),
    // How a position in the prepared audio maps back to capture time (turns.ts): a block's own,
    // an older job's copied from the conversations that cited it; null when none did.
    map: json("map").$type<JobMap>(),
    // A send the provider may have taken and billed without telling us (was `uncertain`).
    maybeBilled: boolean("maybe_billed").notNull().default(false),
    nextAttemptAt: instant("next_attempt_at"),
    // The audio in the bucket (audio-store.ts), stored before the job was admitted; null for
    // jobs from before it, until their audio is sent again.
    objectKey: text("object_key"),
    // The Pendant pages its audio was rendered from (null for jobs from before blocks).
    pages: pageRanges("pages"),
    ...pageBounds(),
    preparedDurationSeconds: real("prepared_duration_seconds").notNull(),
    providerRequestId: text("provider_request_id").unique(),
    providerTranscriptionId: text("provider_transcription_id"),
    // Set immediately before the provider call: unset means the request never left.
    requestSentAt: instant("request_sent_at"),
    settings: json("settings").$type<TranscriptionSettings>().notNull(),
    settingsHash: text("settings_hash").notNull(),
    sourceId: text("source_id"),
    state: text("state", { enum: jobStates }).notNull().default("queued"),
    transcriber: text("transcriber", { enum: transcribers })
      .notNull()
      .default("scribe"),
    updatedAt,
  },
  (t) => [
    // One job per (audio, settings): paid work happens once (and per page, `cutter.ts` `holderOf`).
    uniqueIndex("transcription_jobs_identity").on(
      t.audioSha256,
      t.settingsHash
    ),
    index("transcription_jobs_state").on(t.state),
    // A source's jobs from a capture time on (page-processing.ts, the pages a window holds).
    index("transcription_jobs_source_end").on(t.sourceId, t.captureEnd),
    index("transcription_jobs_source_last").on(t.sourceId, t.lastPage),
  ]
);

// The raw backup in the bucket (backup.ts, rebuild P7): each pack once, by content, and the phone's
// last source.sqlite snapshots (name = their UTC date). Nothing reads these but a restore. Beside
// them, one row for the latest restic snapshot (restic.ts), its columns read differently: `key`
// `restic/<snapshot id>`, `sha256` the snapshot id, `name` the Mac's local date it was taken,
// `bytes` what it added to the repository, `sourceId` "server", `createdAt` when it was taken.
export const backupFiles = sqliteTable(
  "backup_files",
  {
    bytes: integer("bytes").notNull(),
    createdAt,
    key: text("key").primaryKey(),
    kind: text("kind", {
      enum: ["pack", "source_db", "archive", "restic"],
    }).notNull(),
    name: text("name").notNull(),
    sha256: text("sha256").notNull(),
    sourceId: text("source_id").notNull(),
  },
  (t) => [index("backup_files_source").on(t.sourceId, t.kind)]
);

// A job's kept capture intervals in prepared order ([start, end) epoch milliseconds) and the
// silence between them: the client's TimeMap (docs/formats.md), read by `captureMillis`.
export interface JobMap {
  segments: [number, number][];
  separatorMs: number;
  // Where each interval begins in the prepared audio (ms, maybe fractional), when the audio was
  // joined from fragments (audio.ts); absent, each starts one separator after the one before.
  starts?: number[];
}

// A speech fragment (docs/timeline.md, "Fragments and blocks"): the kept speech of a run of whole
// Pendant pages, as the phone rendered it, in the bucket until the server closes its block
// (cutter.ts). A page is in one fragment (`holderOf`), a fragment in one job. Its audio may hold
// dictation the Mac hasn't reported yet: it is never read before its block passed the Mac's gate
// and the quiet ranges, and leaves the bucket once its job is admitted or it is withdrawn.
export const speechFragments = sqliteTable(
  "speech_fragments",
  {
    audioSha256: text("audio_sha256").notNull(),
    // `captureRange` of its map, so a conversation finds its fragments (`touchesJob`).
    captureEnd: instant("capture_end").notNull(),
    captureStart: instant("capture_start").notNull(),
    createdAt,
    id: uuid("id").primaryKey().$defaultFn(newId),
    // The job its block became.
    jobId: uuid("job_id").references(() => transcriptionJobs.id),
    map: json("map").$type<JobMap>().notNull(),
    // Its audio in the bucket while its block is open; null once in a job, or covered: audio bought
    // already, or from before the quiet ranges, no job and no audio, its pages held.
    objectKey: text("object_key"),
    pages: pageRanges("pages").notNull(),
    ...pageBounds(),
    sourceId: text("source_id").notNull(),
  },
  (t) => [
    index("speech_fragments_open")
      .on(t.sourceId, t.captureStart)
      .where(sql`${t.objectKey} is not null`),
    // A source's fragments from a capture time on (page-processing.ts `heldIn`).
    index("speech_fragments_source_end").on(t.sourceId, t.captureEnd),
    index("speech_fragments_source_last").on(t.sourceId, t.lastPage),
  ]
);

export const transcripts = sqliteTable("transcripts", {
  createdAt,
  // When the server finished cutting this job's clean turns (excerpts.ts); null until then.
  excerptsAt: instant("excerpts_at"),
  excerptsAttemptedAt: instant("excerpts_attempted_at"), // Failed attempts yield to the rest of the queue.
  jobId: uuid("job_id")
    .primaryKey()
    .references(() => transcriptionJobs.id),
  languageCode: text("language_code").notNull(),
  parsed: json("parsed").$type<ParsedTranscript>().notNull(),
  // Bump when parseTranscript changes so stored rows can be re-parsed from raw.
  parserVersion: integer("parser_version").notNull(),
  raw: json("raw").notNull(),
  // When Scribe's words of the whole block replaced the speech service's, turn by turn: the owner's
  // one-off of 29 Oct 2026 (docs/decisions.md), its step since removed; null otherwise.
  scribeWordsAt: instant("scribe_words_at"),
});

// A transcript turn in capture time, rebuilt from `transcripts.parsed` and the job's map
// (turns.ts): a cache, one row per turn, indexed as the owner's assignments index them.
// A conversation shows the turns that start inside its range.
export interface TurnWord {
  // Capture instants (epoch milliseconds).
  end: number;
  spacing: string;
  start: number;
  text: string;
}

export const turns = sqliteTable(
  "turns",
  {
    endAt: instant("end_at").notNull(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => transcriptionJobs.id, { onDelete: "cascade" }),
    language: text("language").notNull(),
    speakerLabel: text("speaker_label"),
    startAt: instant("start_at").notNull(),
    text: text("text").notNull(),
    turnIndex: integer("turn_index").notNull(),
    words: json("words").$type<TurnWord[]>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.jobId, t.turnIndex] }),
    index("turns_start_at").on(t.startAt),
  ]
);
