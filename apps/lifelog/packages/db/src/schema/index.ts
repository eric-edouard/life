import { clock } from "@life/server/src/core/clock";
import { bytesOf, vectorOf } from "@life/server/src/core/embedder";
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

import {
  boolean,
  createdAt,
  instant,
  json,
  newId,
  updatedAt,
  uuid,
} from "./columns";
import {
  conversationKinds,
  conversationStates,
  editSources,
  ownerEditKinds,
  type PageRanges,
  transcribers,
  waitingReasons,
} from "./transcription";

// biome-ignore lint/performance/noBarrelFile: preserve the public database schema entrypoint.
export * from "./speaker-naming";
export * from "./transcription";

// A vector as Life's core stores it: scored in JS (search.ts), never by the database.
const vector = customType<{ data: number[]; driverData: Uint8Array }>({
  dataType: () => "blob",
  fromDriver: (bytes) => Array.from(vectorOf(bytes)),
  toDriver: bytesOf,
});

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
// apps/identity. AI: summaries on the Mac. Off, that work waits. No row: both on.
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
  updatedAt: instant("updated_at").notNull().$defaultFn(clock),
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
const receivedAt = instant("received_at").notNull().$defaultFn(clock);

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
    receivedAt: instant("received_at").notNull().$defaultFn(clock),
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
    at: instant("at").notNull().$defaultFn(clock),
    kind: text("kind").notNull(),
    ref: text("ref").notNull(),
    seq: integer("seq").primaryKey({ autoIncrement: true }),
  },
  (t) => [index("change_log_kind_ref").on(t.kind, t.ref)]
);
