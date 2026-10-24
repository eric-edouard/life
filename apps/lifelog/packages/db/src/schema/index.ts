import { randomUUID } from "node:crypto";
import { isNull, type SQLWrapper, sql } from "drizzle-orm";
import {
  customType,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  sqliteView,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// SQLite, one file, one writer (docs/architecture.md). Instants are epoch milliseconds (Date in
// code), ids text uuids, JSON text read and written by Drizzle, booleans 0 and 1.
const instant = (name: string) => integer(name, { mode: "timestamp_ms" });
const boolean = (name: string) => integer(name, { mode: "boolean" });
const json = <T = unknown>(name: string) =>
  text(name, { mode: "json" }).$type<T>();
const uuid = (name: string) => text(name);
const newId = () => randomUUID();
const now = () => new Date();

// An embedding as little-endian float32 bytes: scored in JS (search.ts), never by the database.
export const float32 = (bytes: Uint8Array) =>
  new Float32Array(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  );
const vector = customType<{ data: number[]; driverData: Uint8Array }>({
  dataType: () => "blob",
  fromDriver: (bytes) => Array.from(float32(bytes)),
  toDriver: (values) => new Uint8Array(new Float32Array(values).buffer),
});

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
  "aiOff",
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

const createdAt = instant("created_at").notNull().$defaultFn(now);

const updatedAt = instant("updated_at")
  .notNull()
  .$defaultFn(now)
  .$onUpdate(now);

// The ledger. Usage is computed from it (state <> 'failed'), by admittedAt.
export const transcriptionJobs = sqliteTable(
  "transcription_jobs",
  {
    admittedAt: instant("admitted_at").notNull().$defaultFn(now),
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
  // When the server cut this job's clean turns from its bucket audio and embedded them (excerpts.ts);
  // null until then, and always for a job without bucket audio.
  excerptsAt: instant("excerpts_at"),
  jobId: uuid("job_id")
    .primaryKey()
    .references(() => transcriptionJobs.id),
  languageCode: text("language_code").notNull(),
  parsed: json("parsed").$type<ParsedTranscript>().notNull(),
  // Bump when parseTranscript changes so stored rows can be re-parsed from raw.
  parserVersion: integer("parser_version").notNull(),
  raw: json("raw").notNull(),
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

// ---- Speakers and people ----------------------------------------------------
//
// A transcript speaker label ("speaker_0") is assigned to a person, to unknown, or to an
// unnamed candidate cluster. Only owner actions create people or add voice evidence;
// recognition only writes assignments with source "recognized".

export const speakerStatuses = [
  "person",
  "unknown",
  "candidate",
  "media",
] as const;
export const assignmentSources = ["recognized", "owner"] as const;

// Named by the owner only.
export const people = sqliteTable("people", {
  // Other names the owner uses for them ("Mamie", "Jojo"): set on their page, or learned when
  // he answers a voice the summaries heard by that name (naming-queue.ts `answerVoices`).
  aliases: json<string[]>("aliases")
    .notNull()
    .$defaultFn(() => []),
  createdAt,
  id: uuid("id").primaryKey().$defaultFn(newId),
  // The owner himself: his turns are what "talks with the owner" counts against.
  isOwner: boolean("is_owner").notNull().default(false),
  name: text("name").notNull(),
  // A rename reaches search through this.
  updatedAt,
});

// One embedding per clean transcript turn, cut by the server from the job's bucket audio, or by
// the phone before the rebuild. The audio itself is never stored. Not evidence for anyone
// until an owner action says so.
export const voiceSamples = sqliteTable(
  "voice_samples",
  {
    conversationId: uuid("conversation_id").notNull(),
    createdAt,
    durationSeconds: real("duration_seconds").notNull(),
    embedding: json("embedding").$type<number[]>().notNull(),
    id: uuid("id").primaryKey().$defaultFn(newId),
    jobId: uuid("job_id")
      .notNull()
      .references(() => transcripts.jobId),
    modelId: text("model_id").notNull(),
    modelRevision: text("model_revision").notNull(),
    speakerLabel: text("speaker_label").notNull(),
    turnIndex: integer("turn_index").notNull(),
  },
  (t) => [unique("voice_samples_turn").on(t.jobId, t.turnIndex)]
);

// A person's voice profile: samples the owner attributed to them. A sample is evidence
// for at most one person. Deleting rows here never touches transcripts or samples.
export const voiceProfiles = sqliteTable("voice_profiles", {
  createdAt,
  id: uuid("id").primaryKey().$defaultFn(newId),
  personId: uuid("person_id")
    .notNull()
    .references(() => people.id),
  sampleId: uuid("sample_id")
    .notNull()
    .unique()
    .references(() => voiceSamples.id),
});

// Who a speaker label is, per transcript. turnIndex is null for the whole label, or set
// for an owner correction of a single turn. Recognition never overwrites owner rows.
export const speakerAssignments = sqliteTable(
  "speaker_assignments",
  {
    candidateId: uuid("candidate_id"),
    // The owner's "several people": who, and someone unknown too (speakers.ts `decide`).
    candidates: json("candidates").$type<{
      people: string[];
      unknown: boolean;
    }>(),
    id: uuid("id").primaryKey().$defaultFn(newId),
    jobId: uuid("job_id")
      .notNull()
      .references(() => transcripts.jobId),
    margin: real("margin"),
    // "Several people" before `candidates`: waits in the queue as it is; dropped once none is left.
    mixed: boolean("mixed").notNull().default(false),
    personId: uuid("person_id").references(() => people.id),
    score: real("score"),
    source: text("source", { enum: assignmentSources }).notNull(),
    speakerLabel: text("speaker_label").notNull(),
    status: text("status", { enum: speakerStatuses }).notNull(),
    turnIndex: integer("turn_index"),
    updatedAt,
  },
  (t) => [
    // One row per scope, the whole label (no turn) included.
    uniqueIndex("speaker_assignments_scope").on(
      t.jobId,
      t.speakerLabel,
      sql`coalesce(${t.turnIndex}, -1)`
    ),
  ]
);

// A card of the voices to name (naming-queue.ts): a group of unnamed voices that talked with the
// owner, with the name the summaries heard for it. Its id is the group's: the unnamed group
// recognition keeps, or its one voice's id (`voiceId`, job/label).
export const suggestionKinds = [
  "new_person",
  "known_person",
  "several",
] as const;
export type Candidates = NonNullable<
  (typeof speakerAssignments.$inferSelect)["candidates"]
>;
export interface Suggestion {
  conversations: number;
  // Turns where its name was said, cut short.
  evidence: { at: string | null; conversationId: string; text: string }[];
  // Turns it traded with the owner (one each way).
  exchanges: number;
  id: string;
  // known_person: the summaries think it is `personId`.
  kind: (typeof suggestionKinds)[number];
  name: string | null;
  personId: string | null;
  seconds: number;
  voices: {
    conversationId: string;
    jobId: string;
    speakerLabel: string;
  }[];
}

// ---- Conversations, intelligence and places ---------------------------------

// Made by grouping (grouping.ts) from the phone's timeline facts and the words, or handed over
// once by the phone at the cutover (Oct 14); the id follows the anchor rule. Its words are the turns that
// start inside its range (transcript.ts). The owner's title is edited anywhere and the latest edit
// wins (titles.ts). Generated titles live on runs.
export const conversations = sqliteTable("conversations", {
  captureEndedAt: instant("capture_ended_at").notNull(),
  captureStartedAt: instant("capture_started_at").notNull(),
  // Set once its end is 5 minutes behind the source's heard-through; after that only an edit or
  // late audio that touches it changes it.
  closedAt: instant("closed_at"),
  createdAt,
  id: uuid("id").primaryKey(),
  kind: text("kind", { enum: conversationKinds })
    .notNull()
    .default("conversation"),
  ownerTitle: text("owner_title"),
  // When the owner's title was last set or cleared; null before it was kept.
  ownerTitleAt: instant("owner_title_at"),
  // Merged or undone away (grouping), or left out of the phone's live set at the handover. The
  // row and its runs stay, as the spending ledger; everything that reads the archive skips it.
  retiredAt: instant("retired_at"),
  // The source grouping made it from, or the Pendant's for one handed over; null for an imported
  // recording, which stays as handed over (the phone plays its own file, by this id).
  sourceId: text("source_id"),
  // Where it stands, and why it waits (conversation-state.ts), logged when either changes.
  state: text("state", { enum: conversationStates })
    .notNull()
    .default("transcribed"),
  // The live conversation that now covers its anchor (or else its range).
  successorId: uuid("successor_id"),
  // What its last finished roll read: its turn keys and whether it was open (summaries.ts). A
  // summary is due when its words differ from it; null: never read, or the owner's Generate.
  turnsFp: text("turns_fp"),
  updatedAt,
  waitingReason: text("waiting_reason", { enum: waitingReasons }),
  waitingSince: instant("waiting_since"),
});

export const live = isNull(conversations.retiredAt);

// Grouping is done with it: closed, or one grouping doesn't hold (imported, or from before
// sources). The one rule, for a row and, in SQL, for a conversation `c` by alias.
export const isSettled = (c: {
  closedAt: Date | null;
  kind: string;
  sourceId: string | null;
}) => c.closedAt !== null || c.sourceId === null || c.kind === "imported";
export const settled = (c = "c") =>
  sql.raw(
    `(${c}.closed_at is not null or ${c}.source_id is null or ${c}.kind = 'imported')`
  );

// How a conversation `c` relates to the rest, in raw SQL by alias. Two rules, for two questions:
// - its words are the turns `t` that start inside [start, end): each turn in exactly one live
//   conversation, so every reader shows a word once (`holdsTurn`);
// - a job `j` touches it when its capture range overlaps: a job not transcribed yet has no turns,
//   and its state still says what the conversation waits for (`touchesJob`).
export const holdsTurn = (c = "c", t = "t") =>
  sql.raw(
    `${t}.start_at >= ${c}.capture_started_at and ${t}.start_at < ${c}.capture_ended_at`
  );
// Whether a row of `table` holds any of `pages` (inclusive [first, last] ranges, sorted, as
// stored). Its page bounds come first, so an index on (source_id, last_page) seeks the rows that
// can: never a source's whole history.
export const holdsPages = (table: string, pages: PageRanges) => {
  const t = sql.raw(table);
  const first = pages[0]?.[0] ?? 0;
  const last = pages.at(-1)?.[1] ?? 0;
  return sql`${t}.last_page >= ${first} and ${t}.first_page <= ${last}
    and exists (select 1 from json_each(${t}.pages) r, json_each(${JSON.stringify(pages)}) w
    where r.value ->> 0 <= w.value ->> 1 and r.value ->> 1 >= w.value ->> 0)`;
};
export const touchesJob = (c = "c", j = "j") =>
  sql.raw(
    `${j}.capture_start < ${c}.capture_ended_at and ${j}.capture_end > ${c}.capture_started_at`
  );

// ElevenLabs credits used up, a block the speech service heard that needs Scribe waits for them:
// queued, never due, until a read of the credits finds them back (apps/server jobs.ts). The rule over
// a jobs table or alias, for the worker, the status and the conversations' waiting reasons.
export const UNTIL_CREDITS = new Date(8_640_000_000_000_000);
export const waitsForCredits = (j = "transcription_jobs") =>
  sql.raw(
    `${j}.state = 'queued' and ${j}.next_attempt_at = ${UNTIL_CREDITS.getTime()}`
  );

// The jobs each live conversation holds: those with a turn starting inside its range
// (`holdsTurn`). A job over a boundary is in both.
export const conversationJobs = sqliteView("conversation_jobs", {
  conversationId: uuid("conversation_id").notNull(),
  jobId: uuid("job_id").notNull(),
}).as(sql`
  select distinct c.id as conversation_id, t.job_id
  from conversations c
  join turns t on ${holdsTurn()}
  where c.retired_at is null`);

// A stretch the owner spent dictating to the Mac (FluidVoice, macOS dictation, an AI app), posted by the
// Mac helper (apps/mac-quiet) already padded. The phone leaves it out of the audio it sends, and
// words already bought inside it are hidden wherever transcripts are read. Never edited; the
// helper's own id makes a retried post a no-op.
export const quietRanges = sqliteTable(
  "quiet_ranges",
  {
    createdAt,
    endedAt: instant("ended_at").notNull(),
    id: uuid("id").primaryKey(),
    // The dictating app's bundle id.
    source: text("source").notNull(),
    startedAt: instant("started_at").notNull(),
  },
  (t) => [
    index("quiet_ranges_created_at").on(t.createdAt),
    index("quiet_ranges_started_at").on(t.startedAt),
  ]
);

// What the Mac helper said, one row (mac-socket.ts): when the server last heard it, and the
// dictation rules' state its events left (dictation.ts). Every dictation before the watermark
// (quiet-ranges.ts `macView`, derived) is among the quiet ranges. The phone sends audio only once
// the Mac vouched for it.
export interface Dictation {
  asleep: boolean;
  // An event from the Mac was refused (invalid, or not stored), or the cutover from protocol 1 left a hold:
  // nothing from here on is vouched for until the next event applies (quiet-ranges.ts).
  blockedSince: number | null;
  // Finished, and waiting MERGE_GAP_MS for the next dictation to join it.
  finished: { end: number; source: string; start: number } | null;
  // Sleep or the stuck-flag rule cut a dictation: the flag is ignored until it goes off.
  interrupted: boolean;
  // An event refused as invalid was dropped from here: whatever it was (a dictation's start, maybe),
  // the span to the next event applied becomes a quiet range of unknown source (`unblocked`).
  lostFrom: number | null;
  open: { source: string; start: number } | null;
}

export const macWatch = sqliteTable("mac_watch", {
  // When the server last heard from the helper, in server time.
  heardAt: instant("heard_at").notNull(),
  id: integer("id").primaryKey().default(1),
  // The helper's last event applied, with its time as the Mac sent it: one with a seq no greater is
  // a resend, acked and not applied, unless it was sent later (quiet-ranges.ts `applyMacEvent`).
  lastAt: instant("last_at"),
  lastSeq: integer("last_seq").notNull().default(0),
  state: json<Dictation>("state")
    .notNull()
    .default(
      sql`'{"asleep":false,"blockedSince":null,"finished":null,"interrupted":false,"lostFrom":null,"open":null}'`
    ),
});

// The owner's two switches, one row (switches.ts). Transcription: audio to ElevenLabs and voices to
// apps/identity. AI: summaries on the Mac and search embeddings. Off, that work waits. No row: both on.
export const macEngines = ["claude", "codex"] as const;
export type MacEngine = (typeof macEngines)[number];
// Two latest observations, not a usage history. Only the Mac's authenticated socket writes these.
export const subscriptionUsage = sqliteTable("subscription_usage", {
  engine: text("engine", { enum: macEngines }).primaryKey(),
  reading: json("reading").notNull(),
});

export const processingSwitches = sqliteTable("processing_switches", {
  ai: boolean("ai").notNull(),
  engine: text("engine", { enum: macEngines }).notNull().default("claude"),
  id: integer("id").primaryKey().default(1),
  // Minutes the Pendant's audio may wait on the phone before the server asks the owner to open
  // the app (latency.ts); 0 is off. Its default is `switches.ts` DEFAULTS.
  openAppAfterMinutes: integer("open_app_after_minutes").notNull(),
  transcriber: text("transcriber", { enum: transcribers })
    .notNull()
    .default("scribe"),
  transcription: boolean("transcription").notNull(),
  updatedAt: instant("updated_at").notNull().$defaultFn(now),
});

// Intelligence run lifecycle.
//   running  calls in flight on the Mac; a restart puts it back to waiting (index.ts)
//   valid    output stored and passed validation
//   invalid  output kept raw with its validation errors; a retry is explicit
//   failed   a call errored; whatever came back is kept; the next drain or request rolls again
//   waiting  for the Mac; it resumes where it stopped, its usable
//            answers kept in intelligence_calls
export const intelligenceStates = [
  "running",
  "valid",
  "invalid",
  "failed",
  "waiting",
] as const;
// claude-code and codex: the Mac helper runs the call on the owner's subscription. openai and
// anthropic are paid APIs, kept so old runs decode; nothing calls them any more.
export const intelligenceProviders = [
  "openai",
  "anthropic",
  "claude-code",
  "codex",
] as const;
export type IntelligenceProvider = (typeof intelligenceProviders)[number];

// What turn id N in a run means.
export interface TurnRef {
  capturedAt: string | null;
  jobId: string;
  turnIndex: number;
}

export interface RawCall {
  inputTokens: number;
  latencyMs: number;
  // Absent on historical calls; the run's provider and model describe those.
  model?: string;
  outputTokens: number;
  provider?: IntelligenceProvider;
  reasoningEffort?: string | null;
  stage: string;
  // Historical: why a paid API stopped early. Never set on the Mac.
  stopReason?: string | null;
  text: string;
  // The inclusive turn-id range this call read, when it read transcript text (prompt
  // version 4 on).
  turns?: [number, number];
}

export interface Coverage {
  // rolling for every run since Oct 14; whole, windowed and reused are older runs'.
  mode: "whole" | "windowed" | "reused" | "rolling";
  turnCount: number;
  // The tail one roll read (intelligence.ts `requestRoll`), none when it only carried the chapters
  // before; its other chapters came from the run before. Each chapter's call reads its own turns
  // again (RawCall.turns).
  windows: [number, number][];
}

// The ledger of paid text generation.
export const intelligenceRuns = sqliteTable(
  "intelligence_runs",
  {
    conversationId: uuid("conversation_id").notNull(),
    costUsd: real("cost_usd"),
    coverage: json("coverage").$type<Coverage>(),
    createdAt,
    error: text("error"),
    id: uuid("id").primaryKey().$defaultFn(newId),
    inputTokens: integer("input_tokens").notNull().default(0),
    latencyMs: integer("latency_ms"),
    model: text("model").notNull(),
    outputTokens: integer("output_tokens").notNull().default(0),
    promptVersion: integer("prompt_version").notNull(),
    provider: text("provider", { enum: intelligenceProviders }).notNull(),
    raw: json("raw")
      .$type<RawCall[]>()
      .notNull()
      .$defaultFn(() => []),
    reasoningEffort: text("reasoning_effort"),
    result: json("result"),
    state: text("state", { enum: intelligenceStates })
      .notNull()
      .default("running"),
    turns: json("turns").$type<TurnRef[]>().notNull(),
    updatedAt,
    validationErrors: json("validation_errors")
      .$type<string[]>()
      .notNull()
      .default([]),
  },
  (t) => [
    index("intelligence_runs_conversation").on(t.conversationId, t.createdAt),
    // At most one run in flight per conversation.
    uniqueIndex("intelligence_runs_one_running")
      .on(t.conversationId)
      .where(sql`state = 'running'`),
  ]
);

// Each usable answer of a run, as its raw call (intelligence.ts `execute`). A run cut off (the
// Mac gone, a deploy) resumes without asking those calls again. `key` hashes the call as sent,
// so a call whose input changed since is asked anew.
export const intelligenceCalls = sqliteTable(
  "intelligence_calls",
  {
    call: json("call").$type<RawCall>().notNull(),
    createdAt,
    key: text("key").notNull(),
    runId: uuid("run_id")
      .notNull()
      .references(() => intelligenceRuns.id, { onDelete: "cascade" }),
    stage: text("stage").notNull(),
  },
  (t) => [unique("intelligence_calls_once").on(t.runId, t.stage, t.key)]
);

// Where the phone was all day, not only during conversations: every fix it took, with Apple's
// name for the place when the phone has one, and every visit iOS reported (arrival and departure
// at a place it stayed). Read by `GET /where` and `GET /visits` (location.ts) and for
// conversations' places (places.ts). A visit's observedAt is its arrival, or its departure when
// iOS didn't see it arrive; its departedAt is null while the owner is still there.
export const locationSources = ["fix", "visit"] as const;
export const locationHistory = sqliteTable(
  "location_history",
  {
    accuracyM: real("accuracy_m").notNull(),
    arrivedAt: instant("arrived_at"),
    createdAt,
    departedAt: instant("departed_at"),
    id: uuid("id").primaryKey().$defaultFn(newId),
    latitude: real("latitude").notNull(),
    longitude: real("longitude").notNull(),
    observedAt: instant("observed_at").notNull(),
    // Apple's name for where a fix was taken (reverse-geocoded on the phone).
    placeName: text("place_name"),
    source: text("source", { enum: locationSources }).notNull(),
  },
  (t) => [unique("location_history_instant").on(t.observedAt, t.source)]
);

// Remote crash, error and health reporting (docs/providers.md). States, counts, call stacks and
// shortened error messages only: never audio, transcripts, names, places or coordinates.
// Kept 90 days after arrival.
export const diagnosticKinds = [
  "crash",
  "hang",
  "cpu_exception",
  "disk_write_exception",
  "metrics",
  "app_error",
  "server_error",
] as const;
const receivedAt = instant("received_at").notNull().$defaultFn(now);

// One MetricKit diagnostic, or one day of its metrics. The id is the phone's, so a retried
// upload is stored once. `body` is the validated upload; `signature` groups repeats.
export const diagnostics = sqliteTable(
  "diagnostics",
  {
    appBuild: text("app_build").notNull(),
    appVersion: text("app_version").notNull(),
    body: json("body").notNull(),
    id: uuid("id").primaryKey(),
    kind: text("kind", { enum: diagnosticKinds }).notNull(),
    receivedAt,
    signature: text("signature").notNull(),
  },
  (t) => [index("diagnostics_received_at").on(t.receivedAt)]
);

export const heartbeatReasons = [
  "periodic",
  "disconnect",
  "storage_incident",
  "write_failure",
  "recording",
] as const;

// The phone's capture health at one moment; the id is the phone's.
export const heartbeats = sqliteTable(
  "heartbeats",
  {
    body: json("body").notNull(),
    id: uuid("id").primaryKey(),
    observedAt: instant("observed_at").notNull(),
    reason: text("reason", { enum: heartbeatReasons }).notNull(),
    receivedAt,
  },
  (t) => [
    index("heartbeats_observed_at").on(t.observedAt),
    index("heartbeats_received_at").on(t.receivedAt),
  ]
);

// One step of a chain the owner relies on (events.ts): an external call the server made, a Mac
// socket state, or what the phone saw. Ids, states, counts and status codes only. Kept 14 days.
export const eventSources = ["server", "app"] as const;
export const events = sqliteTable(
  "events",
  {
    at: instant("at").notNull(),
    fields: json("fields").notNull(),
    id: uuid("id").primaryKey().$defaultFn(newId),
    name: text("name").notNull(),
    source: text("source", { enum: eventSources }).notNull(),
  },
  // Two events in one millisecond come back in insertion order: by rowid.
  (t) => [index("events_at").on(t.at)]
);

// The phone's push token, for silent pushes and alerts. One row, replaced when iOS rotates it.
export const alertPushToken = sqliteTable("alert_push_token", {
  id: integer("id").primaryKey().default(1),
  pushToken: text("push_token").notNull(),
  updatedAt,
});

// ---- Search -------------------------------------------------------------------
//
// Transcripts are cut into passages of about 30 to 60 s of turns and embedded, so search
// can match by meaning. Derived data, rebuilt from transcripts, speaker assignments, people
// and the time map whenever those change (search.ts).

export const EMBEDDING_DIMENSIONS = 1536;

export const searchPassages = sqliteTable(
  "search_passages",
  {
    // Capture instants of the first turn's start and the last turn's end (null on old rows).
    capturedFrom: instant("captured_from"),
    capturedTo: instant("captured_to"),
    conversationId: uuid("conversation_id").notNull(),
    createdAt,
    embedding: vector("embedding").notNull(),
    firstTurn: integer("first_turn").notNull(),
    id: uuid("id").primaryKey().$defaultFn(newId),
    // Its job: a passage never spans two.
    jobId: uuid("job_id").notNull(),
    languageCode: text("language_code").notNull(),
    lastTurn: integer("last_turn").notNull(),
    model: text("model").notNull(),
    // People the owner named among its speakers.
    personIds: json<string[]>("person_ids").notNull(),
    speakers: json<string[]>("speakers").notNull(),
    // "Speaker: words" lines: what is embedded and what keyword matching reads.
    text: text("text").notNull(),
    // sha256 of model and text: an unchanged passage keeps its embedding.
    textHash: text("text_hash").notNull(),
  },
  (t) => [
    index("search_passages_conversation").on(t.conversationId),
    index("search_passages_captured_from").on(t.capturedFrom),
    // Keyword candidates come from the FTS5 trigram table `search_text` (baseline migration).
  ]
);

// When each conversation was last indexed, with which model, and the change log seq it read
// through. A change that touches it deletes the row, so it is indexed again (search.ts).
export const searchIndex = sqliteTable("search_index", {
  conversationId: uuid("conversation_id").primaryKey(),
  indexedAt: instant("indexed_at").notNull(),
  model: text("model").notNull(),
  seq: integer("seq"),
});

// One row per paid embedding request, written when it answers. Only for spending figures.
export const embeddingPurposes = ["index", "query"] as const;
export const embeddingCalls = sqliteTable(
  "embedding_calls",
  {
    // Null for a model without a known price.
    costUsd: real("cost_usd"),
    createdAt,
    id: uuid("id").primaryKey().$defaultFn(newId),
    model: text("model").notNull(),
    purpose: text("purpose", { enum: embeddingPurposes }).notNull(),
    tokens: integer("tokens").notNull(),
  },
  (t) => [index("embedding_calls_created_at").on(t.createdAt)]
);

// One row per press transcribed at once (POST /quick-transcriptions), written once ElevenLabs answered or might
// have billed it: what it cost, for spending. Neither its audio nor its text is kept.
export const quickTranscriptions = sqliteTable(
  "quick_transcriptions",
  {
    // At the base Scribe rate, keyterms included, as `transcription_jobs.billable_seconds`.
    billableSeconds: real("billable_seconds").notNull(),
    createdAt,
    durationSeconds: real("duration_seconds").notNull(),
    id: uuid("id").primaryKey().$defaultFn(newId),
  },
  (t) => [index("quick_transcriptions_created_at").on(t.createdAt)]
);

// One stream of audio: a Pendant (its store's deviceID) or an old-app recording (`import:<id>`).
export const sources = sqliteTable("sources", {
  createdAt,
  // What changed since the last regroup, as one capture range: set with the change, cleared by the
  // regroup that covered it, so a regroup that failed runs again on the tick (grouping.ts).
  dirtyFrom: instant("dirty_from"),
  dirtyTo: instant("dirty_to"),
  // When the cutover (Oct 14) handed this source over; null before. `alreadyBought` (cutter.ts)
  // reads it so old audio is never bought twice.
  handedOverAt: instant("handed_over_at"),
  // The capture time of the phone's durable, analyzed, contiguous page prefix; only moves forward.
  heardThrough: instant("heard_through"),
  id: text("id").primaryKey(),
  // A raw-page source's first page not cut into fragments yet (page-processing.ts); null for the
  // iPhone's sources, whose phone keeps its own cursor.
  pagesCutFrom: integer("pages_cut_from"),
  // Every kept second before it is in a fragment the server holds; equal to heard-through when
  // nothing waits (cutter.ts). One writer per source: the iPhone's timeline (PUT
  // /sources/{id}/timeline) for its sources, the server's page processing for raw-page sources;
  // heard-through likewise.
  sentThrough: instant("sent_through"),
  updatedAt,
});

// A raw page as the phone stored it (pages.ts, docs/sync.md "Raw pages from a thin phone"): a
// thin phone's durable copy, byte for byte. Its bytes are `length` bytes at `offset` in the batch
// object the phone sent it in. An index keeps its first bytes: other bytes there are refused (409).
// Labeled and cut into speech fragments by page-processing.ts.
export const rawPages = sqliteTable(
  "raw_pages",
  {
    codec: text("codec", { enum: ["limitless", "omi"] }).notNull(),
    // In a labeled piece (`page_pieces`) or read with no audio (page-processing.ts). An unlabeled
    // page below a labeled one came late, and is labeled on its own.
    labeled: boolean("labeled").notNull().default(false),
    length: integer("length").notNull(),
    objectKey: text("object_key").notNull(),
    offset: integer("offset").notNull(),
    // The phone's store index: its flash life's band (`FlashLife`, 2^40 each) plus the device's.
    pageIndex: integer("page_index").notNull(),
    receivedAt: instant("received_at").notNull().$defaultFn(now),
    sha256: text("sha256").notNull(),
    sourceId: text("source_id").notNull(),
    // The phone's placement in capture time; null for an Omi record, placed from its own stamp.
    startAt: instant("start_at"),
  },
  (t) => [
    primaryKey({ columns: [t.sourceId, t.pageIndex] }),
    // The pages labeled or not, by index: the next to label, late ones, and the highest labeled
    // (a max read off its end).
    index("raw_pages_labeled").on(t.sourceId, t.labeled, t.pageIndex),
    // When a source last sent pages (page-processing.ts, heard-through).
    index("raw_pages_received").on(t.sourceId, t.receivedAt),
    // `hasRawPages`: whether a source has pages of a processed codec.
    index("raw_pages_codec").on(t.sourceId, t.codec),
  ]
);

// The codecs whose pages the server labels and cuts (page-labels.ts). A source of another codec
// (Limitless, until its decoder is ported) stays its phone's: nothing here writes it.
export const PROCESSED_CODECS = ["omi"] as const;
// A source whose raw pages the server processes: it labels and cuts them, and writes its
// heard-through and sent-through. The one page-source predicate; `id` names the source,
// `sources.id` by default.
export const hasRawPages = (id: SQLWrapper = sources.id) =>
  sql`exists (select 1 from raw_pages p where p.source_id = ${id} and p.codec in (${sql.join(
    PROCESSED_CODECS.map((c) => sql`${c}`),
    sql`, `
  )}))`;

// A labeled stretch of a raw-page source (page-processing.ts), the server's playback sidecar: whole
// pages of one capture span, at most about 10 minutes, and the speech Silero heard in it. Its
// pages play from `startAt` back to back as their stamps say (`page-rules.ts` `placeOmi`).
export const pagePieces = sqliteTable(
  "page_pieces",
  {
    // Where the energy detector heard sound (`EnergyDetector`, -50 dB a second), epoch ms.
    audible: json("audible").$type<[number, number][]>().notNull().default([]),
    // Why its span starts apart from the one before (`BreakReason`); empty when it goes on from
    // the piece before, or begins the source. A piece that begins a span carries them.
    breaks: json("breaks").$type<string[]>().notNull().default([]),
    endAt: instant("end_at").notNull(),
    firstPage: integer("first_page").notNull(),
    lastPage: integer("last_page").notNull(),
    sourceId: text("source_id").notNull(),
    // Its timeline span, by the span's first page: set when the piece is made (the piece it goes on
    // from, or its own first page for a new span or a late batch), never derived from breaks.
    spanFirst: integer("span_first").notNull(),
    speech: json("speech").$type<[number, number][]>().notNull(),
    startAt: instant("start_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sourceId, t.firstPage] }),
    // The pieces from a page on, and those near a time: windows read the archive's end.
    index("page_pieces_last").on(t.sourceId, t.lastPage),
    index("page_pieces_end").on(t.sourceId, t.endAt),
    index("page_pieces_span").on(t.sourceId, t.spanFirst),
  ]
);

// A source that is a Pendant, not an old-app recording (`import:<id>`).
export const isPendant = sql`${sources.id} not like 'import:%'`;

// What the phone knows of a run of pages, for grouping: speech, audible and unanalyzed intervals,
// breaks and pauses, in capture time. A clock change sends the span again and replaces it.
export const timelineSpans = sqliteTable(
  "timeline_spans",
  {
    endAt: instant("end_at").notNull(),
    facts: json("facts").$type<TimelineFacts>().notNull(),
    firstPage: integer("first_page").notNull(),
    sourceId: text("source_id").notNull(),
    startAt: instant("start_at").notNull(),
    updatedAt,
  },
  (t) => [
    primaryKey({ columns: [t.sourceId, t.firstPage] }),
    index("timeline_spans_start_at").on(t.startAt),
  ]
);

export interface TimelineFacts {
  audible: [string, string][];
  breaks: { at: string; kind: string }[];
  pauses: { at: string }[];
  speech: [string, string][];
  unanalyzed: [string, string][];
}

// Grouping edits from the owner (or the AI's confident splits), by client uuid so a replay is a
// no-op. Grouping applies them in edited order; an undone one is skipped.
export const ownerEdits = sqliteTable("owner_edits", {
  at: instant("at"),
  createdAt,
  editedAt: instant("edited_at").notNull(),
  // merge: the range it joins.
  from: instant("from"),
  id: uuid("id").primaryKey(),
  kind: text("kind", { enum: ownerEditKinds }).notNull(),
  source: text("source", { enum: editSources }).notNull().default("owner"),
  // undo: the edit it undoes.
  target: uuid("target"),
  to: instant("to"),
  undoneAt: instant("undone_at"),
});

// A chapter of a conversation, summarized as soon as it closes (rolling chapters).
export const chapters = sqliteTable(
  "chapters",
  {
    conversationId: uuid("conversation_id").notNull(),
    endAt: instant("end_at").notNull(),
    id: uuid("id").primaryKey().$defaultFn(newId),
    runId: uuid("run_id"),
    startAt: instant("start_at").notNull(),
    summarizedAt: instant("summarized_at"),
    // As the run wrote it, speaker tokens ({S2}) included; the feed renders it when read.
    summary: text("summary"),
    title: text("title"),
    updatedAt,
  },
  (t) => [index("chapters_conversation").on(t.conversationId)]
);

// Words the owner wants spelled right; sent to the provider as keyterms.
export const vocabulary = sqliteTable("vocabulary", {
  createdAt,
  term: text("term").primaryKey(),
});

// Every change the feed carries, in commit order; GET /changes reads it by `seq`. Written in the
// same transaction as the change (change-log.ts `logChange`).
export const changeLog = sqliteTable(
  "change_log",
  {
    at: instant("at").notNull().$defaultFn(now),
    kind: text("kind").notNull(),
    ref: text("ref").notNull(),
    seq: integer("seq").primaryKey({ autoIncrement: true }),
  },
  (t) => [index("change_log_kind_ref").on(t.kind, t.ref)]
);
