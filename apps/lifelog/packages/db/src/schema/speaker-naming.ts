import { sql } from "drizzle-orm";
import {
  integer,
  primaryKey,
  real,
  sqliteTable,
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
import { transcripts } from "./transcription";

// ---- Speakers and people ----------------------------------------------------
//
// A transcript speaker label ("speaker_0") is assigned to a person, to unknown, a stranger, or to an
// unnamed candidate cluster. Only owner actions add voice evidence;
// recognition reconciles voice matches and validated inferred names.

export const speakerStatuses = [
  "person",
  "unknown",
  "candidate",
  "media",
  // Recognized only: sounds like the voices he answered "Not anyone I know" for (people.ts).
  "stranger",
] as const;
export const assignmentSources = ["recognized", "inferred", "owner"] as const;

// Names from the owner or confident linked Life identities; creation is not voice evidence.
export const people = sqliteTable("people", {
  // Other names the owner uses for them ("Mamie", "Jojo"): set on their page or by a merge, never
  // learned from what the summaries heard.
  aliases: json<string[]>("aliases")
    .notNull()
    .$defaultFn(() => []),
  createdAt,
  creationSource: text("creation_source", { enum: ["owner", "inferred"] })
    .notNull()
    .default("owner"),
  id: uuid("id").primaryKey().$defaultFn(newId),
  // The owner himself: his turns are what "talks with the owner" counts against.
  isOwner: boolean("is_owner").notNull().default(false),
  lifeRef: text("life_ref").unique(),
  name: text("name").notNull(),
  // Current name authority, independent of who first created the row.
  nameSource: text("name_source", { enum: ["owner", "inferred"] })
    .notNull()
    .default("owner"),
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
    inference: json<SpeakerInference>("inference"),
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

// The model's support for this exact scope; none of it is voice-profile evidence.
export interface SpeakerInference {
  attemptId: string;
  confidence: number;
  evidence: { jobId: string; quote: string; turnIndex: number }[];
  inputHash: string;
  snapshotRevision: number;
}

export interface LifePerson {
  aliases: string[];
  name: string;
  personId: string | null;
  ref: string;
}

// Complete authenticated replacement, never an incremental deletion list.
export const lifePeopleSnapshot = sqliteTable("life_people_snapshot", {
  folds: json<Record<string, string>>("folds").notNull(),
  hash: text("hash").notNull(),
  id: integer("id").primaryKey().default(1),
  people: json<LifePerson[]>("people").notNull(),
  revision: integer("revision").notNull(),
  updatedAt,
});

// One resumable input, with retries on that same input counted rather than re-enqueued.
export const namingAttempts = sqliteTable(
  "naming_attempts",
  {
    attempts: integer("attempts").notNull().default(0),
    call: json("call"),
    conversationId: uuid("conversation_id").notNull(),
    createdAt,
    engine: text("engine", { enum: ["codex"] })
      .notNull()
      .default("codex"),
    error: text("error"),
    id: uuid("id").primaryKey().$defaultFn(newId),
    inputHash: text("input_hash").notNull(),
    model: text("model").notNull(),
    nextEligibleAt: instant("next_eligible_at"),
    policyHash: text("policy_hash").notNull(),
    promptHash: text("prompt_hash").notNull(),
    result: json("result"),
    snapshotRevision: integer("snapshot_revision").notNull(),
    state: text("state", {
      enum: ["queued", "running", "failed", "abstained", "named"],
    })
      .notNull()
      .default("queued"),
    updatedAt,
  },
  (t) => [unique("naming_attempts_input").on(t.conversationId, t.inputHash)]
);

// Approval is bound to the measured policy, model and prompt; absence never authorizes writes.
export const namingRollout = sqliteTable(
  "naming_rollout",
  {
    createdAt,
    gate: json("gate"),
    inputTokens: integer("input_tokens").notNull().default(0),
    latencyMs: integer("latency_ms").notNull().default(0),
    longWindow: json("long_window"),
    model: text("model").notNull(),
    outputTokens: integer("output_tokens").notNull().default(0),
    pilotCalls: integer("pilot_calls").notNull().default(0),
    pilotPassed: boolean("pilot_passed").notNull().default(false),
    policyHash: text("policy_hash").notNull(),
    promptHash: text("prompt_hash").notNull(),
    shortWindow: json("short_window"),
    updatedAt,
  },
  (t) => [primaryKey({ columns: [t.model, t.promptHash, t.policyHash] })]
);
